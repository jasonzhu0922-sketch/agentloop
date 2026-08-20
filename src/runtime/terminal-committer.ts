import { AppError } from "../shared/errors.ts";
import type { PlanRepository } from "../planning/plan-repository.ts";
import { RunOutcomeRepository } from "../storage/repositories/outcome-repository.ts";

export class TerminalCommitter {
  private readonly plans: PlanRepository;
  private readonly outcomes: RunOutcomeRepository;

  constructor(plans: PlanRepository, outcomes: RunOutcomeRepository) {
    this.plans = plans;
    this.outcomes = outcomes;
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
    this.outcomes.commitCompleted({ runId, planId, output });
  }

  commitStopped(input: {
    runId: string;
    planId?: string;
    status: "failed" | "cancelled";
    reasonCode: string;
  }): void {
    this.outcomes.commitStopped(input);
  }
}