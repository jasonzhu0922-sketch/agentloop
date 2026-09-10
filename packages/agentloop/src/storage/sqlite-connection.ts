import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import type { SqlConnection, SqlDialect, SqlRunResult, SqlStatement } from "./connection.ts";

/** SQLite adapter over the `node:sqlite` built-in with cross-process startup contention handling. */
export class SqliteConnection implements SqlConnection {
  readonly dialect: SqlDialect = "sqlite";

  private readonly database: DatabaseSync;
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private transactionQueue: Promise<void> = Promise.resolve();

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    // This must be configured before WAL mode. Router and multiple Runtime
    // Hosts can open the shared state database concurrently during startup;
    // changing journal mode otherwise fails immediately with SQLITE_BUSY.
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
  }

  async exec(sql: string): Promise<void> {
    this.database.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    const statement = this.database.prepare(sql);
    return {
      run: async (...params: unknown[]): Promise<SqlRunResult> =>
        statement.run(...(params as Parameters<typeof statement.run>)) as SqlRunResult,
      get: async <T>(...params: unknown[]): Promise<T | undefined> =>
        statement.get(...(params as Parameters<typeof statement.get>)) as T | undefined,
      all: async <T>(...params: unknown[]): Promise<T[]> =>
        statement.all(...(params as Parameters<typeof statement.all>)) as T[],
    };
  }

  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.transactionContext.getStore() === true) return await operation();
    const previous = this.transactionQueue;
    let releaseQueue!: () => void;
    this.transactionQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previous;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = await this.transactionContext.run(true, operation);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      releaseQueue();
    }
  }

  async close(): Promise<void> {
    this.database.close();
  }
}
