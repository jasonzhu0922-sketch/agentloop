import { AsyncLocalStorage } from "node:async_hooks";
import type { SqlConnection, SqlDialect, SqlRunResult, SqlStatement, SqlValue } from "./connection.ts";

/** Minimal `mysql2/promise` surface used by the optional TiDB driver. */
export interface TiDbClientLike {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
  query(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
  release(): void;
}

export interface TiDbPoolLike {
  getConnection(): Promise<TiDbClientLike>;
  query(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

type TiDbPoolFactory = { createPool(config: string | Record<string, unknown>): TiDbPoolLike };

/**
 * TiDB/MySQL wire-protocol adapter. It executes supplied SQL verbatim:
 * schema migrations and repositories own dialect selection, never transport.
 */
export class TiDbConnection implements SqlConnection {
  readonly dialect: SqlDialect = "tidb";
  private readonly pool: TiDbPoolLike;
  private readonly transactionClient = new AsyncLocalStorage<TiDbClientLike>();

  private constructor(pool: TiDbPoolLike) { this.pool = pool; }

  static fromPool(pool: TiDbPoolLike): TiDbConnection { return new TiDbConnection(pool); }

  static async create(config: string | Record<string, unknown>): Promise<TiDbConnection> {
    let loaded: { default?: TiDbPoolFactory; createPool?: TiDbPoolFactory["createPool"] };
    try { loaded = await import("mysql2/promise") as typeof loaded; } catch {
      throw new Error('TiDbConnection requires the "mysql2" package. Install it next to your application: npm install mysql2');
    }
    const createPool = loaded.default?.createPool ?? loaded.createPool;
    if (typeof createPool !== "function") throw new Error('The installed "mysql2" package did not expose createPool');
    return new TiDbConnection(createPool(config));
  }

  async exec(sql: string): Promise<void> {
    for (const statement of splitSqlStatements(sql)) await this.query(statement, []);
  }

  prepare(sql: string): SqlStatement {
    return {
      run: async (...params: SqlValue[]): Promise<SqlRunResult> => {
        const [result] = await this.query(sql, params);
        const row = result as { affectedRows?: number; insertId?: number };
        return { changes: row.affectedRows ?? 0, ...(row.insertId === undefined ? {} : { lastInsertRowid: row.insertId }) };
      },
      get: async <T>(...params: SqlValue[]): Promise<T | undefined> => {
        const [result] = await this.query(sql, params);
        return Array.isArray(result) ? result[0] as T | undefined : undefined;
      },
      all: async <T>(...params: SqlValue[]): Promise<T[]> => {
        const [result] = await this.query(sql, params);
        return Array.isArray(result) ? result as T[] : [];
      },
    };
  }

  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.transactionClient.getStore() !== undefined) return await operation();
    const client = await this.pool.getConnection();
    try {
      await client.query("START TRANSACTION");
      return await this.transactionClient.run(client, async () => {
        const result = await operation();
        await client.query("COMMIT");
        return result;
      });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* pool handles failed connections */ }
      throw error;
    } finally { client.release(); }
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async query(sql: string, values: readonly unknown[]): Promise<[unknown, unknown]> {
    const client = this.transactionClient.getStore();
    if (client !== undefined) return await client.execute(sql, values);
    return await this.pool.query(sql, values);
  }
}

/** Splits DDL batches without enabling MySQL's unsafe multiple-statements mode. */
export function splitSqlStatements(sql: string): readonly string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (quote !== undefined) {
      if (character === quote) {
        if (quote === "'" && sql[index + 1] === "'") { index += 1; continue; }
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character === ";") {
      const statement = sql.slice(start, index).trim();
      if (statement.length > 0) statements.push(statement);
      start = index + 1;
    }
  }
  const finalStatement = sql.slice(start).trim();
  if (finalStatement.length > 0) statements.push(finalStatement);
  return statements;
}
