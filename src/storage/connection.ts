/**
 * Data-access boundary. Services and repositories depend on `SqlConnection`,
 * never on a concrete engine, so a future PostgreSQL deployment can swap in a
 * different adapter (e.g. one built on a `pg` pool) without touching callers.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlRunResult {
  /** Number of rows affected by the statement (0 for non-mutating statements). */
  readonly changes: number | bigint;
  /** Row id assigned by an INSERT when the engine exposes one. */
  readonly lastInsertRowid?: number | bigint;
}

export interface SqlStatement {
  run(...params: SqlValue[]): SqlRunResult;
  get<T = unknown>(...params: SqlValue[]): T | undefined;
  all<T = unknown>(...params: SqlValue[]): T[];
}

export interface SqlConnection {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  transaction<T>(operation: () => T): T;
  close(): void;
}