import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AppDatabase, PgConnection } from "@zhujun/agentloop";

export type StateDatabaseConfig =
  | { readonly driver: "sqlite"; readonly databasePath: string }
  | { readonly driver: "postgres"; readonly connectionString: string; readonly poolSize?: number };

/** Resolves the shared state store used by the Router and Runtime Hosts. */
export function stateDatabaseConfigFromEnvironment(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly appRoot: string;
  readonly sqliteFallbackPath: string;
}): StateDatabaseConfig {
  const driver = input.environment.AGENTLOOP_STATE_DRIVER ?? "sqlite";
  if (driver === "sqlite") {
    return {
      driver,
      databasePath: resolve(input.appRoot, input.environment.AGENTLOOP_STATE_SQLITE_PATH ?? input.sqliteFallbackPath),
    };
  }
  if (driver !== "postgres") throw new TypeError("AGENTLOOP_STATE_DRIVER must be sqlite or postgres");
  const connectionString = input.environment.AGENTLOOP_STATE_DATABASE_URL;
  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new TypeError("AGENTLOOP_STATE_DATABASE_URL must be configured when AGENTLOOP_STATE_DRIVER=postgres");
  }
  const poolSize = optionalPositiveInteger(input.environment.AGENTLOOP_STATE_POOL_SIZE, "AGENTLOOP_STATE_POOL_SIZE");
  return { driver, connectionString, ...(poolSize === undefined ? {} : { poolSize }) };
}

export async function openStateDatabase(config: StateDatabaseConfig): Promise<AppDatabase> {
  if (config.driver === "sqlite") {
    if (config.databasePath !== ":memory:") mkdirSync(dirname(config.databasePath), { recursive: true });
    return new AppDatabase(config.databasePath);
  }
  const connection = await PgConnection.create(
    config.poolSize === undefined
      ? config.connectionString
      : { connectionString: config.connectionString, max: config.poolSize },
  );
  return await AppDatabase.open({ connection });
}

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}
