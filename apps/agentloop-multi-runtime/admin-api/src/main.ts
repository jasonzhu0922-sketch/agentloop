import { createAdminApiServer } from "./bootstrap/server.ts";
import { DenyAllAuthorization } from "./authorization/deny-all-authorization.ts";
import { StaticTokenAuthorization } from "./authorization/static-token-authorization.ts";
import { ReleaseApplicationService } from "./application/release-service.ts";
import { RuntimeConfigurationSnapshotService } from "./application/runtime-configuration-snapshot-service.ts";
import { openReadyControlPlaneDatabase } from "./infrastructure/control-plane-database.ts";
import { SqlControlPlaneStore } from "./persistence/sql-control-plane-store.ts";

const port = Number(process.env.ADMIN_API_PORT ?? "8792");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError("ADMIN_API_PORT must be a TCP port");

const connectionString = process.env.AGENTLOOP_ADMIN_DATABASE_URL;
const database = connectionString === undefined ? undefined : await openReadyControlPlaneDatabase(connectionString);
const store = database === undefined ? undefined : new SqlControlPlaneStore(database);
const releases = store === undefined ? undefined : new ReleaseApplicationService(store);
const snapshots = store === undefined ? undefined : new RuntimeConfigurationSnapshotService({
  repository: store, now: () => Date.now(), ttlMs: positiveInteger(process.env.CONTROL_PLANE_SNAPSHOT_TTL_MS, 60_000),
});
const server = createAdminApiServer({ authorization: authorizationFromEnvironment(), ...(releases === undefined ? {} : { releases }), ...(snapshots === undefined ? {} : { snapshots }), ...(store === undefined ? {} : { identity: store, audit: store, catalog: store }) });
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`AgentLoop Admin API scaffold listening on 127.0.0.1:${port}\n`);
});
async function shutdown(): Promise<void> {
  server.close();
  await database?.close();
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 86_400_000) throw new TypeError("CONTROL_PLANE_SNAPSHOT_TTL_MS must be a positive millisecond duration");
  return parsed;
}

function authorizationFromEnvironment() {
  if (process.env.ADMIN_AUTH_MODE !== "static") return new DenyAllAuthorization();
  const token = process.env.ADMIN_AUTH_TOKEN;
  if (token === undefined) throw new TypeError("ADMIN_AUTH_TOKEN is required when ADMIN_AUTH_MODE=static");
  const role = process.env.ADMIN_AUTH_ROLE;
  if (role !== "platform_admin" && role !== "operator" && role !== "skill_operator" && role !== "auditor" && role !== "member") throw new TypeError("ADMIN_AUTH_ROLE must be platform_admin, operator, skill_operator, auditor, or member");
  return new StaticTokenAuthorization({ token, role, actorId: process.env.ADMIN_AUTH_ACTOR_ID ?? "bootstrap-admin", ...(process.env.ADMIN_AUTH_SCOPE_ID === undefined ? {} : { scopeId: process.env.ADMIN_AUTH_SCOPE_ID }) });
}
