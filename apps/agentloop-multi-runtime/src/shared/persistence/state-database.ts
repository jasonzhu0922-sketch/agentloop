import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AppDatabase, PgConnection, SqliteConnection, TiDbConnection } from "@zhujun/agentloop";

export type StateDatabaseConfig =
  | { readonly driver: "sqlite"; readonly databasePath: string }
  | { readonly driver: "postgres"; readonly connectionString: string; readonly poolSize?: number }
  | { readonly driver: "tidb"; readonly connectionString: string; readonly poolSize?: number };

/** Resolves the shared state store used by the Router and Runtime Hosts. */
export function stateDatabaseConfigFromEnvironment(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly appRoot: string;
  readonly sqliteFallbackPath: string;
  /** Role-specific names such as AGENTLOOP_ROUTER_STATE_DRIVER, with AGENTLOOP_STATE_* fallback. */
  readonly environmentPrefix?: "AGENTLOOP_ROUTER_STATE" | "AGENTLOOP_RUNTIME_STATE";
}): StateDatabaseConfig {
  const value = (suffix: "DRIVER" | "SQLITE_PATH" | "DATABASE_URL" | "POOL_SIZE"): string | undefined =>
    input.environment[input.environmentPrefix === undefined ? `AGENTLOOP_STATE_${suffix}` : `${input.environmentPrefix}_${suffix}`]
      ?? input.environment[`AGENTLOOP_STATE_${suffix}`];
  const driver = value("DRIVER") ?? "sqlite";
  if (driver === "sqlite") {
    return {
      driver,
      databasePath: resolve(input.appRoot, value("SQLITE_PATH") ?? input.sqliteFallbackPath),
    };
  }
  if (driver !== "postgres" && driver !== "tidb") throw new TypeError("AGENTLOOP_STATE_DRIVER must be sqlite, postgres, or tidb");
  const connectionString = value("DATABASE_URL");
  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new TypeError(`AGENTLOOP_STATE_DATABASE_URL must be configured when AGENTLOOP_STATE_DRIVER=${driver}`);
  }
  const poolSize = optionalPositiveInteger(value("POOL_SIZE"), "AGENTLOOP_STATE_POOL_SIZE");
  return { driver, connectionString, ...(poolSize === undefined ? {} : { poolSize }) };
}

/**
 * Opens one cloud-side state database. Router and Runtime have distinct
 * schema ownership: the Router only receives the connection facade, while a
 * Runtime Host installs the AgentLoop kernel tables it executes against.
 */
export async function openStateDatabase(
  config: StateDatabaseConfig,
  input: { readonly schema: "router" | "runtime"; readonly autoMigrateKernel?: boolean } = { schema: "runtime" },
): Promise<AppDatabase> {
  const kernelSchema = input.schema === "runtime" && input.autoMigrateKernel !== false ? "kernel" : "none";
  if (config.driver === "sqlite") {
    if (config.databasePath !== ":memory:") mkdirSync(dirname(config.databasePath), { recursive: true });
    return await AppDatabase.open({
      connection: new SqliteConnection(config.databasePath),
      schema: kernelSchema,
    });
  }
  const connection = config.driver === "postgres"
    ? await PgConnection.create(config.poolSize === undefined
      ? config.connectionString
      : { connectionString: config.connectionString, max: config.poolSize })
    : await TiDbConnection.create(config.poolSize === undefined
      ? config.connectionString
      : { uri: config.connectionString, connectionLimit: config.poolSize });
  return await AppDatabase.open({ connection, schema: kernelSchema });
}

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}
