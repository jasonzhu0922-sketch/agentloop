import { randomUUID } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import type { PrivateSkill } from "../skills/skill-service.ts";
import type { ExecutionPlan, PlanProposal, PlanStep, SuccessCriterion } from "./contracts.ts";

export function admitPlan(input: {
  runId: string;
  proposal: PlanProposal;
  availableSkills: readonly PrivateSkill[];
  availableToolNames: ReadonlySet<string>;
  now?: number;
}): ExecutionPlan {
  const { proposal } = input;
  if (proposal.steps.length === 0 || proposal.steps.length > 100) {
    reject("Plan must contain between 1 and 100 steps");
  }
  const availableSkills = new Map(input.availableSkills.map((skill) => [skill.id, skill]));
  assertUnique(proposal.selectedSkillIds, "selected skill IDs");
  for (const skillId of proposal.selectedSkillIds) {
    if (!availableSkills.has(skillId)) reject(`Plan selected unavailable Skill ${skillId}`);
  }

  const stepIds = proposal.steps.map((step) => step.id);
  assertUnique(stepIds, "step IDs");
  const stepIdSet = new Set(stepIds);
  const selectedSet = new Set(proposal.selectedSkillIds);
  const boundSkillIds = new Set<string>();

  const steps: PlanStep[] = proposal.steps.map((step, position) => {
    assertUnique(step.dependencies, `dependencies for step ${step.id}`);
    assertUnique(step.skillIds, `Skill bindings for step ${step.id}`);
    assertUnique(step.requiredToolNames, `tools for step ${step.id}`);
    if (step.dependencies.includes(step.id)) reject(`Step ${step.id} cannot depend on itself`);
    for (const dependency of step.dependencies) {
      if (!stepIdSet.has(dependency)) reject(`Step ${step.id} has unknown dependency ${dependency}`);
    }
    const mergedTools = new Set(step.requiredToolNames);
    if (step.skillIds.length > 0) mergedTools.add("load_skill");
    const criteria: SuccessCriterion[] = [...step.successCriteria];
    for (const skillId of step.skillIds) {
      if (!selectedSet.has(skillId)) reject(`Step ${step.id} binds unselected Skill ${skillId}`);
      const skill = availableSkills.get(skillId);
      if (skill === undefined) reject(`Step ${step.id} binds unavailable Skill ${skillId}`);
      boundSkillIds.add(skillId);
    }
    for (const toolName of mergedTools) {
      if (!input.availableToolNames.has(toolName)) {
        reject(`Step ${step.id} requires unavailable Tool ${toolName}`);
      }
    }
    if (criteria.length === 0) reject(`Step ${step.id} has no success criteria`);
    assertUnique(criteria.map((criterion) => criterion.id), `criteria for step ${step.id}`);
    return {
      ...step,
      position,
      requiredToolNames: [...mergedTools],
      successCriteria: criteria,
      status: "pending",
    };
  });

  for (const skillId of selectedSet) {
    if (!boundSkillIds.has(skillId)) reject(`Selected Skill ${skillId} is not bound to any Plan step`);
  }
  assertAcyclic(steps);
  const now = input.now ?? Date.now();
  return {
    id: randomUUID(),
    runId: input.runId,
    version: 1,
    goal: proposal.goal,
    selectedSkillIds: [...proposal.selectedSkillIds],
    status: "admitted",
    steps,
    createdAt: now,
    updatedAt: now,
  };
}

function assertAcyclic(steps: readonly PlanStep[]): void {
  const dependencies = new Map(steps.map((step) => [step.id, step.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) reject(`Plan dependency graph contains a cycle at ${stepId}`);
    visiting.add(stepId);
    for (const dependency of dependencies.get(stepId) ?? []) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of steps) visit(step.id);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) reject(`${label} must not contain duplicates`);
}

function reject(message: string): never {
  throw new AppError("PLAN_NOT_ADMITTED", message, 422);
}
