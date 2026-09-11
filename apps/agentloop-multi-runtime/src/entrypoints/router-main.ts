import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { SharedFilesystemAttachmentBroker } from "../attachments/shared-filesystem-attachment-broker.ts";
import { loadMultiRuntimeConfig, toRuntimeInstance } from "../config/config.ts";
import { ControlPlaneStore } from "../control-plane/control-plane-store.ts";
import { createRouterHttpServer, HttpRuntimeEndpoint } from "../http/router-http.ts";
import { PersistentMultiRuntimeRouter } from "../control-plane/persistent-router.ts";
import { openStateDatabase, stateDatabaseConfigFromEnvironment } from "../storage/state-database.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const host = process.env.HOST ?? "127.0.0.1";
const port = integer(process.env.PORT, 8788);
const runtimeConfigPath = resolve(appRoot, process.env.RUNTIME_CONFIG_PATH ?? "./config/runtimes.json");
const attachmentBaseUrl = process.env.ATTACHMENT_BASE_URL ?? `http://${host}:${port}`;
const attachmentRoot = resolve(appRoot, process.env.ATTACHMENT_ROOT ?? "./data/attachments");
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
await store.seedRuntimes(config.runtimes.map((runtime) => ({ ...toRuntimeInstance(runtime), endpoint: runtime.endpoint })));
const router = new PersistentMultiRuntimeRouter({
  store,
  endpointFactory: (endpoint) => new HttpRuntimeEndpoint(endpoint, `Bearer ${runtimeDispatchToken}`),
  heartbeatTtlMs: positiveInteger(process.env.RUNTIME_HEARTBEAT_TTL_MS, 15_000),
  reservationTtlMs: positiveInteger(process.env.RUNTIME_RESERVATION_TTL_MS, 30_000),
});
// Attachment metadata is shared with every Router through the state database;
// bytes require an RWX mount when Router replicas run on different machines.
const attachments = new SharedFilesystemAttachmentBroker(database, attachmentRoot, attachmentBaseUrl);
await attachments.ready();
const server = createRouterHttpServer(router, {
  attachments,
  runtimeAttachmentToken,
  runtimeDispatchToken,
  // Comma-separated explicit origins allow localhost and 127.0.0.1 during local development.
  ...(process.env.WEB_ORIGIN === undefined ? {} : { webOrigin: process.env.WEB_ORIGIN }),
});
server.listen(port, host, () => {
  process.stdout.write(`AgentLoop multi-runtime Router listening on http://${host}:${port}; registered ${config.runtimes.length} Runtime Host(s)\n`);
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  server.close(() => {
    void database.close();
    process.exitCode = 0;
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
