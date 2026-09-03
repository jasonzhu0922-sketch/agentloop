import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PgConnection, SqliteConnection, type SqlConnection } from "@zhujun/agentloop";
import type { PlanTemplateStorageConfig } from "../config.ts";
import { sqliteDatabasePath } from "./storage-config.ts";

export async function createPlanTemplateConnection(
  config: PlanTemplateStorageConfig,
): Promise<SqlConnection> {
  if (config.type === "sqlite") {
    const databasePath = sqliteDatabasePath(config);
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    return new SqliteConnection(databasePath);
  }

  const connectionConfig: string | Record<string, unknown> = config.poolSize === undefined
    ? config.connectionString
    : { connectionString: config.connectionString, max: config.poolSize };
  return PgConnection.create(connectionConfig);
}
