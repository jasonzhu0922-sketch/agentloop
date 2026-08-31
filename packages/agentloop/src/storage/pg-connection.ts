import { AsyncLocalStorage } from "node:async_hooks";
import type { SqlConnection, SqlDialect, SqlRunResult, SqlStatement, SqlValue } from "./connection.ts";

/**
 * Minimal structural surface of the `pg` driver we rely on. The dependency is
 * loaded lazily so hosts that stay on SQLite do not need `pg` installed.
 */
export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release?: () => void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
}

type PgPoolFactory = new (config: string | Record<string, unknown>) => PgPoolLike;

/**
 * PostgreSQL adapter implementing {@link SqlConnection} on top of a `pg` pool.
 *
 * - `?` placeholders are translated to `$n` (string literals excluded).
 * - `transaction()` pins one pooled client for its dynamic extent via
   AsyncLocalStorage, so nested statements issued anywhere inside the
   callback observe the same connection even under interleaved async runs.
 * - Transactions retry nothing and nest nothing; the kernel never nests them.
 */
export class PgConnection implements SqlConnection {
  readonly dialect: SqlDialect = "postgres";

  private readonly pool: PgPoolLike;
  private readonly transactionClient = new AsyncLocalStorage<PgClientLike>();

  private constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  /** Wraps an existing `pg`-compatible pool owned by the host application. */
  static fromPool(pool: PgPoolLike): PgConnection {
    return new PgConnection(pool);
  }

  /** Loads the `pg` driver lazily; hosts opt into PostgreSQL by installing it. */
  static async create(config: string | Record<string, unknown>): Promise<PgConnection> {
    let load;
    try {
      load = (await import("pg")) as unknown as { default?: { Pool?: PgPoolFactory }; Pool?: PgPoolFactory };
    } catch {
      throw new Error(
        "PgConnection requires the \"pg\" package. Install it next to your application: npm install pg",
      );
    }
    const Pool = load.default?.Pool ?? load.Pool;
    if (typeof Pool !== "function") {
      throw new Error("The installed \"pg\" package did not expose a usable Pool export");
    }
    return new PgConnection(new Pool(config));
  }

  async exec(sql: string): Promise<void> {
    await this.queryText(sql, []);
  }

  prepare(sql: string): SqlStatement {
    const translated = translatePlaceholders(sql);
    return {
      run: async (...params: SqlValue[]): Promise<SqlRunResult> => {
        const result = await this.queryText(translated, params);
        return { changes: result.rowCount ?? 0 };
      },
      get: async <T>(...params: SqlValue[]): Promise<T | undefined> => {
        const result = await this.queryText(translated, params);
        return result.rows[0] as T | undefined;
      },
      all: async <T>(...params: SqlValue[]): Promise<T[]> =>
        await this.queryText(translated, params).then((result) => result.rows as T[]),
    };
  }

  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    const outerClient = this.transactionClient.getStore();
    // Nested transaction requests join the active one (the kernel never relies
    // on partial rollback of an inner block).
    if (outerClient !== undefined) return await operation();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      return await this.transactionClient.run(client, async () => {
        const result = await operation();
        await client.query("COMMIT");
        return result;
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // connection already broken; releasing below still returns it/pool handles discard
      }
      throw error;
    } finally {
      client.release?.();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private queryText(sql: string, params: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> {
    const client = this.transactionClient.getStore();
    if (params.length === 0) {
      if (client !== undefined) return client.query(sql);
      return this.pool.query(sql);
    }
    const values = params.map(toPgValue);
    if (client !== undefined) return client.query(sql, values);
    return this.pool.query(sql, values);
  }
}

/**
 * Rewrites SQLite-style `?` placeholders into PostgreSQL `$n`. Question marks
 * inside single-quoted string literals (with '' escapes) and double-quoted
 * identifiers are left untouched.
 */
export function translatePlaceholders(sql: string): string {
  let output = "";
  let index = 0;
  let param = 0;
  while (index < sql.length) {
    const character = sql[index]!;
    if (character === "'") {
      const end = skipQuoted(sql, index, "'", "'");
      output += sql.slice(index, end);
      index = end;
      continue;
    }
    if (character === '"') {
      const end = skipQuoted(sql, index, '"', '"');
      output += sql.slice(index, end);
      index = end;
      continue;
    }
    if (character === "?" && sql[index + 1] !== "?") {
      param += 1;
      output += `$${param}`;
      index += 1;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

function skipQuoted(sql: string, start: number, open: string, close: string): number {
  let index = start + open.length;
  while (index < sql.length) {
    if (sql.startsWith(close, index)) {
      if (open === "'" && sql.startsWith("''", index + close.length)) {
        index += 2;
        continue;
      }
      return index + close.length;
    }
    index += 1;
  }
  return sql.length;
}

function toPgValue(value: unknown): unknown {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value);
  return value;
}
