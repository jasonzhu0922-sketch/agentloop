import type { ExecutionPlan, PlanStep } from "./contracts.ts";

export function isLeafStep(step: PlanStep): boolean {
  return step.kind === "leaf";
}

export function activeLeafSteps(plan: ExecutionPlan): PlanStep[] {
  return plan.steps.filter((step) => isLeafStep(step) && step.retiredAt === undefined);
}

export function isPlanLeafComplete(plan: ExecutionPlan): boolean {
  return activeLeafSteps(plan).every((step) => step.status === "completed");
}
