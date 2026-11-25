import assert from "node:assert/strict";
import test from "node:test";
import type { SqlConnection, SqlRunResult, SqlStatement, SqlValue } from "../src/storage/connection.ts";
import { appendRunEvent, appendRunEvents } from "../src/storage/repositories/run-event-sequencer.ts";

test("TiDB reuses the atomic update insert id instead of selecting the session value", async () => {
  const connection = new SequenceRecordingConnection();
  const sequence = await appendRunEvent(connection, "run-event-sequence", {
    type: "event", data: {}, createdAt: 1,
  });

  assert.equal(sequence, 8);
  assert.deepEqual(connection.calls.map((call) => call.kind), ["run", "run"]);
  assert.equal(connection.calls.some((call) => call.sql.startsWith("SELECT LAST_INSERT_ID()")), false);
});

test("TiDB appends a related event batch with one allocation and one insert", async () => {
  const connection = new SequenceRecordingConnection();
  const sequences = await appendRunEvents(connection, "run-event-sequence", [
    { type: "action.created", data: { actionId: "a" }, createdAt: 1 },
    { type: "action.leased", data: { actionId: "a" }, createdAt: 1 },
    { type: "action.dispatched", data: { actionId: "a" }, createdAt: 1 },
  ]);

  assert.deepEqual(sequences, [6, 7, 8]);
  assert.deepEqual(connection.calls.map((call) => call.kind), ["run", "run"]);
  assert.equal(connection.calls[0]?.sql,
    "UPDATE run_event_sequences SET next_seq = LAST_INSERT_ID(next_seq + ?) WHERE run_id = ?");
  assert.match(connection.calls[1]?.sql ?? "", /VALUES \(\?, \?, \?, \?, \?\), \(\?, \?, \?, \?, \?\), \(\?, \?, \?, \?, \?\)/);
  assert.equal(connection.calls[1]?.params.length, 15);
});

class SequenceRecordingConnection implements SqlConnection {
  readonly dialect = "tidb" as const;
  readonly calls: Array<{ kind: "run" | "get"; sql: string; params: readonly SqlValue[] }> = [];

  async exec(): Promise<void> {}

  prepare(sql: string): SqlStatement {
    return {
      run: async (...params): Promise<SqlRunResult> => {
        this.calls.push({ kind: "run", sql, params });
        if (sql.includes("next_seq + ?")) return { changes: 1, lastInsertRowid: 9 };
        if (sql.includes("next_seq + 1")) return { changes: 1, lastInsertRowid: 9 };
        return { changes: 1 };
      },
      get: async <T>(...params): Promise<T | undefined> => {
        this.calls.push({ kind: "get", sql, params });
        return undefined;
      },
      all: async <T>(): Promise<T[]> => [],
    };
  }

  async transaction<T>(operation: () => T | Promise<T>): Promise<T> { return await operation(); }
  async close(): Promise<void> {}
}
