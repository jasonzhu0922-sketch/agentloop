import { AppDatabase, insertIfAbsentSql, type SqlConnection } from "@zhujun/agentloop";
import { installHostDispatchSchema } from "./host-dispatch-store.ts";
import { installRuntimeConfigurationSnapshotCache, installRuntimeConfigurationSnapshotHistory } from "./runtime-configuration-snapshot-cache.ts";
import { applyVersionedMigrations, SchemaMigrationError, type SchemaMigration } from "../../shared/persistence/schema-migration-ledger.ts";

const MIGRATIONS: readonly SchemaMigration[] = [
  { id: "runtime/0001_agentloop_kernel", definition: "agentloop-kernel-canonical-schema;legacy-sqlite-upgrades:v1", apply: async (database) => {
    if (!(database instanceof AppDatabase)) throw new SchemaMigrationError("Runtime kernel migration requires an AppDatabase facade");
    await database.installKernelSchema();
  } },
  { id: "runtime/0002_host_dispatch_ledger", definition: "host-dispatch-ledger;run-executor-ownership:v1", apply: installHostDispatchSchema },
  { id: "runtime/0003_preserve_source_state_compatibility", definition: "repair-boundaries;recovery-leases;assessment-bindings;delivery-receipts:v1", apply: installSourceCompatibilityColumns },
  { id: "runtime/0004_run_event_sequences", definition: "per-run-event-sequence;concurrent-runtime-writers:v1", apply: installRunEventSequences },
  { id: "runtime/0005_loaded_configuration_snapshot_cache", definition: "loaded-runtime-configuration-snapshot-cache:v1", apply: installRuntimeConfigurationSnapshotCache },
  { id: "runtime/0006_loaded_configuration_snapshot_history", definition: "loaded-runtime-configuration-snapshot-history:v1", apply: installRuntimeConfigurationSnapshotHistory },
  { id: "runtime/0007_scope_id_columns", definition: "runtime-configuration-snapshot-tenant-id-to-scope-id:v1", apply: installRuntimeConfigurationScopeRename },
];

export async function migrateRuntimeState(database: SqlConnection): Promise<void> {
  await applyVersionedMigrations(database, "runtime", MIGRATIONS);
}

/** Keeps pre-scope Host caches readable without introducing a compatibility field in the contract. */
async function installRuntimeConfigurationScopeRename(database: SqlConnection): Promise<void> {
  for (const table of ["mr_runtime_configuration_snapshots", "mr_runtime_configuration_snapshot_history"]) {
    const hasLegacy = await hasColumn(database, table, "tenant_id");
    const hasScope = await hasColumn(database, table, "scope_id");
    if (hasLegacy && !hasScope) await database.exec(`ALTER TABLE ${table} RENAME COLUMN tenant_id TO scope_id`);
  }
}

async function hasColumn(database: SqlConnection, table: string, column: string): Promise<boolean> {
  if (database.dialect === "sqlite") {
    const rows = await database.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    return rows.some((row) => row.name === column);
  }
  const rows = await database.prepare(`SELECT column_name FROM information_schema.columns WHERE table_schema = ${database.dialect === "tidb" ? "DATABASE()" : "current_schema()"} AND table_name = ? AND column_name = ?`).all<{ column_name: string }>(table, column);
  return rows.length > 0;
}

/** Preserves fields found in authoritative SQLite state but not yet read by this checkout. */
async function installSourceCompatibilityColumns(database: SqlConnection): Promise<void> {
  const columns = [
    ["plan_steps", "repair_boundary_json", "TEXT"],
    ["recovery_decisions", "response_schema_json", "TEXT"],
    ["run_outcomes", "delivery_receipt_json", "TEXT"],
    ["run_recovery_states", "resume_token", "TEXT"],
    ["run_recovery_states", "resume_lease_until", "BIGINT"],
    ["run_recovery_states", "resume_fence", "BIGINT"],
    ["run_recovery_states", "planning_token", "TEXT"],
    ["run_recovery_states", "planning_lease_until", "BIGINT"],
    ["run_recovery_states", "planning_fence", "BIGINT"],
    ["skill_compliance_assessments", "binding_json", "TEXT"],
    ["skill_compliance_assessments", "inspection_json", "TEXT"],
  ] as const;
  for (const [table, column, type] of columns) {
    if (database.dialect === "sqlite") {
      const existing = await database.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      if (existing.some((entry) => entry.name === column)) continue;
      await database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } else {
      const tidbType = type === "TEXT" ? "LONGTEXT" : type;
      await database.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${database.dialect === "tidb" ? tidbType : type}`);
    }
  }
}

/** Establishes a per-Run allocation row before concurrent Runtime writers append events. */
async function installRunEventSequences(database: SqlConnection): Promise<void> {
  const sqliteAndPostgresSchema = `
    CREATE TABLE IF NOT EXISTS run_event_sequences (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      next_seq INTEGER NOT NULL
    )
  `;
  const tidbSchema = `
    CREATE TABLE IF NOT EXISTS run_event_sequences (
      run_id VARCHAR(191) PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      next_seq BIGINT NOT NULL
    )
  `;
  await database.exec(database.dialect === "tidb" ? tidbSchema : sqliteAndPostgresSchema);
  const rows = await database.prepare(`
    SELECT run_id, COALESCE(MAX(seq), 0) + 1 AS next_seq
    FROM run_events
    GROUP BY run_id
  `).all<{ run_id: string; next_seq: number }>();
  for (const row of rows) {
    await database.prepare(insertIfAbsentSql({
      dialect: database.dialect,
      insert: "INSERT INTO run_event_sequences(run_id, next_seq) VALUES (?, ?)",
      keyColumn: "run_id",
    })).run(row.run_id, row.next_seq);
  }
}
