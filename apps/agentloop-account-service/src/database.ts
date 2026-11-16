import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PgConnection, SqliteConnection, type SqlConnection } from "@zhujun/agentloop";

export type AccountDatabaseConfiguration =
  | { driver: "sqlite"; path: string }
  | { driver: "postgres"; url: string; poolSize: number };

export function accountDatabaseConfiguration(env: NodeJS.ProcessEnv = process.env): AccountDatabaseConfiguration {
  const driver = env.ACCOUNT_SERVICE_DATABASE_DRIVER ?? "sqlite";
  if (driver === "sqlite") {
    if (env.ACCOUNT_SERVICE_DATABASE_URL) throw new Error("account_database_driver_required_for_url");
    return { driver, path: resolve(env.ACCOUNT_SERVICE_DATABASE_PATH ?? "data/accounts.db") };
  }
  if (driver !== "postgres") throw new Error("account_database_driver_invalid");
  const url = env.ACCOUNT_SERVICE_DATABASE_URL;
  if (!url) throw new Error("account_database_url_required");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("account_database_url_invalid"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.pathname.length < 2) throw new Error("account_database_url_invalid");
  const size = env.ACCOUNT_SERVICE_DATABASE_POOL_SIZE ?? "5";
  if (!/^[1-9][0-9]*$/.test(size) || Number(size) > 50) throw new Error("account_database_pool_size_invalid");
  return { driver, url, poolSize: Number(size) };
}

export async function openAccountDatabase(configuration = accountDatabaseConfiguration()): Promise<SqlConnection> {
  if (configuration.driver === "postgres") {
    return PgConnection.create({ connectionString: configuration.url, max: configuration.poolSize,
      connectionTimeoutMillis: 10_000, application_name: "agentloop-account-service" });
  }
  await mkdir(dirname(configuration.path), { recursive: true, mode: 0o700 });
  return new SqliteConnection(configuration.path);
}
