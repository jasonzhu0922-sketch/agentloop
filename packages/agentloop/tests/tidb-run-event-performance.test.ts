import assert from "node:assert/strict";
import test from "node:test";
import type { SqlConnection, SqlRunResult, SqlStatement, SqlValue } from "../src/storage/connection.ts";
import { appendRunEvent } from "../src/storage/repositories/run-event-sequencer.ts";
import { TiDbConnection, type TiDbClientLike, type TiDbPoolLike } from "../src/storage/tidb-connection.ts";

test("TiDB event allocation reads the atomic sequence from the UPDATE OK packet", async () => {
  const connection = new SequenceRecordingConnection();
  const sequence = await appendRunEvent(connection, "run-event-sequence", {
    type: "event",
    data: {},
    createdAt: 1,
  });

  assert.equal(sequence, 8);
  assert.equal(connection.calls.some((call) => call.kind === "get"), false);
  assert.deepEqual(connection.calls.map((call) => call.kind), ["run", "run"]);
});

test("TiDB event append needs only four wire round trips for an initialized Run", async () => {
  const pool = new RecordingTiDbPool();
  const connection = TiDbConnection.fromPool(pool);
  const sequence = await appendRunEvent(connection, "run-event-sequence", {
    type: "event",
    data: { persisted: true },
    createdAt: 1,
  });

  assert.equal(sequence, 8);
  assert.deepEqual(pool.clientQueries.map((query) => query.sql.trim()), [
    "START TRANSACTION",
    "UPDATE run_event_sequences SET next_seq = LAST_INSERT_ID(next_seq + 1) WHERE run_id = ?",
    "INSERT INTO run_events(run_id, seq, type, payload_json, created_at)\n    VALUES (?, ?, ?, ?, ?)",
    "COMMIT",
  ]);
});

class SequenceRecordingConnection implements SqlConnection {
  readonly dialect = "tidb" as const;
  readonly calls: Array<{ kind: "run" | "get"; sql: string; params: readonly SqlValue[] }> = [];

  async exec(): Promise<void> {}
  prepare(sql: string): SqlStatement {
    return {
      run: async (...params): Promise<SqlRunResult> => {
        this.calls.push({ kind: "run", sql, params });
        return {
          changes: 1,
          ...(sql === "UPDATE run_event_sequences SET next_seq = LAST_INSERT_ID(next_seq + 1) WHERE run_id = ?"
            ? { lastInsertRowid: 9 }
            : {}),
        };
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

class RecordingTiDbPool implements TiDbPoolLike {
  readonly clientQueries: Array<{ sql: string; values: readonly unknown[] }> = [];
  async getConnection(): Promise<TiDbClientLike> {
    return {
      execute: async (sql, values = []) => {
        this.clientQueries.push({ sql, values });
        return [{
          affectedRows: 1,
          ...(sql === "UPDATE run_event_sequences SET next_seq = LAST_INSERT_ID(next_seq + 1) WHERE run_id = ?"
            ? { insertId: 9 }
            : {}),
        }, []];
      },
      query: async (sql, values = []) => {
        this.clientQueries.push({ sql, values });
        return [{ affectedRows: 0 }, []];
      },
      release: () => undefined,
    };
  }
  async query(): Promise<[unknown, unknown]> { return [{ affectedRows: 0 }, []]; }
  async end(): Promise<void> {}
}
