import type { SqlConnection } from "./connection.ts";

/** Idempotent schema installation for embedded and versioned Runtime databases. */
export async function installRunRoundSchema(database: SqlConnection): Promise<void> {
  const id = database.dialect === "tidb" ? "VARCHAR(191)" : "TEXT";
  const number = "BIGINT";
  const status = database.dialect === "tidb" ? "VARCHAR(32)" : "TEXT";
  await database.exec(`
    CREATE TABLE IF NOT EXISTS run_rounds (
      run_id ${id} NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      round_number ${number} NOT NULL,
      status ${status} NOT NULL CHECK(status IN ('planning', 'executing', 'completed', 'failed', 'cancelled')),
      plan_id ${id} REFERENCES plans(id) ON DELETE SET NULL,
      revision ${number} NOT NULL,
      created_at ${number} NOT NULL,
      updated_at ${number} NOT NULL,
      PRIMARY KEY(run_id, round_number)
    )
  `);
}
