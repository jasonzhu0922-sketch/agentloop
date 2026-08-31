/**
 * Data-access boundary. Services and repositories depend on `SqlConnection`,
 * never on a concrete engine. The API is promise-based so both synchronous
 * engines (node:sqlite) and asynchronous ones (PostgreSQL via `pg`) satisfy
 * it without changing callers.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;

export type SqlDialect = "sqlite" | "postgres";

export interface SqlRunResult {
  /** Number of rows affected by the statement (0 for non-mutating statements). */
  readonly changes: number | bigint;
  /** Row id assigned by an INSERT when the engine exposes one. */
  readonly lastInsertRowid?: number | bigint;
}

export interface SqlStatement {
  run(...params: SqlValue[]): Promise<SqlRunResult>;
  get<T = unknown>(...params: SqlValue[]): Promise<T | undefined>;
  all<T = unknown>(...params: SqlValue[]): Promise<T[]>;
}

export interface SqlConnection {
  readonly dialect: SqlDialect;
  exec(sql: string): Promise<void>;
  prepare(sql: string): SqlStatement;
  transaction<T>(operation: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}
