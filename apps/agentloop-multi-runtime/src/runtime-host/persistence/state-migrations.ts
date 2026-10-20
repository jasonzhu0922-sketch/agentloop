import { AppDatabase, insertIfAbsentSql, type SqlConnection } from "@zhujun/agentloop";
import { installHostDispatchSchema } from "./host-dispatch-store.ts";
import { applyVersionedMigrations, SchemaMigrationError, type SchemaMigration } from "../../shared/persistence/schema-migration-ledger.ts";

const MIGRATIONS: readonly SchemaMigration[] = [
  { id: "runtime/0001_agentloop_kernel", definition: "agentloop-kernel-canonical-schema;legacy-sqlite-upgrades:v1", apply: async (database) => {
    if (!(database instanceof AppDatabase)) throw new SchemaMigrationError("Runtime kernel migration requires an AppDatabase facade");
    await database.installKernelSchema();
  } },
  { id: "runtime/0002_host_dispatch_ledger", definition: "host-dispatch-ledger;run-executor-ownership:v1", apply: installHostDispatchSchema },
  { id: "runtime/0003_preserve_source_state_compatibility", definition: "repair-boundaries;recovery-leases;assessment-bindings;delivery-receipts:v1", apply: installSourceCompatibilityColumns },
  { id: "runtime/0004_run_event_sequences", definition: "per-run-event-sequence;concurrent-runtime-writers:v1", apply: installRunEventSequences },
  // 0005-0007 exist in deployed migration ledgers from configuration-snapshot releases.
  { id: "runtime/0008_canonical_run_state", definition: "canonical-run-state-tables;plan-state-reference:v1", apply: installCanonicalRunStateSchema },
  { id: "runtime/0009_result_assessment_profile", definition: "result-judgment-without-source-demand;preserve-assessment-metadata:v1", apply: async (database) => {
    if (!(database instanceof AppDatabase)) throw new SchemaMigrationError("Assessment profile migration requires an AppDatabase facade");
    await database.installAssessmentProfileSchema();
  } },
];

export async function migrateRuntimeState(database: SqlConnection): Promise<void> {
  await applyVersionedMigrations(database, "runtime", MIGRATIONS);
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

/** Adds the canonical authority tables to databases whose kernel migration is already recorded. */
async function installCanonicalRunStateSchema(database: SqlConnection): Promise<void> {
  const schema = database.dialect === "tidb"
    ? `
      CREATE TABLE IF NOT EXISTS canonical_run_states (
        run_id VARCHAR(191) PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        state_id VARCHAR(191) NOT NULL UNIQUE,
        intent_id VARCHAR(191) NOT NULL UNIQUE,
        revision BIGINT NOT NULL,
        state_json LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canonical_run_state_revisions (
        run_id VARCHAR(191) NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        revision BIGINT NOT NULL,
        state_json LONGTEXT NOT NULL,
        reason LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY(run_id, revision)
      )
    `
    : `
      CREATE TABLE IF NOT EXISTS canonical_run_states (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        state_id TEXT NOT NULL UNIQUE,
        intent_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canonical_run_state_revisions (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY(run_id, revision)
      )
    `;
  await database.exec(schema);
  if (await hasColumn(database, "plans", "canonical_state_ref_json")) return;
  await database.exec(`ALTER TABLE plans ADD COLUMN canonical_state_ref_json ${database.dialect === "tidb" ? "LONGTEXT" : "TEXT"}`);
}

async function hasColumn(database: SqlConnection, table: string, column: string): Promise<boolean> {
  if (database.dialect === "sqlite") {
    const rows = await database.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    return rows.some((row) => row.name === column);
  }
  const rows = await database.prepare(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = ${database.dialect === "tidb" ? "DATABASE()" : "current_schema()"}
      AND table_name = ?
      AND column_name = ?
  `).all<{ column_name: string }>(table, column);
  return rows.length > 0;
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
