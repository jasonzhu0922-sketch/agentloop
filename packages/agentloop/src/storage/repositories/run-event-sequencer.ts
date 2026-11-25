import type { SqlConnection } from "../connection.ts";
import type { RuntimePersistence, RuntimePersistenceInput } from "../runtime-records.ts";
import { sqlForDialect } from "../dialect-sql.ts";
import {
  runtimePerformanceInstant,
  runtimePerformanceSpan,
  withRuntimePerformanceContext,
} from "../../diagnostics/runtime-performance.ts";

export interface RunEventAppendInput {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export async function appendRunEvents(
  connection: RuntimePersistenceInput,
  runId: string,
  inputs: readonly RunEventAppendInput[],
): Promise<readonly number[]> {
  if ("records" in connection) return await appendRecordEvents(connection, runId, inputs);
  if (connection.runEventStore) return await connection.runEventStore.append(runId, inputs);
  return await withRuntimePerformanceContext({ runId }, async () => {
    if (inputs.length === 0) return [];
    if (inputs.length === 1) return [await appendRunEvent(connection, runId, inputs[0]!)];
    if (connection.dialect === "tidb") {
      try {
        return await connection.transaction(async () => await appendTiDbBatchFast(connection, runId, inputs));
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
    }
    return await connection.transaction(async () => {
      const sequences: number[] = [];
      for (const input of inputs) sequences.push(await appendRunEventRepair(connection, runId, input));
      return sequences;
    });
  });
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
  connection: RuntimePersistenceInput,
  runId: string,
  input: RunEventAppendInput,
): Promise<number> {
  if ("records" in connection) return (await appendRecordEvents(connection, runId, [input]))[0]!;
  if (connection.runEventStore) return (await connection.runEventStore.append(runId, [input]))[0]!;
  // The data-agent's shared state lives on TiDB, where every extra statement
  // is a network round trip. Once the per-Run counter exists, its atomic
  // increment is the sequence allocator; retain the repair path below for
  // legacy Runs whose counter is missing or behind retained events.
  return await withRuntimePerformanceContext({ runId }, async () => {
    if (connection.dialect === "tidb") {
      try {
        return await connection.transaction(async () => await appendTiDbFast(connection, runId, input));
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
    }
    return await appendRunEventRepair(connection, runId, input);
  });
}

async function appendRecordEvents(state: RuntimePersistence, runId: string, inputs: readonly RunEventAppendInput[]): Promise<readonly number[]> {
  if (state.appendEvents) return await state.appendEvents(runId, inputs);
  if (state.eventStore) return await state.eventStore.append(runId, inputs);
  return await appendRuntimeRecordEvents(state, runId, inputs);
}

/** Pure record-only operation; native backends may retry it after a CAS conflict. */
export async function appendRuntimeRecordEvents(state: RuntimePersistence, runId: string, inputs: readonly RunEventAppendInput[]): Promise<readonly number[]> {
  if (!inputs.length) return [];
  return await state.transaction(async () => {
    let counter = (await state.records.find("run_event_sequences", { run_id: runId }))[0];
    if (!counter) {
      const retained = await state.records.find("run_events", { run_id: runId });
      counter = { run_id: runId, next_seq: retained.reduce((max, event) => Math.max(max, event.seq), 0) + 1 };
      await state.records.insert("run_event_sequences", counter);
    }
    const sequences = inputs.map((_, index) => counter.next_seq + index);
    if (sequences.some(seq => !Number.isSafeInteger(seq) || seq < 1)) throw new TypeError("Invalid Runtime event sequence");
    await state.records.update("run_event_sequences", { run_id: runId }, () => ({ next_seq: counter.next_seq + inputs.length }));
    for (const [index, event] of inputs.entries()) await state.records.insert("run_events", {
      run_id: runId, seq: sequences[index], type: event.type, payload_json: JSON.stringify(event.data), created_at: event.createdAt,
    });
    return sequences;
  });
}

async function appendTiDbFast(
  connection: SqlConnection,
  runId: string,
  input: RunEventAppendInput,
): Promise<number> {
  let seq = await runtimePerformanceSpan("event.sequence.allocate", { category: "event_persistence", eventType: input.type, strategy: "tidb_fast" }, async () => {
    const updated = await connection.prepare(
      "UPDATE run_event_sequences SET next_seq = LAST_INSERT_ID(next_seq + 1) WHERE run_id = ?",
    ).run(runId);
    if (Number(updated.changes) === 1) {
      const nextSeq = updated.lastInsertRowid === undefined
        ? Number((await connection.prepare("SELECT LAST_INSERT_ID() AS next_seq").get<{ next_seq: number }>())?.next_seq)
        : Number(updated.lastInsertRowid);
      return nextSeq - 1;
    }
    await connection.prepare(
      "INSERT INTO run_event_sequences(run_id, next_seq) VALUES (?, 2)",
    ).run(runId);
    return 1;
  });
  if (!Number.isSafeInteger(seq) || seq < 1) throw new TypeError("Run event sequence allocation failed");
  runtimePerformanceInstant("event.sequence.allocated", { category: "event_persistence", eventType: input.type, seq });
  await runtimePerformanceSpan("event.insert", { category: "event_persistence", eventType: input.type, seq },
    async () => await insertRunEvent(connection, runId, seq, input));
  return seq;
}

async function appendTiDbBatchFast(
  connection: SqlConnection,
  runId: string,
  inputs: readonly RunEventAppendInput[],
): Promise<readonly number[]> {
  const firstSeq = await runtimePerformanceSpan("event.sequence.allocate_batch", {
    category: "event_persistence", eventTypes: inputs.map(input => input.type), count: inputs.length, strategy: "tidb_fast",
  }, async () => {
    const updated = await connection.prepare(
      "UPDATE run_event_sequences SET next_seq = LAST_INSERT_ID(next_seq + ?) WHERE run_id = ?",
    ).run(inputs.length, runId);
    if (Number(updated.changes) === 1) {
      const nextSeq = updated.lastInsertRowid === undefined
        ? Number((await connection.prepare("SELECT LAST_INSERT_ID() AS next_seq").get<{ next_seq: number }>())?.next_seq)
        : Number(updated.lastInsertRowid);
      return nextSeq - inputs.length;
    }
    await connection.prepare(
      "INSERT INTO run_event_sequences(run_id, next_seq) VALUES (?, ?)",
    ).run(runId, inputs.length + 1);
    return 1;
  });
  const sequences = inputs.map((_, index) => firstSeq + index);
  if (sequences.some((seq) => !Number.isSafeInteger(seq) || seq < 1)) {
    throw new TypeError("Run event sequence allocation failed");
  }
  await runtimePerformanceSpan("event.insert_batch", {
    category: "event_persistence", eventTypes: inputs.map(input => input.type), sequences, count: inputs.length,
  }, async () => await insertRunEvents(connection, runId, sequences, inputs));
  return sequences;
}

async function appendRunEventRepair(
  connection: SqlConnection,
  runId: string,
  input: RunEventAppendInput,
): Promise<number> {
  return await connection.transaction(async () => {
    // Backfill lazily as well as in schema migration. Crucially, an existing
    // counter can be behind a retained event stream after an interrupted
    // migration or a formerly concurrent writer, so conflict handling must
    // advance it rather than merely preserve that stale value.
    const seq = await runtimePerformanceSpan("event.sequence.allocate", { category: "event_persistence", eventType: input.type, strategy: "repair" }, async () => {
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
      return Number(allocated?.seq);
    });
    if (!Number.isSafeInteger(seq) || seq < 1) throw new TypeError("Run event sequence allocation failed");
    runtimePerformanceInstant("event.sequence.allocated", { category: "event_persistence", eventType: input.type, seq });
    await runtimePerformanceSpan("event.insert", { category: "event_persistence", eventType: input.type, seq },
      async () => await insertRunEvent(connection, runId, seq, input));
    return seq;
  });
}

async function insertRunEvent(
  connection: SqlConnection,
  runId: string,
  seq: number,
  input: RunEventAppendInput,
): Promise<void> {
  await connection.prepare(`
    INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(runId, seq, input.type, JSON.stringify(input.data), input.createdAt);
}

async function insertRunEvents(
  connection: SqlConnection,
  runId: string,
  sequences: readonly number[],
  inputs: readonly RunEventAppendInput[],
): Promise<void> {
  const values = inputs.map(() => "(?, ?, ?, ?, ?)").join(", ");
  const params = inputs.flatMap((input, index) => [
    runId, sequences[index]!, input.type, JSON.stringify(input.data), input.createdAt,
  ]);
  await connection.prepare(`
    INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
    VALUES ${values}
  `).run(...params);
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; errno?: unknown; message?: unknown };
  return value.code === "ER_DUP_ENTRY"
    || value.code === "ER_DUP_KEY"
    || value.errno === 1062
    || (typeof value.message === "string" && /duplicate (?:entry|key)/iu.test(value.message));
}
