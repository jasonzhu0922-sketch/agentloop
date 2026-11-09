import type { SqlConnection } from "./connection.ts";

export async function installRoundScopeSchema(database: SqlConnection): Promise<void> {
  const id = database.dialect === "tidb" ? "VARCHAR(191)" : "TEXT";
  const text = database.dialect === "tidb" ? "LONGTEXT" : "TEXT";
  await database.exec(`CREATE TABLE IF NOT EXISTS plan_round_scopes (
    plan_id ${id} NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    plan_version BIGINT NOT NULL,
    scope_json ${text} NOT NULL,
    PRIMARY KEY(plan_id, plan_version)
  )`);
}
