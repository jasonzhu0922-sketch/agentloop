import { AppError } from "../shared/errors.ts";
import type { ExecutionPlan } from "../planning/contracts.ts";
import { activeLeafSteps } from "../planning/plan-utils.ts";
import type { CanonicalRunState } from "./canonical-run-state.ts";

export type RoundProgress =
  | { readonly kind: "continue_round"; readonly incompleteStepIds: readonly string[] }
  | { readonly kind: "next_round"; readonly openGapIds: readonly string[]; readonly openTargetIds: readonly string[] }
  | { readonly kind: "complete_goal" };

/** Classifies persisted progress; it does not authorize execution or terminal delivery. */
export function decideRoundProgress(plan: ExecutionPlan, state: CanonicalRunState): RoundProgress {
  if (plan.runId !== state.runId || state.plan?.id !== plan.id || state.plan.version !== plan.version || state.terminal !== undefined) {
    throw new AppError("CONFLICT", "Round progress requires the current non-terminal Plan and Canonical State", 409);
  }
  const leaves = activeLeafSteps(plan);
  if (leaves.length === 0) throw new AppError("CONFLICT", "Round progress requires an executable Plan leaf", 409);
  const activeIds = new Set(leaves.map((step) => step.id));
  const unmatched = Object.values(state.steps).filter((step) => step.status !== "retired" && !activeIds.has(step.stepId));
  if (unmatched.length > 0) throw new AppError("CONFLICT", "Canonical State contains active Steps outside the current Plan", 409);
  const incompleteStepIds = leaves.filter((step) => step.status !== "completed" || state.steps[step.id]?.status !== "satisfied")
    .map((step) => step.id);
  if (incompleteStepIds.length > 0) return { kind: "continue_round", incompleteStepIds };
  const openGapIds = state.gaps.filter((gap) => gap.status === "open").map((gap) => gap.id);
  const openTargetIds = Object.values(state.targets).filter((target) => target.terminalRequired && target.status !== "accepted")
    .map((target) => target.targetId);
  if (openGapIds.length > 0 || openTargetIds.length > 0) return { kind: "next_round", openGapIds, openTargetIds };
  return { kind: "complete_goal" };
}
