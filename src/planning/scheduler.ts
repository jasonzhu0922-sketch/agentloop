import { AppError } from "../shared/errors.ts";
import type { ExecutionPlan, PlanStep } from "./contracts.ts";

export class DependencyScheduler {
  nextReady(plan: ExecutionPlan): PlanStep | undefined {
    const completed = new Set(
      plan.steps.filter((step) => step.status === "completed" || step.retiredAt !== undefined).map((step) => step.id),
    );
    return plan.steps
      .filter((step) => step.status === "pending" && step.retiredAt === undefined)
      .sort((left, right) => left.position - right.position)
      .find((step) => step.dependencies.every((dependency) => completed.has(dependency)));
  }

  assertProgressPossible(plan: ExecutionPlan): void {
    const pending = plan.steps.filter((step) => step.status === "pending" && step.retiredAt === undefined);
    if (pending.length > 0 && this.nextReady(plan) === undefined) {
      throw new AppError(
        "PLAN_NOT_ADMITTED",
        "No dependency-ready step exists while the Plan is incomplete",
        409,
      );
    }
  }
}
