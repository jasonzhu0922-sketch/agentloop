import type { SqlConnection } from "./connection.ts";

/** Serializes PostgreSQL schema upgrades without locking migrated business tables. */
export async function ensurePostgresBigIntMigration(
  connection: SqlConnection,
  version: string,
  columns: readonly (readonly [string, string])[],
): Promise<void> {
  await runPostgresBigIntMigration(connection, version, columns);
}

/** Creates a component schema and records its migration under one lock/transaction. */
export async function initializePostgresSchema(
  connection: SqlConnection,
  canonicalDdl: string,
  version: string,
  columns: readonly (readonly [string, string])[],
): Promise<void> {
  await runPostgresBigIntMigration(connection, version, columns, canonicalDdl);
}

async function runPostgresBigIntMigration(
  connection: SqlConnection,
  version: string,
  columns: readonly (readonly [string, string])[],
  canonicalDdl?: string,
): Promise<void> {
  if (connection.dialect !== "postgres") return;
  for (const identifier of [version, ...columns.flat()]) {
    if (!/^[a-z][a-z0-9_]*$/u.test(identifier)) throw new TypeError(`Invalid schema identifier: ${identifier}`);
  }
  await connection.transaction(async () => {
    await connection.exec("SET LOCAL lock_timeout = '5s'");
    await connection.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))")
      .get("agentloop:postgres-schema-migrations:v1");
    if (canonicalDdl !== undefined) await connection.exec(canonicalDdl);
    await connection.exec(`CREATE TABLE IF NOT EXISTS agentloop_schema_migrations (
      version TEXT PRIMARY KEY, completed_at BIGINT NOT NULL
    )`);
    const completed = await connection.prepare(
      "SELECT version FROM agentloop_schema_migrations WHERE version = ?",
    ).get(version);
    if (completed !== undefined) return;
    for (const [table, column] of columns) {
      const row = await connection.prepare(`
        SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?
      `).get(table, column) as { data_type: string } | undefined;
      if (row === undefined) throw new Error(`Missing PostgreSQL migration column ${table}.${column}`);
      if (row.data_type === "bigint") continue;
      if (row.data_type !== "integer" && row.data_type !== "smallint") {
        throw new Error(`Cannot migrate ${table}.${column} from ${row.data_type} to BIGINT`);
      }
      await connection.exec(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE BIGINT USING ${column}::BIGINT`);
    }
    await connection.prepare(
      "INSERT INTO agentloop_schema_migrations(version, completed_at) VALUES (?, ?)",
    ).run(version, Date.now());
  });
}
