import { AppError } from "../shared/errors.ts";
import { runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../storage/runtime-records.ts";

export class PlanningBudgetRepository {
  private readonly database: RuntimePersistence;
  constructor(database: RuntimePersistenceInput) { this.database = runtimePersistence(database); }

  async initialize(runId: string, maxTurns: number, now: number, phase: "plan" | "intent" = "plan"): Promise<void> {
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new TypeError("Invalid planning budget");
    await this.database.records.insert(phase === "intent" ? "run_intent_budgets" : "run_planning_budgets",
      { run_id: runId, max_turns: maxTurns, used_turns: 0, updated_at: now }, "ignore");
  }

  async consume(runId: string, now: number, phase: "plan" | "intent" = "plan"): Promise<void> {
    await this.database.transaction(async () => {
      const run = (await this.database.records.find("runs", { id: runId }))[0];
      const changes = run?.status !== "running" ? 0 : await this.database.records.update(
        phase === "intent" ? "run_intent_budgets" : "run_planning_budgets", { run_id: runId }, row =>
          row.used_turns < row.max_turns ? { used_turns: row.used_turns + 1, updated_at: now } : undefined);
      if (changes !== 1) throw new AppError("PLANNING_ERROR", "Planning budget exhausted or Run is no longer active", 422);
    });
  }

  async grantRetry(runId: string, now: number, phase: "plan" | "intent"): Promise<void> {
    const changes = await this.database.records.update(phase === "intent" ? "run_intent_budgets" : "run_planning_budgets",
      { run_id: runId }, row => ({ max_turns: row.max_turns * 2, updated_at: now }));
    if (changes !== 1) throw new AppError("CONFLICT", "Planning recovery budget is unavailable", 409);
  }

  async grantNextRound(runId: string, now: number, defaultMaxTurns = 4): Promise<void> {
    await this.database.transaction(async () => {
      const changes = await this.database.records.update("run_planning_budgets", { run_id: runId }, row => ({
        max_turns: row.used_turns >= row.max_turns ? row.max_turns * 2 : row.max_turns, updated_at: now,
      }));
      if (changes === 1) return;
      if (!Number.isSafeInteger(defaultMaxTurns) || defaultMaxTurns < 1)
        throw new AppError("CONFLICT", "Next Round planning budget is unavailable", 409);
      await this.initialize(runId, defaultMaxTurns, now);
    });
  }
}
