import type { SqlDialect } from "./connection.ts";

/**
 * One semantic statement with one executable spelling per supported engine.
 *
 * This is deliberately selected by the repository/migration that owns the
 * operation.  It is not a transport-time SQL rewrite: a connection receives
 * exactly the SQL selected here, which makes a new dialect's behaviour
 * reviewable together with the operation's concurrency and conflict rules.
 */
export interface DialectSql {
  readonly sqlite: string;
  readonly postgres: string;
  readonly tidb: string;
}

export function sqlForDialect(dialect: SqlDialect, sql: DialectSql): string {
  return sql[dialect];
}

/** Exact spellings of an idempotent insert; callers must name its key column. */
export function insertIfAbsentSql(input: {
  readonly dialect: SqlDialect;
  readonly insert: string;
  readonly keyColumn: string;
}): string {
  return input.dialect === "tidb"
    ? `${input.insert} ON DUPLICATE KEY UPDATE ${input.keyColumn} = ${input.keyColumn}`
    : `${input.insert} ON CONFLICT(${input.keyColumn}) DO NOTHING`;
}

/** Exact spellings of an idempotent insert for any uniqueness constraint. */
export function insertIgnoreConflictsSql(input: {
  readonly dialect: SqlDialect;
  readonly insert: string;
  /** A column in the inserted row; TiDB needs an explicit no-op assignment. */
  readonly tidbNoopColumn: string;
}): string {
  return input.dialect === "tidb"
    ? `${input.insert} ON DUPLICATE KEY UPDATE ${input.tidbNoopColumn} = ${input.tidbNoopColumn}`
    : `${input.insert} ON CONFLICT DO NOTHING`;
}

/**
 * An explicit semantic upsert. `insert` contains only the INSERT and VALUES
 * clause; each backend's conflict clause is supplied by the repository that
 * owns the row invariant.  In particular, TiDB never receives PostgreSQL's
 * `excluded` pseudo-table and PostgreSQL never receives `VALUES(column)`.
 */
export function upsertSql(input: {
  readonly dialect: SqlDialect;
  readonly insert: string;
  readonly conflictTarget: string;
  readonly sqliteAndPostgresUpdate: string;
  readonly tidbUpdate: string;
}): string {
  return input.dialect === "tidb"
    ? `${input.insert} ON DUPLICATE KEY UPDATE ${input.tidbUpdate}`
    : `${input.insert} ON CONFLICT(${input.conflictTarget}) DO UPDATE SET ${input.sqliteAndPostgresUpdate}`;
}
