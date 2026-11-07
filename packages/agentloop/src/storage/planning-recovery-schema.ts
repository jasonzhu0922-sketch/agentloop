import type { SqlConnection } from "./connection.ts";

export async function installPlanningRecoverySchema(database: SqlConnection): Promise<void> {
  const id = database.dialect === "tidb" ? "VARCHAR(191)" : "TEXT";
  const text = database.dialect === "tidb" ? "LONGTEXT" : "TEXT";
  const status = database.dialect === "tidb" ? "VARCHAR(32)" : "TEXT";
  await database.exec(`CREATE TABLE IF NOT EXISTS run_planning_recovery (
    run_id ${id} PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    state ${status} NOT NULL CHECK(state IN ('prepared', 'waiting', 'resuming', 'completed', 'cancelled')),
    context_json ${text} NOT NULL,
    failure_phase ${status},
    error_code ${status},
    request_id ${id},
    resume_attempts BIGINT NOT NULL DEFAULT 0,
    lease_token ${id},
    lease_until BIGINT,
    revision BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`);
}
