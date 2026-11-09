import type { SqlConnection } from "./connection.ts";

export async function installRunInputSchema(db: SqlConnection): Promise<void> {
  const id = db.dialect === "tidb" ? "VARCHAR(191)" : "TEXT";
  const text = db.dialect === "tidb" ? "LONGTEXT" : "TEXT";
  await db.exec(`CREATE TABLE IF NOT EXISTS run_input_controls (
    run_id ${id} PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL DEFAULT 0,
    received_seq BIGINT NOT NULL DEFAULT 0,
    consumed_seq BIGINT NOT NULL DEFAULT 0,
    lease_token ${id}, lease_until BIGINT
  )`);
  await db.exec(`CREATE TABLE IF NOT EXISTS run_input_messages (
    id ${id} PRIMARY KEY,
    run_id ${id} NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    owner_user_id ${id} NOT NULL,
    conversation_id ${id},
    request_id ${id} NOT NULL,
    seq BIGINT NOT NULL,
    text ${text} NOT NULL,
    status ${id} NOT NULL,
    decision_json ${text},
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(run_id, request_id), UNIQUE(run_id, seq)
  )`);
}
