import { createAdminApiServer } from "./bootstrap/server.ts";
import { DenyAllAuthorization } from "./authorization/deny-all-authorization.ts";
import { ReleaseApplicationService } from "./application/release-service.ts";
import { RuntimeConfigurationSnapshotService } from "./application/runtime-configuration-snapshot-service.ts";
import { openReadyControlPlaneDatabase } from "./infrastructure/control-plane-database.ts";
import { SqlControlPlaneStore } from "./persistence/sql-control-plane-store.ts";

const port = Number(process.env.ADMIN_API_PORT ?? "8792");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError("ADMIN_API_PORT must be a TCP port");

const connectionString = process.env.CONTROL_PLANE_DATABASE_URL;
const database = connectionString === undefined ? undefined : await openReadyControlPlaneDatabase(connectionString);
const store = database === undefined ? undefined : new SqlControlPlaneStore(database);
const releases = store === undefined ? undefined : new ReleaseApplicationService(store);
const snapshots = store === undefined ? undefined : new RuntimeConfigurationSnapshotService({
  repository: store, now: () => Date.now(), ttlMs: positiveInteger(process.env.CONTROL_PLANE_SNAPSHOT_TTL_MS, 60_000),
});
const server = createAdminApiServer({ authorization: new DenyAllAuthorization(), ...(releases === undefined ? {} : { releases }), ...(snapshots === undefined ? {} : { snapshots }) });
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
