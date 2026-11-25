import type { RuntimePersistence } from "./runtime-records.ts";
import type { RuntimeRedisPort } from "./redis-runtime-state-store.ts";

/** Runtime execution state configuration; Skill/control-plane SQL is configured separately. */
export type RuntimeRecordBackendConfig =
  | { readonly backend: "sqlite"; readonly filename: string }
  | { readonly backend: "redis"; readonly url: string; readonly namespace: string; readonly maxCommandBytes?: number };

/** Opens exactly the requested record engine. Never falls back or imports history on startup. */
export async function openRuntimeRecordBackend(config: RuntimeRecordBackendConfig, dependencies?: { redis?: RuntimeRedisPort; sqlite?: import("./connection.ts").SqlConnection }): Promise<RuntimePersistence> {
  if (config.backend === "sqlite") {
    if (!config.filename.trim() || config.filename === ":memory:" || config.filename.includes("\0")) throw new TypeError("SQLite Runtime requires a persistent file");
    const { AppDatabase } = await import("./database.ts");
    const { runtimePersistence } = await import("./runtime-records.ts");
    if (dependencies?.sqlite) {
      if (dependencies.sqlite.dialect !== "sqlite") throw new TypeError("SQLite Runtime requires a SQLite connection");
      return runtimePersistence(dependencies.sqlite);
    }
    const database = new AppDatabase(config.filename);
    try { await database.ready(); return runtimePersistence(database); }
    catch (error) { await database.close().catch(() => {}); throw error; }
  }
  if (config.backend !== "redis") throw new TypeError("Unknown Runtime record backend");
  const { RedisRuntimeRecords } = await import("./redis-runtime-records.ts");
  const { RuntimeRedisClient } = await import("./runtime-redis-client.ts");
  return await RedisRuntimeRecords.open(dependencies?.redis ?? new RuntimeRedisClient(config.url), { prefix: config.namespace, maxCommandBytes: config.maxCommandBytes });
}

/** Public Runtime assembly entry point, shared by all hosts. */
export type RuntimeStateConfig = RuntimeRecordBackendConfig;
export const openRuntimeState = openRuntimeRecordBackend;
