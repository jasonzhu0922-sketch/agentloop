import type { SqlConnection } from "./connection.ts";

export async function installPlanningBudgetSchema(database: SqlConnection): Promise<void> {
  const id = database.dialect === "tidb" ? "VARCHAR(191)" : "TEXT";
  await database.exec(`
    CREATE TABLE IF NOT EXISTS run_planning_budgets (
      run_id ${id} PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      max_turns BIGINT NOT NULL,
      used_turns BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);
  await installIntentBudgetSchema(database);
}

export async function installIntentBudgetSchema(database: SqlConnection): Promise<void> {
  const id = database.dialect === "tidb" ? "VARCHAR(191)" : "TEXT";
  await database.exec(`
    CREATE TABLE IF NOT EXISTS run_intent_budgets (
      run_id ${id} PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      max_turns BIGINT NOT NULL,
      used_turns BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);
}
