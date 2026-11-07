import { AppError } from "../shared/errors.ts";
import type { SqlConnection } from "../storage/connection.ts";
import { insertIfAbsentSql } from "../storage/dialect-sql.ts";

export class PlanningBudgetRepository {
  private readonly database: SqlConnection;

  constructor(database: SqlConnection) {
    this.database = database;
  }

  async initialize(runId: string, maxTurns: number, now: number, phase: "plan" | "intent" = "plan"): Promise<void> {
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new TypeError("Invalid planning budget");
    const table = phase === "intent" ? "run_intent_budgets" : "run_planning_budgets";
    await this.database.prepare(insertIfAbsentSql({
      dialect: this.database.dialect,
      insert: `INSERT INTO ${table}(run_id, max_turns, used_turns, updated_at) VALUES (?, ?, 0, ?)`,
      keyColumn: "run_id",
    })).run(runId, maxTurns, now);
  }

  async consume(runId: string, now: number, phase: "plan" | "intent" = "plan"): Promise<void> {
    const table = phase === "intent" ? "run_intent_budgets" : "run_planning_budgets";
    const result = await this.database.prepare(`
      UPDATE ${table} SET used_turns = used_turns + 1, updated_at = ?
      WHERE run_id = ? AND used_turns < max_turns
        AND EXISTS (SELECT 1 FROM runs WHERE runs.id = ${table}.run_id AND runs.status = 'running')
    `).run(now, runId);
    if (result.changes !== 1) throw new AppError("PLANNING_ERROR", "Planning budget exhausted or Run is no longer active", 422);
  }

  async grantRetry(runId: string, now: number, phase: "plan" | "intent"): Promise<void> {
    const table = phase === "intent" ? "run_intent_budgets" : "run_planning_budgets";
    const result = await this.database.prepare(`UPDATE ${table}
      SET max_turns = max_turns * 2, updated_at = ? WHERE run_id = ?`).run(now, runId);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Planning recovery budget is unavailable", 409);
  }

  /** Allocates capacity for a new automatic Round without changing a still-available budget. */
  async grantNextRound(runId: string, now: number, defaultMaxTurns = 4): Promise<void> {
    const result = await this.database.prepare(`UPDATE run_planning_budgets
      SET max_turns = CASE WHEN used_turns >= max_turns THEN max_turns * 2 ELSE max_turns END,
          updated_at = ? WHERE run_id = ?`).run(now, runId);
    if (result.changes === 1) return;
    if (!Number.isSafeInteger(defaultMaxTurns) || defaultMaxTurns < 1) {
      throw new AppError("CONFLICT", "Next Round planning budget is unavailable", 409);
    }
    await this.database.prepare(insertIfAbsentSql({
      dialect: this.database.dialect,
      insert: "INSERT INTO run_planning_budgets(run_id, max_turns, used_turns, updated_at) VALUES (?, ?, 0, ?)",
      keyColumn: "run_id",
    })).run(runId, defaultMaxTurns, now);
  }
}
