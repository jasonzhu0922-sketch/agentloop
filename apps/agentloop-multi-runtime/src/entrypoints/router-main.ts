import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { SharedFilesystemAttachmentBroker } from "../attachments/shared-filesystem-attachment-broker.ts";
import { loadMultiRuntimeConfig, toRuntimeInstance } from "../config/config.ts";
import { ControlPlaneStore } from "../control-plane/control-plane-store.ts";
import { createRouterHttpServer, HttpRuntimeEndpoint, type LocalAgentRelease } from "../http/router-http.ts";
import { PersistentMultiRuntimeRouter } from "../control-plane/persistent-router.ts";
import { startAssignmentReconciler } from "../control-plane/assignment-reconciler.ts";
import { openStateDatabase, stateDatabaseConfigFromEnvironment } from "../storage/state-database.ts";
import { IdentityService } from "../auth/identity-service.ts";
import { SharedWorkspaceArtifactCatalog } from "../artifacts/shared-workspace-artifact-catalog.ts";
import { SqlDeviceRepository } from "../devices/device-service.ts";
import { DeviceRuntimeConnectionRegistry } from "../devices/runtime-connection-registry.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const host = process.env.HOST ?? "127.0.0.1";
const port = integer(process.env.PORT, 8788);
const runtimeConfigPath = resolve(appRoot, process.env.RUNTIME_CONFIG_PATH ?? "./config/runtimes.json");
const attachmentBaseUrl = process.env.ATTACHMENT_BASE_URL ?? `http://${host}:${port}`;
const attachmentRoot = resolve(appRoot, process.env.ATTACHMENT_ROOT ?? "./data/attachments");
const sharedWorkspaceRoot = resolve(appRoot, process.env.WORKSPACE_ROOT ?? process.env.RUNTIME_WORKSPACE_ROOT ?? "./workspace");
const controlPlaneDatabasePath = resolve(appRoot, process.env.CONTROL_PLANE_DATABASE_PATH ?? "./data/control-plane.db");
const runtimeDispatchToken = requiredEnv("RUNTIME_DISPATCH_TOKEN");
const runtimeAttachmentToken = requiredEnv("RUNTIME_ATTACHMENT_TOKEN");
const config = await loadMultiRuntimeConfig(runtimeConfigPath);
const database = await openStateDatabase(stateDatabaseConfigFromEnvironment({
  environment: process.env,
  appRoot,
  sqliteFallbackPath: controlPlaneDatabasePath,
}));
const store = new ControlPlaneStore(database);
await store.ready();
const identity = new IdentityService(database, positiveInteger(process.env.IDENTITY_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000));
await identity.ready();
const devices = new SqlDeviceRepository(database);
await devices.ready();
const runtimeConnections = new DeviceRuntimeConnectionRegistry(devices, store, {
  leaseMs: positiveInteger(process.env.LOCAL_RUNTIME_LEASE_MS, 20_000),
});
const artifactsCatalog = new SharedWorkspaceArtifactCatalog(database, sharedWorkspaceRoot);
await artifactsCatalog.ready();
await store.seedRuntimes(config.runtimes.map((runtime) => ({ ...toRuntimeInstance(runtime), endpoint: runtime.endpoint })));
const router = new PersistentMultiRuntimeRouter({
  store,
  endpointFactory: (endpoint) => endpoint.startsWith("local-runtime://")
    ? runtimeConnections.endpoint(decodeURIComponent(endpoint.slice("local-runtime://".length)))
    : new HttpRuntimeEndpoint(endpoint, `Bearer ${runtimeDispatchToken}`),
  heartbeatTtlMs: positiveInteger(process.env.RUNTIME_HEARTBEAT_TTL_MS, 15_000),
  reservationTtlMs: positiveInteger(process.env.RUNTIME_RESERVATION_TTL_MS, 30_000),
  artifactsCatalog,
});
// Attachment metadata is shared with every Router through the state database;
// bytes require an RWX mount when Router replicas run on different machines.
const attachments = new SharedFilesystemAttachmentBroker(database, attachmentRoot, attachmentBaseUrl);
await attachments.ready();
const server = createRouterHttpServer(router, {
  identity,
  devices,
  attachments,
  runtimeAttachmentToken,
  runtimeDispatchToken,
  localAgentReleases: localAgentReleases(process.env.LOCAL_AGENT_RELEASES_JSON),
  localAgentControl: runtimeConnections,
  // Comma-separated explicit origins allow localhost and 127.0.0.1 during local development.
  ...(process.env.WEB_ORIGIN === undefined ? {} : { webOrigin: process.env.WEB_ORIGIN }),
});
runtimeConnections.attach(server);
server.listen(port, host, () => {
  process.stdout.write(`AgentLoop multi-runtime Router listening on http://${host}:${port}; registered ${config.runtimes.length} Runtime Host(s)\n`);
});
const stopReconciliation = startAssignmentReconciler(router, {
  onError: (error) => process.stderr.write(`Assignment reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`),
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  server.close(() => {
    void stopReconciliation().then(() => database.close()).then(() => { process.exitCode = 0; });
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("PORT must be a valid TCP port");
  return parsed;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3_600_000) throw new Error("value must be a positive integer");
  return parsed;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length < 16) throw new Error(`${name} must be set to a non-trivial shared secret`);
  return value;
}

function localAgentReleases(value: string | undefined): readonly LocalAgentRelease[] {
  if (value === undefined || value.trim() === "") return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("LOCAL_AGENT_RELEASES_JSON must be a JSON array");
  return parsed.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error(`LOCAL_AGENT_RELEASES_JSON[${index}] must be an object`);
    const release = item as Record<string, unknown>;
    const platform = release.platform;
    const arch = release.arch;
    if (platform !== "darwin" && platform !== "windows" && platform !== "linux") throw new Error(`LOCAL_AGENT_RELEASES_JSON[${index}].platform is invalid`);
    if (arch !== "arm64" && arch !== "x64") throw new Error(`LOCAL_AGENT_RELEASES_JSON[${index}].arch is invalid`);
    const required = (name: string): string => {
      const field = release[name];
      if (typeof field !== "string" || field.trim() === "") throw new Error(`LOCAL_AGENT_RELEASES_JSON[${index}].${name} is required`);
      return field;
    };
    const downloadUrl = required("downloadUrl");
    if (new URL(downloadUrl).protocol !== "https:") throw new Error(`LOCAL_AGENT_RELEASES_JSON[${index}].downloadUrl must use HTTPS`);
    const launchUrl = typeof release.launchUrl === "string" && release.launchUrl.trim() !== "" ? release.launchUrl : undefined;
    return {
      version: required("version"), protocolVersion: required("protocolVersion"), platform, arch,
      downloadUrl, sha256: required("sha256"), signature: required("signature"),
      ...(typeof release.releaseNotes === "string" ? { releaseNotes: release.releaseNotes } : {}),
      ...(launchUrl === undefined ? {} : { launchUrl }),
    };
  });
}
