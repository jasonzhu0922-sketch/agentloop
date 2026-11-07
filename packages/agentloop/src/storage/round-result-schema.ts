import type { SqlConnection } from "./connection.ts";

export async function installRoundResultSchema(database: SqlConnection): Promise<void> {
  const id = database.dialect === "tidb" ? "VARCHAR(191)" : "TEXT";
  const text = database.dialect === "tidb" ? "LONGTEXT" : "TEXT";
  await database.exec(`CREATE TABLE IF NOT EXISTS run_round_results (
    run_id ${id} NOT NULL,
    round_number BIGINT NOT NULL,
    plan_id ${id} NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    canonical_revision BIGINT NOT NULL,
    result_json ${text} NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY(run_id, round_number),
    FOREIGN KEY(run_id, round_number) REFERENCES run_rounds(run_id, round_number) ON DELETE CASCADE
  )`);
}
