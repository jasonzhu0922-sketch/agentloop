import { AppDatabase, type SqlConnection } from "@zhujun/agentloop";
import { installHostDispatchSchema } from "../runtime/host-dispatch-store.ts";
import { applyVersionedMigrations, SchemaMigrationError, type SchemaMigration } from "./schema-migration-ledger.ts";

const MIGRATIONS: readonly SchemaMigration[] = [
  { id: "runtime/0001_agentloop_kernel", definition: "agentloop-kernel-canonical-schema;legacy-sqlite-upgrades:v1", apply: async (database) => {
    if (!(database instanceof AppDatabase)) throw new SchemaMigrationError("Runtime kernel migration requires an AppDatabase facade");
    await database.installKernelSchema();
  } },
  { id: "runtime/0002_host_dispatch_ledger", definition: "host-dispatch-ledger;run-executor-ownership:v1", apply: installHostDispatchSchema },
  { id: "runtime/0003_preserve_source_state_compatibility", definition: "repair-boundaries;recovery-leases;assessment-bindings;delivery-receipts:v1", apply: installSourceCompatibilityColumns },
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
      await database.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
    }
  }
}
