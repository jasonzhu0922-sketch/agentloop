import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { SharedFilesystemAttachmentBroker } from "./attachments/shared-filesystem-attachment-broker.ts";
import { loadMultiRuntimeConfig, toRuntimeInstance } from "../shared/config.ts";
import { ControlPlaneStore } from "./persistence/control-plane-store.ts";
import { createRouterHttpServer } from "./api/router-api.ts";
import { localAgentReleaseSource } from "./releases/local-agent-releases.ts";
import { HttpRuntimeControl } from "./runtime-control/http-runtime-control.ts";
import { RouterService } from "./service/router-service.ts";
import { startAssignmentReconciler } from "./service/assignment-reconciler.ts";
import { openStateDatabase, stateDatabaseConfigFromEnvironment } from "../shared/persistence/state-database.ts";
import { migrateRouterState } from "./persistence/state-migrations.ts";
import { IdentityService } from "./identity/service.ts";
import { SharedWorkspaceArtifactCatalog } from "./artifacts/shared-workspace-artifact-catalog.ts";
import { SqlDeviceRepository } from "./devices/device-service.ts";
import { LocalAgentRuntimeControl } from "./runtime-control/local-agent-runtime-control.ts";

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
  environmentPrefix: "AGENTLOOP_ROUTER_STATE",
}), { schema: "router" });
await migrateRouterState(database);
const store = new ControlPlaneStore(database);
await store.ready();
const identity = new IdentityService(database, positiveInteger(process.env.IDENTITY_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000));
await identity.ready();
const devices = new SqlDeviceRepository(database);
await devices.ready();
const runtimeConnections = new LocalAgentRuntimeControl(devices, store, {
  leaseMs: positiveInteger(process.env.LOCAL_RUNTIME_LEASE_MS, 20_000),
});
const artifactsCatalog = new SharedWorkspaceArtifactCatalog(database, sharedWorkspaceRoot);
await artifactsCatalog.ready();
await store.seedRuntimes(config.runtimes.map((runtime) => ({ ...toRuntimeInstance(runtime), endpoint: runtime.endpoint })));
const router = new RouterService({
  store,
  endpointFactory: (endpoint) => endpoint.startsWith("local-runtime://")
    ? runtimeConnections.endpoint(decodeURIComponent(endpoint.slice("local-runtime://".length)))
    : new HttpRuntimeControl(endpoint, `Bearer ${runtimeDispatchToken}`),
  heartbeatTtlMs: positiveInteger(process.env.RUNTIME_HEARTBEAT_TTL_MS, 15_000),
  reservationTtlMs: positiveInteger(process.env.RUNTIME_RESERVATION_TTL_MS, 30_000),
  artifactsCatalog,
  onDispatchFailure: (event) => process.stderr.write(`${JSON.stringify({ event: "router.dispatch_failed", ...event })}\n`),
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
  localAgentReleaseSource: localAgentReleaseSource(process.env),
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
