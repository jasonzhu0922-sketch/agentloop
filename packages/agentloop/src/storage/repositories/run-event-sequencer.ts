import type { SqlConnection } from "../connection.ts";
import { insertIfAbsentSql } from "../dialect-sql.ts";

export interface RunEventAppendInput {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

/**
 * Appends one ordered Run event across every Runtime writer.
 *
 * `MAX(seq) + 1` alone is not a sequence allocator: independent Action,
 * recovery, and Run writers can observe the same maximum in separate TiDB
 * transactions.  The per-Run counter row is updated in the same transaction
 * as the event, so its row lock serializes allocation without imposing a
 * global event lock.
 */
export async function appendRunEvent(
  connection: SqlConnection,
  runId: string,
  input: RunEventAppendInput,
): Promise<number> {
  return await connection.transaction(async () => {
    // Backfill lazily as well as in schema migration: kernel-only users and
    // retained Runs created before the counter table remain safe on upgrade.
    const existing = await connection.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?",
    ).get<{ next_seq: number }>(runId);
    const nextSeq = Number(existing?.next_seq ?? 1);
    if (!Number.isSafeInteger(nextSeq) || nextSeq < 1) throw new TypeError("Run event sequence is invalid");
    await connection.prepare(insertIfAbsentSql({
      dialect: connection.dialect,
      insert: "INSERT INTO run_event_sequences(run_id, next_seq) VALUES (?, ?)",
      keyColumn: "run_id",
    })).run(runId, nextSeq);
    await connection.prepare(
      "UPDATE run_event_sequences SET next_seq = next_seq + 1 WHERE run_id = ?",
    ).run(runId);
    const allocated = await connection.prepare(
      "SELECT next_seq - 1 AS seq FROM run_event_sequences WHERE run_id = ?",
    ).get<{ seq: number }>(runId);
    const seq = Number(allocated?.seq);
    if (!Number.isSafeInteger(seq) || seq < 1) throw new TypeError("Run event sequence allocation failed");
    await connection.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, seq, input.type, JSON.stringify(input.data), input.createdAt);
    return seq;
  });
}
