import { AppError } from "../shared/errors.ts";
import type { ExecutionPlan, PlanProposal, PlanStep, PlanStepProposal } from "./contracts.ts";

/** Expand explicitly declared structural changes; never rename an invalid model definition. */
export function buildRecoveryRevision(proposal: PlanProposal, current: ExecutionPlan): PlanProposal {
  if (!proposal.stepReplacements?.length) return proposal;
  const reject = (message: string): never => { throw new AppError("PLAN_NOT_ADMITTED", message, 422, { recoveryStage: "structure" }); };
  const oldById = new Map(current.steps.map(step => [step.id, step]));
  const newIds = new Set(proposal.steps.map(step => step.id));
  const retained = new Set(proposal.retainedStepIds ?? []);
  if (retained.size !== (proposal.retainedStepIds?.length ?? 0)) reject("retainedStepIds must be unique");
  const replacements = new Map<string, string>();
  for (const { stepId, replacementStepId } of proposal.stepReplacements) {
    const old = oldById.get(stepId);
    if (!old || old.retiredAt !== undefined || old.status === "completed") reject(`Cannot replace completed, retired or unknown Step ${stepId}`);
    if (!newIds.has(replacementStepId) || oldById.has(replacementStepId)) reject(`Replacement ${replacementStepId} must name a new Step definition`);
    if (retained.has(stepId) || replacements.has(stepId) || [...replacements.values()].includes(replacementStepId)) {
      reject(`Step replacement ${stepId} must be unique and cannot also be retained`);
    }
    replacements.set(stepId, replacementStepId);
  }
  // The declaration authorizes only dependency/parent changes on referenced dependents.
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of current.steps) {
      if (!retained.has(step.id) || replacements.has(step.id)) continue;
      if (!step.dependencies.some(id => replacements.has(id)) && !(step.parentId && replacements.has(step.parentId))) continue;
      if (step.status === "completed" || step.retiredAt !== undefined) reject(`Cannot rewire completed or retired Step ${step.id}`);
      const suffix = `.revision.${current.version + 1}`;
      const id = step.id.slice(0, 128 - suffix.length) + suffix;
      if (oldById.has(id) || newIds.has(id) || [...replacements.values()].includes(id)) reject(`Generated replacement id ${id} already exists`);
      replacements.set(step.id, id);
      changed = true;
    }
  }
  const rewire = (step: PlanStepProposal): PlanStepProposal => ({ ...step,
    dependencies: step.dependencies.map(id => replacements.get(id) ?? id),
    ...(step.parentId === undefined ? {} : { parentId: replacements.get(step.parentId) ?? step.parentId }),
  });
  const generated = current.steps.filter(step => retained.has(step.id) && replacements.has(step.id))
    .map(step => rewire({ ...persistedStepProposal(step), id: replacements.get(step.id)! }));
  return { ...proposal, retainedStepIds: [...retained].filter(id => !replacements.has(id)),
    steps: [...proposal.steps.map(rewire), ...generated] };
}

/** Only scheduling identity changes; evidence, provenance and source bindings survive. */
function persistedStepProposal(step: PlanStep): PlanStepProposal {
  const binding = step.executionBinding;
  return {
    id: step.id, kind: step.kind, parentId: step.parentId, objective: step.objective,
    dependencies: step.dependencies, role: step.role, refinementState: step.refinementState,
    requiredFacts: step.requiredFacts, skillIds: step.skillIds, requiredCapabilities: step.requiredCapabilities,
    inputResultRefs: binding.inputResultRefs, targetIds: binding.targetIds,
    sourceConstraint: {
      requiredToolSourceIds: binding.requiredToolSourceIds,
      requiredUploadedSourceIds: binding.requiredUploadedSourceIds,
      requiredVisibleDirectoryIds: binding.requiredVisibleDirectoryIds,
    },
    evidenceContract: step.evidenceContract,
    successCriteria: step.successCriteria.filter(criterion => !criterion.id.startsWith("delivery_target:")
      || !binding.targetIds.includes(criterion.id.slice("delivery_target:".length))),
  };
}
