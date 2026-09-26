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
    for (const migration of migrations) {
      const checksum = checksumFor(migration);
      const applied = await database.prepare("SELECT checksum FROM mr_schema_migrations WHERE id = ?").get<{ checksum: string }>(migration.id);
      if (applied !== undefined) {
        if (applied.checksum !== checksum) throw new SchemaMigrationError(`Migration checksum mismatch for ${migration.id}; refusing to run against an unknown schema history`);
        continue;
      }
      await migration.apply(database);
      try {
        await database.prepare("INSERT INTO mr_schema_migrations(id, checksum, applied_at) VALUES (?, ?, ?)").run(migration.id, checksum, Date.now());
      } catch (error) {
        const concurrent = await database.prepare("SELECT checksum FROM mr_schema_migrations WHERE id = ?").get<{ checksum: string }>(migration.id);
        if (concurrent?.checksum === checksum) continue;
        throw error;
      }
    }
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

function migrationLedgerSql(database: SqlConnection): string {
  return database.dialect === "tidb"
    ? "CREATE TABLE IF NOT EXISTS mr_schema_migrations (id VARCHAR(191) PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at BIGINT NOT NULL)"
    : "CREATE TABLE IF NOT EXISTS mr_schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)";
}

function checksumFor(migration: SchemaMigration): string {
  return createHash("sha256").update(`${migration.id}\n${migration.definition}`).digest("hex");
}
