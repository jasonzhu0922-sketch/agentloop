import { AppError } from "../shared/errors.ts";
import type { ExecutionPlan, PlanStep } from "./contracts.ts";
import { activeLeafSteps } from "./plan-utils.ts";

export class DependencyScheduler {
  nextReady(plan: ExecutionPlan): PlanStep | undefined {
    return activeLeafSteps(plan)
      .filter((step) => step.status === "pending")
      .sort((left, right) => left.position - right.position)
      .find((step) => isLeafReady(plan, step));
  }

  assertProgressPossible(plan: ExecutionPlan): void {
    const pending = activeLeafSteps(plan).filter((step) => step.status === "pending");
    if (pending.length > 0 && this.nextReady(plan) === undefined) {
      throw new AppError(
        "PLAN_NOT_ADMITTED",
        "No dependency-ready step exists while the Plan is incomplete",
        409,
      );
    }
  }
}

function isLeafReady(plan: ExecutionPlan, step: PlanStep): boolean {
  return step.dependencies.every((dependency) => isDependencySatisfied(plan, dependency, new Set()))
    && parentDependenciesSatisfied(plan, step);
}

function parentDependenciesSatisfied(plan: ExecutionPlan, step: PlanStep): boolean {
  const byId = new Map(plan.steps.map((item) => [item.id, item]));
  const seen = new Set<string>();
  let cursor = step.parentId === undefined ? undefined : byId.get(step.parentId);
  while (cursor !== undefined) {
    if (seen.has(cursor.id)) return false;
    seen.add(cursor.id);
    if (!cursor.dependencies.every((dependency) => isDependencySatisfied(plan, dependency, new Set()))) return false;
    cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
  }
  return true;
}

function isDependencySatisfied(plan: ExecutionPlan, dependencyId: string, seen: Set<string>): boolean {
  const dependency = plan.steps.find((step) => step.id === dependencyId);
  if (dependency === undefined) return false;
  if (dependency.retiredAt !== undefined || dependency.status === "completed") return true;
  if (dependency.kind !== "milestone") return false;
  if (seen.has(dependency.id)) return false;
  seen.add(dependency.id);
  return dependency.dependencies.every((nested) => isDependencySatisfied(plan, nested, seen));
}
