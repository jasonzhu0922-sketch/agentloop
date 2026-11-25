import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { SqlConnection, SqlDialect, SqlRunResult, SqlStatement, SqlValue } from "./connection.ts";
import {
  currentRuntimePerformanceContext,
  runtimePerformanceInstant,
  runtimePerformanceSpan,
  withRuntimePerformanceContext,
} from "../diagnostics/runtime-performance.ts";

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
  private readonly environment: Readonly<Record<string, unknown>>;
  private readonly transactionClient = new AsyncLocalStorage<TiDbClientLike>();

  private constructor(pool: TiDbPoolLike, environment: Readonly<Record<string, unknown>> = {}) {
    this.pool = pool;
    this.environment = environment;
  }

  static fromPool(pool: TiDbPoolLike): TiDbConnection { return new TiDbConnection(pool); }

  static async create(config: string | Record<string, unknown>): Promise<TiDbConnection> {
    let loaded: { default?: TiDbPoolFactory; createPool?: TiDbPoolFactory["createPool"] };
    try { loaded = await import("mysql2/promise") as typeof loaded; } catch {
      throw new Error('TiDbConnection requires the "mysql2" package. Install it next to your application: npm install mysql2');
    }
    const createPool = loaded.default?.createPool ?? loaded.createPool;
    if (typeof createPool !== "function") throw new Error('The installed "mysql2" package did not expose createPool');
    return new TiDbConnection(createPool(config), sanitizedTiDbEnvironment(config));
  }

  diagnosticEnvironment(): Readonly<Record<string, unknown>> { return this.environment; }

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
    if (this.transactionClient.getStore() !== undefined) {
      runtimePerformanceInstant("db.transaction.reused", { category: "database", nested: true });
      return await operation();
    }
    const transactionId = randomUUID();
    return await withRuntimePerformanceContext({ transactionId }, async () =>
      await runtimePerformanceSpan("db.transaction", { category: "database", dialect: this.dialect }, async () => {
        const client = await runtimePerformanceSpan("db.pool.get_connection", { category: "database" },
          async () => await this.pool.getConnection());
        let rollbackAttempted = false;
        try {
          await runtimePerformanceSpan("db.transaction.start", { category: "database" },
            async () => { await client.query("START TRANSACTION"); });
          return await this.transactionClient.run(client, async () => {
            try {
              const result = await operation();
              await runtimePerformanceSpan("db.transaction.commit", { category: "database" },
                async () => { await client.query("COMMIT"); });
              return result;
            } catch (error) {
              rollbackAttempted = true;
              try {
                await runtimePerformanceSpan("db.transaction.rollback", { category: "database" },
                  async () => { await client.query("ROLLBACK"); });
              } catch { /* pool handles failed connections */ }
              throw error;
            }
          });
        } catch (error) {
          // Preserve the pre-diagnostics cleanup contract even when START
          // TRANSACTION itself fails before AsyncLocalStorage is entered.
          if (!rollbackAttempted) {
            try {
              await runtimePerformanceSpan("db.transaction.rollback", { category: "database" },
                async () => { await client.query("ROLLBACK"); });
            } catch { /* pool handles failed connections */ }
          }
          throw error;
        } finally { client.release(); }
      }),
    );
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async query(sql: string, values: readonly unknown[]): Promise<[unknown, unknown]> {
    const client = this.transactionClient.getStore();
    const attributes = {
      category: "database",
      sqlOperation: sqlOperation(sql),
      sqlTemplate: normalizeSqlTemplate(sql),
      clientElapsedSemantics: "client_round_trip_including_driver_and_network_not_server_execution",
      inTransaction: client !== undefined,
      ...(currentRuntimePerformanceContext()?.transactionId === undefined ? {} : { transactionId: currentRuntimePerformanceContext()!.transactionId }),
    };
    if (client !== undefined) {
      return await runtimePerformanceSpan("db.sql.client", attributes, async () => await client.execute(sql, values));
    }
    const pooledClient = await runtimePerformanceSpan("db.pool.get_connection", { category: "database", transaction: false },
      async () => await this.pool.getConnection());
    try {
      return await runtimePerformanceSpan("db.sql.client", attributes, async () => await pooledClient.query(sql, values));
    } finally { pooledClient.release(); }
  }
}

export function normalizeSqlTemplate(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/gu, "?")
    .replace(/\b(?:0x[0-9a-f]+|\d+(?:\.\d+)?)\b/giu, "?")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

function sqlOperation(sql: string): string {
  return /^\s*([a-z]+)/iu.exec(sql)?.[1]?.toUpperCase() ?? "UNKNOWN";
}

function sanitizedTiDbEnvironment(config: string | Record<string, unknown>): Readonly<Record<string, unknown>> {
  try {
    if (typeof config === "string") {
      const url = new URL(config);
      return { endpoint: `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`, database: url.pathname.replace(/^\//u, "") || undefined };
    }
    const host = typeof config.host === "string" ? config.host : undefined;
    const port = typeof config.port === "number" || typeof config.port === "string" ? String(config.port) : undefined;
    const database = typeof config.database === "string" ? config.database : undefined;
    return { ...(host === undefined ? {} : { endpoint: `${host}${port === undefined ? "" : `:${port}`}` }), ...(database === undefined ? {} : { database }) };
  } catch { return {}; }
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
