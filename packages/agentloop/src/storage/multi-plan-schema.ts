import type { SqlConnection } from "./connection.ts";

/** Removes the legacy one-Plan-per-Run uniqueness while preserving every Plan row. */
export async function installMultiPlanSchema(database: SqlConnection): Promise<void> {
  if (database.dialect === "sqlite") {
    const indexes = await database.prepare("PRAGMA index_list(plans)").all<{ name: string; unique: number }>();
    let hasRunIdUniqueIndex = false;
    for (const index of indexes.filter((candidate) => candidate.unique === 1)) {
      const columns = await database.prepare(`PRAGMA index_info('${index.name.replaceAll("'", "''")}')`).all<{ name: string }>();
      if (columns.length === 1 && columns[0]?.name === "run_id") hasRunIdUniqueIndex = true;
    }
    const referencingTables = await sqlitePlanReferencingTables(database);
    const hasStalePlanReference = referencingTables.some((table) => table.referencesLegacyPlan);
    if (!hasRunIdUniqueIndex && !hasStalePlanReference) return;
    // SQLite's table-level UNIQUE cannot be dropped in place. The table has no
    // data owned by the parent row itself beyond these columns; child tables
    // retain their plan_id foreign keys while the parent is rebuilt.
    await database.exec("PRAGMA foreign_keys = OFF");
    await database.exec("PRAGMA legacy_alter_table = ON");
    try {
      await database.transaction(async () => {
        if (hasRunIdUniqueIndex) {
          await database.exec("ALTER TABLE plans RENAME TO plans_single_plan_legacy");
          await database.exec(`CREATE TABLE plans (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            goal TEXT NOT NULL,
            selected_skill_ids_json TEXT NOT NULL,
            canonical_state_ref_json TEXT,
            input_bindings_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL CHECK(status IN ('admitted', 'running', 'completed', 'failed')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )`);
          await database.exec(`INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json,
            canonical_state_ref_json, input_bindings_json, status, created_at, updated_at)
            SELECT id, run_id, version, goal, selected_skill_ids_json, canonical_state_ref_json,
              input_bindings_json, status, created_at, updated_at FROM plans_single_plan_legacy`);
          await database.exec("DROP TABLE plans_single_plan_legacy");
          await database.exec("CREATE INDEX IF NOT EXISTS plans_run_created_idx ON plans(run_id, created_at DESC)");
        }
        await rebuildPlanReferencingTables(database, referencingTables);
      });
    } finally {
      await database.exec("PRAGMA legacy_alter_table = OFF");
      await database.exec("PRAGMA foreign_keys = ON");
    }
    const remaining = await sqlitePlanReferencingTables(database);
    if (remaining.some((table) => table.referencesLegacyPlan)) {
      throw new Error("Multi-Plan migration left a stale plans_single_plan_legacy foreign key");
    }
    return;
  }

  if (database.dialect === "postgres") {
    const constraints = await database.prepare(`SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'plans' AND constraint_type = 'UNIQUE'`).all<{ constraint_name: string }>();
    for (const constraint of constraints) {
      await database.exec(`ALTER TABLE plans DROP CONSTRAINT IF EXISTS "${constraint.constraint_name.replaceAll('"', '""')}"`);
    }
    return;
  }

  const indexes = await database.prepare(`SELECT index_name FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'plans' AND non_unique = 0 AND index_name <> 'PRIMARY'`)
    .all<{ index_name: string }>();
  for (const index of indexes) {
    await database.exec(`ALTER TABLE plans DROP INDEX \`${index.index_name.replaceAll('`', '``')}\``);
  }
}

interface SqlitePlanReferencingTable {
  readonly name: string;
  readonly createSql: string;
  readonly indexes: readonly string[];
  readonly referencesLegacyPlan: boolean;
}

async function sqlitePlanReferencingTables(database: SqlConnection): Promise<SqlitePlanReferencingTable[]> {
  const rows = await database.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`).all<{ name: string; sql: string }>();
  const result: SqlitePlanReferencingTable[] = [];
  for (const row of rows) {
    if (row.name === "plans") continue;
    const foreignKeys = await database.prepare(`PRAGMA foreign_key_list("${row.name.replaceAll('"', '""')}")`).all<{ table: string }>();
    const planKeys = foreignKeys.filter((foreignKey) => foreignKey.table === "plans" || foreignKey.table === "plans_single_plan_legacy");
    if (planKeys.length === 0) continue;
    const indexes = await database.prepare(`SELECT sql FROM sqlite_master
      WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`).all<{ sql: string }>(row.name);
    result.push({
      name: row.name,
      createSql: row.sql,
      indexes: indexes.map((index) => index.sql),
      referencesLegacyPlan: planKeys.some((foreignKey) => foreignKey.table === "plans_single_plan_legacy"),
    });
  }
  return result;
}

async function rebuildPlanReferencingTables(database: SqlConnection, tables: readonly SqlitePlanReferencingTable[]): Promise<void> {
  for (const table of tables) {
    const temporaryName = `${table.name}_multi_plan_rebuild`;
    const escapedName = table.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let createSql = table.createSql.replace(
      new RegExp(`(CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?)(["\`\\[]?${escapedName}["\`\\]]?)`, "i"),
      `$1${temporaryName}`,
    );
    createSql = createSql.replaceAll("plans_single_plan_legacy", "plans");
    await database.exec(createSql);
    const columns = await database.prepare(`PRAGMA table_info("${table.name.replaceAll('"', '""')}")`).all<{ name: string }>();
    const names = columns.map((column) => `"${column.name.replaceAll('"', '""')}"`).join(", ");
    await database.exec(`INSERT INTO "${temporaryName}" (${names}) SELECT ${names} FROM "${table.name.replaceAll('"', '""')}"`);
    await database.exec(`DROP TABLE "${table.name.replaceAll('"', '""')}"`);
    await database.exec(`ALTER TABLE "${temporaryName}" RENAME TO "${table.name.replaceAll('"', '""')}"`);
    for (const index of table.indexes) {
      await database.exec(index.replaceAll("plans_single_plan_legacy", "plans"));
    }
  }
}
