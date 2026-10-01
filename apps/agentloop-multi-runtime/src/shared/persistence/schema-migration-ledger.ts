import { createHash } from "node:crypto";
import type { SqlConnection } from "@zhujun/agentloop";

export type MultiRuntimeSchemaRole = "router" | "runtime";

export class SchemaMigrationError extends Error {
  constructor(message: string) { super(message); this.name = "SchemaMigrationError"; }
}

export interface SchemaMigration {
  readonly id: string;
  readonly definition: string;
  readonly apply: (database: SqlConnection) => Promise<void>;
}

export async function applyVersionedMigrations(
  database: SqlConnection,
  role: MultiRuntimeSchemaRole,
  migrations: readonly SchemaMigration[],
): Promise<void> {
  await database.exec(migrationLedgerSql(database));
  await withMigrationLock(database, role, async () => {
    const compatibilitySql = migrationLedgerCompatibilitySql(database);
    if (compatibilitySql !== undefined) await database.exec(compatibilitySql);
    for (const migration of migrations) {
      const checksum = checksumFor(migration);
      const applied = await database.prepare(migrationLedgerEntrySql(database)).get<{ checksum: string }>(migration.id);
      if (applied !== undefined) {
        if (applied.checksum !== checksum) throw new SchemaMigrationError(`Migration checksum mismatch for ${migration.id}; refusing to run against an unknown schema history`);
        continue;
      }
      await migration.apply(database);
      // The advisory/transaction lock above serializes migration writers for
      // every supported backend. Retrying an INSERT error by querying inside a
      // PostgreSQL transaction would only hide its original cause because the
      // transaction has already been aborted.
      await database.prepare("INSERT INTO mr_schema_migrations(id, checksum, applied_at) VALUES (?, ?, ?)").run(migration.id, checksum, Date.now());
    }
    await widenPostgresEpochMillisecondColumns(database);
  });
}

async function withMigrationLock(database: SqlConnection, role: MultiRuntimeSchemaRole, operation: () => Promise<void>): Promise<void> {
  const lockName = `agentloop:${role}:schema`;
  if (database.dialect === "sqlite") return await database.transaction(operation);
  if (database.dialect === "postgres") {
    return await database.transaction(async () => {
      await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(lockName);
      await operation();
    });
  }
  return await database.transaction(async () => {
    const acquired = await database.prepare("SELECT GET_LOCK(?, 60) AS acquired").get<{ acquired: number | string | null }>(lockName);
    if (Number(acquired?.acquired) !== 1) throw new SchemaMigrationError(`Timed out acquiring TiDB migration lock for ${role}`);
    try { await operation(); } finally { await database.prepare("SELECT RELEASE_LOCK(?)").get(lockName); }
  });
}

export function migrationLedgerSql(database: Pick<SqlConnection, "dialect">): string {
  return database.dialect === "tidb"
    ? "CREATE TABLE IF NOT EXISTS mr_schema_migrations (id VARCHAR(191) PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at BIGINT NOT NULL)"
    : database.dialect === "postgres"
      ? "CREATE TABLE IF NOT EXISTS mr_schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL)"
      : "CREATE TABLE IF NOT EXISTS mr_schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)";
}

/** TiDB locking reads bypass a stale repeatable-read snapshot after GET_LOCK. */
export function migrationLedgerEntrySql(database: Pick<SqlConnection, "dialect">): string {
  return database.dialect === "tidb"
    ? "SELECT checksum FROM mr_schema_migrations WHERE id = ? FOR UPDATE"
    : "SELECT checksum FROM mr_schema_migrations WHERE id = ?";
}

/** Repairs the original PostgreSQL ledger, whose INTEGER timestamp overflowed at millisecond precision. */
export function migrationLedgerCompatibilitySql(database: Pick<SqlConnection, "dialect">): string | undefined {
  return database.dialect === "postgres"
    ? "ALTER TABLE mr_schema_migrations ALTER COLUMN applied_at TYPE BIGINT"
    : undefined;
}

/** Epoch-millisecond fields cannot use PostgreSQL's 32-bit INTEGER type. */
export function isEpochMillisecondColumn(column: string): boolean {
  return column === "connection_epoch" || column.endsWith("_at") || column.endsWith("_until");
}

async function widenPostgresEpochMillisecondColumns(database: SqlConnection): Promise<void> {
  if (database.dialect !== "postgres") return;
  const columns = await database.prepare(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND data_type = 'integer'
  `).all<{ table_name: string; column_name: string }>();
  for (const column of columns) {
    if (!isEpochMillisecondColumn(column.column_name)) continue;
    await database.exec(
      `ALTER TABLE ${quoteIdentifier(column.table_name)} ALTER COLUMN ${quoteIdentifier(column.column_name)} TYPE BIGINT`,
    );
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function checksumFor(migration: SchemaMigration): string {
  return createHash("sha256").update(`${migration.id}\n${migration.definition}`).digest("hex");
}
