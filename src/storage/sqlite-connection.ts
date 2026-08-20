import { DatabaseSync } from "node:sqlite";
import type { SqlConnection, SqlStatement } from "./connection.ts";

/** SQLite adapter over the `node:sqlite` built-in, synchronous and single-process. */
export class SqliteConnection implements SqlConnection {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    return this.database.prepare(sql) as unknown as SqlStatement;
  }

  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}