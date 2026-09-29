import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "../src/storage/database.ts";
import { PgConnection, configurePgInt8Parser, parsePgInt8, pgPoolConfig, translatePlaceholders } from "../src/storage/pg-connection.ts";
import type { PgClientLike, PgPoolLike } from "../src/storage/pg-connection.ts";
import { TiDbConnection, splitSqlStatements } from "../src/storage/tidb-connection.ts";
import { TIDB_IDENTITY_SCHEMA_SQL, TIDB_KERNEL_SCHEMA_SQL } from "../src/storage/tidb-schema-definitions.ts";
import { insertIfAbsentSql, upsertSql } from "../src/storage/dialect-sql.ts";
import type { TiDbClientLike, TiDbPoolLike } from "../src/storage/tidb-connection.ts";
import type { SqlConnection, SqlRunResult, SqlStatement, SqlValue } from "../src/storage/connection.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { RunRepository } from "../src/storage/repositories/run-repository.ts";
import { appendRunEvent } from "../src/storage/repositories/run-event-sequencer.ts";

test("AppDatabase.open accepts an injected async connection and waits for schema creation", async () => {
  const connection = new RecordingConnection("postgres");
  const database = await AppDatabase.open({ connection });
  try {
    assert.equal(database.dialect, "postgres");
    assert.equal(connection.execSql.length, 3);
    const schema = connection.execSql[0] ?? "";
    assert.ok(schema.includes("CREATE TABLE IF NOT EXISTS discovered_skills"));
    assert.ok(
      schema.indexOf("CREATE TABLE IF NOT EXISTS plans") < schema.indexOf("CREATE TABLE IF NOT EXISTS runtime_actions"),
      "plans must exist before runtime_actions references it on PostgreSQL",
    );
    assert.ok(!schema.includes("PRAGMA"), "portable schema creation must not include SQLite PRAGMAs");
  } finally {
    await database.close();
  }
});

test("AppDatabase operations wait for injected connection migration", async () => {
  const connection = new RecordingConnection("postgres", 5);
  const database = new AppDatabase({ connection });
  try {
    await database.prepare("SELECT ? AS value").get("ready");
    assert.deepEqual(connection.calls.map((call) => call.kind), ["exec", "exec", "exec", "get"]);
  } finally {
    await database.close();
  }
});

test("Run event allocation repairs a stale retained counter before continuing the shared per-Run sequence", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const runs = new RunRepository(database);
    await runs.insertRun({
      id: "run-event-sequence",
      ownerUserId: "owner",
      allowDangerousTools: false,
      input: "test",
      createdAt: 1,
    });
    await database.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("run-event-sequence", 7, "legacy.event", "{}", 1);
    await database.prepare(`
      INSERT INTO run_event_sequences(run_id, next_seq)
      VALUES (?, ?)
    `).run("run-event-sequence", 1);

    const first = await runs.appendEvent("run-event-sequence", {
      type: "new.event",
      data: { source: "repository" },
      createdAt: 2,
    });
    const second = await runs.appendEvent("run-event-sequence", {
      type: "next.event",
      data: { source: "repository" },
      createdAt: 3,
    });
    assert.deepEqual([first, second], [8, 9]);
    const sequence = await database.prepare(
      "SELECT next_seq FROM run_event_sequences WHERE run_id = ?",
    ).get<{ next_seq: number }>("run-event-sequence");
    assert.equal(sequence?.next_seq, 10);
  } finally {
    await database.close();
  }
});

test("TiDB event allocation uses its pinned session value after atomically incrementing the counter", async () => {
  const connection = new SequenceRecordingConnection();
  const sequence = await appendRunEvent(connection, "run-event-sequence", {
    type: "event",
    data: {},
    createdAt: 1,
  });

  assert.equal(sequence, 8);
  assert.ok(connection.calls.some((call) => call.sql.includes("ON DUPLICATE KEY UPDATE next_seq = GREATEST(next_seq, VALUES(next_seq))")));
  assert.ok(connection.calls.some((call) => call.sql === "UPDATE run_event_sequences SET next_seq = LAST_INSERT_ID(next_seq + 1) WHERE run_id = ?"));
  assert.ok(connection.calls.some((call) => call.sql === "SELECT LAST_INSERT_ID() - 1 AS seq"));
});

test("PgConnection translates placeholders, uses simple query for empty params, and pins transactions", async () => {
  const pool = new RecordingPgPool();
  const connection = PgConnection.fromPool(pool);

  await connection.exec("CREATE TABLE demo(id text); CREATE INDEX demo_idx ON demo(id)");
  assert.deepEqual(pool.poolQueries[0], {
    text: "CREATE TABLE demo(id text); CREATE INDEX demo_idx ON demo(id)",
    values: undefined,
  });

  await connection.prepare("SELECT '?' AS literal, ? AS value, \"?\" AS ident").get("actual");
  assert.deepEqual(pool.poolQueries[1], {
    text: "SELECT '?' AS literal, $1 AS value, \"?\" AS ident",
    values: ["actual"],
  });

  await connection.prepare("INSERT INTO blobs(data) VALUES (?)").run(new Uint8Array([1, 2, 3]));
  assert.ok(Buffer.isBuffer(pool.poolQueries[2]?.values?.[0]));

  await connection.transaction(async () => {
    await connection.prepare("SELECT ? AS in_tx").all("tx");
  });
  assert.deepEqual(pool.clientQueries.map((query) => query.text), ["BEGIN", "SELECT $1 AS in_tx", "COMMIT"]);
  assert.deepEqual(pool.clientQueries[1]?.values, ["tx"]);
  assert.equal(pool.released, 1);
});

test("translatePlaceholders skips quoted literals and identifiers", () => {
  assert.equal(
    translatePlaceholders("SELECT '?', \"?\", ? FROM demo WHERE note = 'it''s ?' AND id = ?"),
    "SELECT '?', \"?\", $1 FROM demo WHERE note = 'it''s ?' AND id = $2",
  );
});

test("PgConnection passes a URI to pg as a connectionString option", () => {
  assert.deepEqual(
    pgPoolConfig("postgresql://agentloop@db/agentloop"),
    { connectionString: "postgresql://agentloop@db/agentloop" },
  );
  const options = { host: "db", database: "agentloop" };
  assert.equal(pgPoolConfig(options), options);
});

test("PgConnection normalizes safe PostgreSQL int8 values without losing unsafe values", () => {
  assert.equal(parsePgInt8("1759123456789"), 1_759_123_456_789);
  assert.equal(parsePgInt8("9007199254740992"), "9007199254740992");
  let oid: number | undefined;
  let parser: ((value: string) => unknown) | undefined;
  configurePgInt8Parser({ setTypeParser(nextOid, nextParser) { oid = nextOid; parser = nextParser; } });
  assert.equal(oid, 20);
  assert.equal(parser?.("1759123456789"), 1_759_123_456_789);
});

test("AppDatabase accepts TiDB as an independent non-SQLite dialect", async () => {
  const connection = new RecordingConnection("tidb");
  const database = await AppDatabase.open({ connection });
  try {
    assert.equal(database.dialect, "tidb");
    assert.ok(connection.execSql.every((sql) => !sql.includes("PRAGMA")));
    assert.match(connection.execSql[0] ?? "", /id VARCHAR\(191\) PRIMARY KEY/);
    assert.match(connection.execSql[0] ?? "", /instructions LONGTEXT NOT NULL/);
  } finally {
    await database.close();
  }
});

test("SkillService selects portable SQL Skill storage for TiDB", () => {
  assert.doesNotThrow(() => new SkillService(new RecordingConnection("tidb")));
});

test("repositories select conflict semantics before SQL reaches a connection", () => {
  assert.equal(
    insertIfAbsentSql({ dialect: "tidb", insert: "INSERT INTO event_sequences(run_id) VALUES (?)", keyColumn: "run_id" }),
    "INSERT INTO event_sequences(run_id) VALUES (?) ON DUPLICATE KEY UPDATE run_id = run_id",
  );
  assert.equal(
    upsertSql({
      dialect: "postgres",
      insert: "INSERT INTO recovery(run_id, state) VALUES (?, ?)",
      conflictTarget: "run_id",
      sqliteAndPostgresUpdate: "state = excluded.state",
      tidbUpdate: "state = VALUES(state)",
    }),
    "INSERT INTO recovery(run_id, state) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET state = excluded.state",
  );
  assert.equal(
    upsertSql({
      dialect: "tidb",
      insert: "INSERT INTO recovery(run_id, state) VALUES (?, ?)",
      conflictTarget: "run_id",
      sqliteAndPostgresUpdate: "state = excluded.state",
      tidbUpdate: "state = VALUES(state)",
    }),
    "INSERT INTO recovery(run_id, state) VALUES (?, ?) ON DUPLICATE KEY UPDATE state = VALUES(state)",
  );
});

test("TiDB adapter keeps question-mark binding, pins transactions, and never rewrites SQL", async () => {
  const pool = new RecordingTiDbPool();
  const connection = TiDbConnection.fromPool(pool);
  await connection.exec("CREATE TABLE demo(value TEXT); CREATE INDEX demo_value_idx ON demo(value)");
  assert.deepEqual(pool.poolQueries.map((query) => query.sql), ["CREATE TABLE demo(value TEXT)", "CREATE INDEX demo_value_idx ON demo(value)"]);
  await connection.prepare("SELECT ? AS value").get("bound");
  assert.deepEqual(pool.poolQueries.at(-1), { sql: "SELECT ? AS value", values: ["bound"] });
  await connection.transaction(async () => {
    await connection.prepare("UPDATE demo SET value = ?").run("next");
  });
  assert.deepEqual(pool.clientQueries.map((query) => query.sql), ["START TRANSACTION", "UPDATE demo SET value = ?", "COMMIT"]);
  assert.equal(pool.released, 1);
  assert.deepEqual(splitSqlStatements("SELECT ';'; SELECT 2;"), ["SELECT ';'", "SELECT 2"]);
  assert.match(TIDB_KERNEL_SCHEMA_SQL, /id VARCHAR\(191\) PRIMARY KEY/);
  assert.match(TIDB_KERNEL_SCHEMA_SQL, /instructions LONGTEXT NOT NULL/);
  assert.match(TIDB_IDENTITY_SCHEMA_SQL, /tenant_id VARCHAR\(191\) NOT NULL/);
  assert.match(TIDB_IDENTITY_SCHEMA_SQL, /user_id VARCHAR\(191\) NOT NULL/);
  assert.match(TIDB_KERNEL_SCHEMA_SQL, /kind LONGTEXT NOT NULL CHECK\(kind IN \('text', 'table', 'metadata'\)\)/);
  assert.doesNotMatch(TIDB_KERNEL_SCHEMA_SQL, /'LONGTEXT'/);
});

class RecordingConnection implements SqlConnection {
  readonly execSql: string[] = [];
  readonly calls: Array<{ kind: "exec" | "run" | "get" | "all"; sql: string; params?: SqlValue[] }> = [];
  closed = false;
  readonly dialect: "sqlite" | "postgres" | "tidb";
  private readonly delayMs: number;

  constructor(dialect: "sqlite" | "postgres" | "tidb", delayMs = 0) {
    this.dialect = dialect;
    this.delayMs = delayMs;
  }

  async exec(sql: string): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.execSql.push(sql);
    this.calls.push({ kind: "exec", sql });
  }

  prepare(sql: string): SqlStatement {
    return {
      run: async (...params): Promise<SqlRunResult> => {
        this.calls.push({ kind: "run", sql, params });
        return { changes: 1 };
      },
      get: async <T>(...params): Promise<T | undefined> => {
        this.calls.push({ kind: "get", sql, params });
        return undefined;
      },
      all: async <T>(...params): Promise<T[]> => {
        this.calls.push({ kind: "all", sql, params });
        return [];
      },
    };
  }

  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    return await operation();
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class SequenceRecordingConnection implements SqlConnection {
  readonly dialect = "tidb" as const;
  readonly calls: Array<{ kind: "run" | "get"; sql: string; params: readonly SqlValue[] }> = [];

  async exec(): Promise<void> {}

  prepare(sql: string): SqlStatement {
    return {
      run: async (...params): Promise<SqlRunResult> => {
        this.calls.push({ kind: "run", sql, params });
        return { changes: 1 };
      },
      get: async <T>(...params): Promise<T | undefined> => {
        this.calls.push({ kind: "get", sql, params });
        if (sql.startsWith("SELECT COALESCE(MAX(seq)")) return { next_seq: 8 } as T;
        if (sql === "SELECT LAST_INSERT_ID() - 1 AS seq") return { seq: 8 } as T;
        return undefined;
      },
      all: async <T>(): Promise<T[]> => [],
    };
  }

  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    return await operation();
  }

  async close(): Promise<void> {}
}

class RecordingPgPool implements PgPoolLike {
  readonly poolQueries: Array<{ text: string; values?: unknown[] }> = [];
  readonly clientQueries: Array<{ text: string; values?: unknown[] }> = [];
  released = 0;

  async connect(): Promise<PgClientLike> {
    return {
      query: async (text, values) => {
        this.clientQueries.push({ text, values });
        return { rows: [], rowCount: 0 };
      },
      release: () => {
        this.released += 1;
      },
    };
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> {
    this.poolQueries.push({ text, values });
    return { rows: [], rowCount: 0 };
  }

  async end(): Promise<void> {}
}

class RecordingTiDbPool implements TiDbPoolLike {
  readonly poolQueries: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly clientQueries: Array<{ sql: string; values: readonly unknown[] }> = [];
  released = 0;

  async getConnection(): Promise<TiDbClientLike> {
    return {
      execute: async (sql, values = []) => {
        this.clientQueries.push({ sql, values });
        return [{ affectedRows: 1 }, []];
      },
      query: async (sql, values = []) => {
        this.clientQueries.push({ sql, values });
        return [{ affectedRows: 0 }, []];
      },
      release: () => { this.released += 1; },
    };
  }

  async query(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    this.poolQueries.push({ sql, values });
    return sql.startsWith("SELECT") ? [[{ value: values[0] }], []] : [{ affectedRows: 0 }, []];
  }

  async end(): Promise<void> {}
}
