import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "../src/storage/database.ts";
import { PgConnection, translatePlaceholders } from "../src/storage/pg-connection.ts";
import type { PgClientLike, PgPoolLike } from "../src/storage/pg-connection.ts";
import type { SqlConnection, SqlRunResult, SqlStatement, SqlValue } from "../src/storage/connection.ts";

test("AppDatabase.open accepts an injected async connection and waits for schema creation", async () => {
  const connection = new RecordingConnection("postgres");
  const database = await AppDatabase.open({ connection });
  try {
    assert.equal(database.dialect, "postgres");
    assert.equal(connection.execSql.length, 2);
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
    assert.deepEqual(connection.calls.map((call) => call.kind), ["exec", "exec", "get"]);
  } finally {
    await database.close();
  }
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

class RecordingConnection implements SqlConnection {
  readonly execSql: string[] = [];
  readonly calls: Array<{ kind: "exec" | "run" | "get" | "all"; sql: string; params?: SqlValue[] }> = [];
  closed = false;
  readonly dialect: "sqlite" | "postgres";
  private readonly delayMs: number;

  constructor(dialect: "sqlite" | "postgres", delayMs = 0) {
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
