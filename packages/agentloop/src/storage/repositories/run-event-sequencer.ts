import type { SqlConnection } from "../connection.ts";
import { sqlForDialect } from "../dialect-sql.ts";

export interface RunEventAppendInput {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

/**
 * Appends one ordered Run event across every Runtime writer.
 *
 * `MAX(seq) + 1` alone is not a sequence allocator: independent Action,
 * recovery, and Run writers can observe the same maximum in separate
 * transactions. The per-Run counter row is corrected against retained events
 * and incremented atomically with the event, so it serializes allocation
 * without imposing a global event lock.
 */
export async function appendRunEvent(
  connection: SqlConnection,
  runId: string,
  input: RunEventAppendInput,
): Promise<number> {
  return await connection.transaction(async () => {
    // Backfill lazily as well as in schema migration. Crucially, an existing
    // counter can be behind a retained event stream after an interrupted
    // migration or a formerly concurrent writer, so conflict handling must
    // advance it rather than merely preserve that stale value.
    const existing = await connection.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?",
    ).get<{ next_seq: number }>(runId);
    const nextSeq = Number(existing?.next_seq ?? 1);
    if (!Number.isSafeInteger(nextSeq) || nextSeq < 1) throw new TypeError("Run event sequence is invalid");

    await connection.prepare(sqlForDialect(connection.dialect, {
      sqlite: `INSERT INTO run_event_sequences(run_id, next_seq) VALUES (?, ?)
        ON CONFLICT(run_id) DO UPDATE SET next_seq = MAX(next_seq, excluded.next_seq)`,
      postgres: `INSERT INTO run_event_sequences(run_id, next_seq) VALUES (?, ?)
        ON CONFLICT(run_id) DO UPDATE SET next_seq = GREATEST(run_event_sequences.next_seq, excluded.next_seq)`,
      tidb: `INSERT INTO run_event_sequences(run_id, next_seq) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE next_seq = GREATEST(next_seq, VALUES(next_seq))`,
    })).run(runId, nextSeq);

    // TiDB's ordinary consistent reads may not be a safe way to retrieve a
    // value allocated by a preceding write while another writer is appending
    // the same Run. LAST_INSERT_ID(expr) is scoped to this transaction's
    // pinned MySQL/TiDB connection and returns the exact incremented value.
    await connection.prepare(sqlForDialect(connection.dialect, {
      sqlite: "UPDATE run_event_sequences SET next_seq = next_seq + 1 WHERE run_id = ?",
      postgres: "UPDATE run_event_sequences SET next_seq = next_seq + 1 WHERE run_id = ?",
      tidb: "UPDATE run_event_sequences SET next_seq = LAST_INSERT_ID(next_seq + 1) WHERE run_id = ?",
    })).run(runId);
    const allocated = await connection.prepare(connection.dialect === "tidb"
      ? "SELECT LAST_INSERT_ID() - 1 AS seq"
      : "SELECT next_seq - 1 AS seq FROM run_event_sequences WHERE run_id = ?",
    ).get<{ seq: number }>(...(connection.dialect === "tidb" ? [] : [runId]));
    const seq = Number(allocated?.seq);
    if (!Number.isSafeInteger(seq) || seq < 1) throw new TypeError("Run event sequence allocation failed");
    await connection.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, seq, input.type, JSON.stringify(input.data), input.createdAt);
    return seq;
  });
}
