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

type TiDbPoolFactory = {
  createPool(config: string | Record<string, unknown>): TiDbPoolLike;
};

/**
 * TiDB/MySQL connection adapter. It is intentionally a separate dialect from
 * PostgreSQL: both statement selection and migration ownership remain
 * explicit above this transport layer.
 */
export class TiDbConnection implements SqlConnection {
  readonly dialect: SqlDialect = "tidb";

  private readonly pool: TiDbPoolLike;
  private readonly transactionClient = new AsyncLocalStorage<TiDbClientLike>();

  private constructor(pool: TiDbPoolLike) {
    this.pool = pool;
  }

  static fromPool(pool: TiDbPoolLike): TiDbConnection {
    return new TiDbConnection(pool);
  }

  /** Loads mysql2 only for deployments which select AGENTLOOP_STATE_DRIVER=tidb. */
  static async create(config: string | Record<string, unknown>): Promise<TiDbConnection> {
    const moduleName = "mysql2/promise";
    let loaded: { default?: TiDbPoolFactory; createPool?: TiDbPoolFactory["createPool"] };
    try {
      loaded = await import(moduleName) as typeof loaded;
    } catch {
      throw new Error('TiDbConnection requires the "mysql2" package. Install it next to your application: npm install mysql2');
    }
    const createPool = loaded.default?.createPool ?? loaded.createPool;
    if (typeof createPool !== "function") throw new Error('The installed "mysql2" package did not expose createPool');
    return new TiDbConnection(createPool(config));
  }

  async exec(sql: string): Promise<void> {
    for (const statement of splitSqlStatements(sql)) {
      await this.query(translateTiDbSql(statement), []);
    }
  }

  prepare(sql: string): SqlStatement {
    const translated = translateTiDbSql(sql);
    return {
      run: async (...params: SqlValue[]): Promise<SqlRunResult> => {
        const [result] = await this.query(translated, params);
        const row = result as { affectedRows?: number; insertId?: number };
        return {
          changes: row.affectedRows ?? 0,
          ...(row.insertId === undefined ? {} : { lastInsertRowid: row.insertId }),
        };
      },
      get: async <T>(...params: SqlValue[]): Promise<T | undefined> => {
        const [result] = await this.query(translated, params);
        return Array.isArray(result) ? result[0] as T | undefined : undefined;
      },
      all: async <T>(...params: SqlValue[]): Promise<T[]> => {
        const [result] = await this.query(translated, params);
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
      try { await client.query("ROLLBACK"); } catch { /* connection failure is handled by the pool */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

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

/**
 * Converts the portable SQLite/PostgreSQL conflict subset used by AgentLoop to
 * TiDB's MySQL form. Repository code must still select an explicit statement
 * where conflict eligibility itself is part of business semantics.
 */
export function translateTiDbSql(sql: string): string {
  const doNothing = /ON\s+CONFLICT\s*(?:\(([^)]+)\))?\s+DO\s+NOTHING/gi;
  const withNoop = sql.replace(doNothing, (_match, conflictColumns: string | undefined) => {
    const column = conflictColumns?.split(",")[0]?.trim() ?? firstInsertColumn(sql);
    if (column === undefined) throw new Error("TiDB upsert requires an explicit conflict or insert column");
    return `ON DUPLICATE KEY UPDATE ${column} = ${column}`;
  });
  return withNoop
    .replace(/ON\s+CONFLICT\s*(?:\([^)]+\))?\s+DO\s+UPDATE\s+SET/gi, "ON DUPLICATE KEY UPDATE")
    .replace(/\bexcluded\.([A-Za-z_][A-Za-z0-9_]*)/g, "VALUES($1)");
}

function firstInsertColumn(sql: string): string | undefined {
  const match = sql.match(/INSERT\s+INTO\s+[^\s(]+\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/i);
  return match?.[1];
}
