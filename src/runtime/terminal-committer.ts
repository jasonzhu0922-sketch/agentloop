import type { AppDatabase } from "../storage/database.ts";
import { AppError } from "../shared/errors.ts";
import type { PlanRepository } from "../planning/plan-repository.ts";

export class TerminalCommitter {
  private readonly database: AppDatabase;
  private readonly plans: PlanRepository;

  constructor(database: AppDatabase, plans: PlanRepository) {
    this.database = database;
    this.plans = plans;
  }

  commitCompleted(runId: string, planId: string, output: string): void {
    const plan = this.plans.get(planId);
    if (plan.runId !== runId || plan.steps.some((step) => step.status !== "completed" && step.retiredAt === undefined)) {
      throw new AppError("ASSESSMENT_ERROR", "Terminal commit requires every Plan step to be completed", 409);
    }
    const assessments = this.plans.assessments(planId);
    for (const step of plan.steps.filter((step) => step.retiredAt === undefined)) {
      const latest = assessments.filter((item) => item.stepId === step.id).at(-1);
      if (latest?.approved !== true) {
        throw new AppError(
          "ASSESSMENT_ERROR",
          `Terminal commit requires an approved assessment for step ${step.id}`,
          409,
        );
      }
    }
    const now = Date.now();
    this.database.transaction(() => {
      this.database.raw.prepare("UPDATE plans SET status = 'completed', updated_at = ? WHERE id = ?")
        .run(now, planId);
      this.database.raw.prepare(`
        INSERT INTO run_outcomes(run_id, plan_id, status, output, reason_code, committed_at)
        VALUES (?, ?, 'completed', ?, 'plan_assessed_and_completed', ?)
      `).run(runId, planId, output, now);
      this.database.raw.prepare(`
        UPDATE runs SET status = 'completed', output = ?, error_code = NULL, finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(output, now, runId);
    });
  }

  commitStopped(input: {
    runId: string;
    planId?: string;
    status: "failed" | "cancelled";
    reasonCode: string;
  }): void {
    const now = Date.now();
    this.database.transaction(() => {
      if (input.planId !== undefined) {
        this.database.raw.prepare("UPDATE plans SET status = 'failed', updated_at = ? WHERE id = ?")
          .run(now, input.planId);
      }
      this.database.raw.prepare(`
        INSERT INTO run_outcomes(run_id, plan_id, status, output, reason_code, committed_at)
        VALUES (?, ?, ?, NULL, ?, ?)
      `).run(input.runId, input.planId ?? null, input.status, input.reasonCode, now);
      this.database.raw.prepare(`
        UPDATE runs SET status = ?, error_code = ?, finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(input.status, input.reasonCode, now, input.runId);
    });
  }
}
