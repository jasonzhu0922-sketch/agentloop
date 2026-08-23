import { randomUUID } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import type { PrivateSkill } from "../skills/skill-service.ts";
import type { EvidenceContract, ExecutionPlan, PlanProposal, PlanStep, RefinementState, RequiredFact, SuccessCriterion } from "./contracts.ts";

const FILE_PRODUCER_TOOL_NAMES = new Set([
  "computer_write_file",
  "computer_run_command",
]);

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
  const recoveryPlan = proposal.shape === "recovery_patch";
  const invalidRoleSelections = (proposal.selectedSkillRoles ?? []).filter((selection) =>
    !recoveryPlan && (selection.role === "support" || selection.role === "qa")
  );
  if (invalidRoleSelections.length > 0) {
    reject(`Initial OutcomePlan cannot expose support/qa Skill roles (${invalidRoleSelections.map((selection) => selection.skillId).join(", ")})`);
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
  const canProduceFiles = hasFileProducer(input.availableToolNames);

  const steps: PlanStep[] = proposal.steps.map((step, position) => {
    const kind = step.kind ?? "leaf";
    const refinementState = normalizeRefinementState(kind, step.refinementState);
    const requiredFacts = step.requiredFacts ?? [];
    assertUnique(step.dependencies, `dependencies for step ${step.id}`);
    assertUnique(step.skillIds, `Skill bindings for step ${step.id}`);
    assertUnique(step.requiredToolNames, `tools for step ${step.id}`);
    if (!recoveryPlan && step.role === "repair") {
      reject(`Initial OutcomePlan cannot contain repair leaf ${step.id}`);
    }
    if (step.evidenceContract !== undefined) assertEvidenceContract(step.id, step.evidenceContract);
    if (step.dependencies.includes(step.id)) reject(`Step ${step.id} cannot depend on itself`);
    for (const dependency of step.dependencies) {
      if (!stepIdSet.has(dependency)) reject(`Step ${step.id} has unknown dependency ${dependency}`);
    }
    if (step.parentId !== undefined && !stepIdSet.has(step.parentId)) {
      reject(`Step ${step.id} has unknown parent ${step.parentId}`);
    }
    assertUnique(requiredFacts.map((fact) => fact.id), `required facts for step ${step.id}`);
    for (const fact of requiredFacts) assertRequiredFact(step.id, fact);
    if (kind === "milestone") {
      if (step.requiredToolNames.length > 0) {
        reject(`Milestone ${step.id} cannot require execution Tools; refine it into leaf steps first`);
      }
      if (refinementState === "not_refinable") {
        reject(`Milestone ${step.id} must be refinable`);
      }
    }
    if (kind === "leaf" && step.skillIds.length > 0 && isPureSkillActivationStep(step)) {
      reject(
        `Step ${step.id} is only a Skill activation step; bind the Skill to a concrete user-deliverable step instead`,
      );
    }
    const fileProducingStep = kind === "leaf" && requiresFileProduction(step);
    if (!canProduceFiles && fileProducingStep) {
      reject(
        `Step ${step.id} requires file or artifact production, but no file-producing Tool is available in this Run; enable write/command tools or submit a text-only Plan without file-output success criteria`,
      );
    }
    const mergedTools = new Set(step.requiredToolNames);
    if (kind === "leaf" && step.skillIds.length > 0) mergedTools.add("load_skill");
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
      kind,
      position,
      refinementState,
      requiredFacts,
      requiredToolNames: [...mergedTools],
      successCriteria: criteria,
      status: "pending",
    };
  });

  for (const skillId of selectedSet) {
    if (!boundSkillIds.has(skillId)) reject(`Selected Skill ${skillId} is not bound to any Plan step`);
  }
  if (steps.every((step) => step.kind !== "leaf")) {
    reject("Plan must contain at least one executable leaf step");
  }
  assertParentTree(steps);
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

function normalizeRefinementState(kind: "leaf" | "milestone", value: RefinementState | undefined): RefinementState {
  if (kind === "leaf") {
    if (value !== undefined && value !== "not_refinable") reject("Leaf steps must use refinementState not_refinable");
    return "not_refinable";
  }
  if (value === undefined) return "ready_to_refine";
  if (
    value === "pending_facts"
    || value === "ready_to_refine"
    || value === "refining"
    || value === "refined"
  ) {
    return value;
  }
  reject("Milestone steps cannot use refinementState not_refinable");
}

function assertRequiredFact(stepId: string, fact: RequiredFact): void {
  if (fact.id.trim().length === 0) reject(`Step ${stepId} has a requiredFact with an empty id`);
  if (fact.description.trim().length === 0) reject(`Step ${stepId} has a requiredFact with an empty description`);
  assertUnique([...fact.evidenceKinds], `evidenceKinds for required fact ${fact.id}`);
  if (fact.evidenceKinds.length === 0) {
    reject(`Step ${stepId} requiredFact ${fact.id} must declare at least one evidence kind`);
  }
  if (fact.satisfiedBy !== undefined) assertUnique([...fact.satisfiedBy], `satisfiedBy refs for required fact ${fact.id}`);
}

function assertEvidenceContract(stepId: string, contract: EvidenceContract): void {
  assertUnique([...contract.requiredKinds], `evidence kinds for step ${stepId}`);
  if (contract.requiredKinds.length === 0) {
    reject(`Step ${stepId} evidenceContract must declare at least one required kind`);
  }
  if (
    contract.caveatPolicy !== "none"
    && contract.caveatPolicy !== "mark_unverified_facts"
    && contract.caveatPolicy !== "strict_fail_on_missing_source"
  ) {
    reject(`Step ${stepId} evidenceContract has an invalid caveat policy`);
  }
}

function assertParentTree(steps: readonly PlanStep[]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    if (step.parentId === undefined) continue;
    if (step.parentId === step.id) reject(`Step ${step.id} cannot be its own parent`);
    const parent = byId.get(step.parentId);
    if (parent === undefined) continue;
    if (parent.kind !== "milestone") {
      reject(`Step ${step.id} parent ${parent.id} must be a milestone`);
    }
    const seen = new Set([step.id]);
    let cursor: PlanStep | undefined = parent;
    while (cursor !== undefined) {
      if (seen.has(cursor.id)) reject(`Step ${step.id} has a cyclic parent chain`);
      seen.add(cursor.id);
      cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
    }
  }
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

function isPureSkillActivationStep(step: PlanProposal["steps"][number]): boolean {
  const nonActivationTools = step.requiredToolNames.filter((name) => name !== "load_skill");
  if (nonActivationTools.length > 0) return false;
  const id = normalizePlanText(step.id);
  const objective = normalizePlanText(step.objective);
  const criteria = normalizePlanText(step.successCriteria.map((criterion) => criterion.description).join(" "));
  if (/^(load|activate|fetch|retrieve|read)[-_ ]*(skill|skills)?$/.test(id)) return true;
  if (/^(load|activate|fetch|retrieve|read)[-_ ]+.+[-_ ]+skill$/.test(id)) return true;
  if (/^(load|activate|fetch|retrieve|read)\b.{0,120}\b(skill|skills|instruction|instructions|workflow|workflows)\b/.test(objective)) {
    return !containsCompoundDeliverable(objective);
  }
  if (/^(加载|激活|获取|读取).{0,120}(技能|skill|说明|指令|工作流)/.test(objective)) {
    return !containsCompoundDeliverable(objective);
  }
  return objective.length > 0 && objective === criteria && (
    /^skill activation$/.test(objective)
    || /^load skill$/.test(objective)
    || /^加载技能$/.test(objective)
  );
}

function containsCompoundDeliverable(value: string): boolean {
  return /\b(and|then)\b.+\b(apply|follow|use|provide|validate|create|produce|design|build|generate|write|verify|deliver|implement|analyze|summarize)\b/.test(value)
    || /(并|并且|然后).*(应用|遵循|使用|提供|创建|生成|设计|输出|实现|完成|分析|总结|验证|交付)/.test(value);
}

function normalizePlanText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function hasFileProducer(availableToolNames: ReadonlySet<string>): boolean {
  for (const name of availableToolNames) {
    if (FILE_PRODUCER_TOOL_NAMES.has(name)) return true;
    if (/(^|_)(write|create|generate|render|export|save)(_|$)/.test(name)) return true;
  }
  return false;
}

function requiresFileProduction(step: PlanProposal["steps"][number]): boolean {
  const text = normalizePlanText([
    step.id,
    step.objective,
    ...step.successCriteria.map((criterion) => criterion.description),
  ].join(" "));
  const mentionsFileArtifact = /(?:\.(?:png|pdf|md|markdown|html|svg|jpe?g|webp|gif|docx|pptx|xlsx|csv)\b|\b(?:png|pdf|markdown|html|svg|jpe?g|webp|gif|docx|pptx|xlsx|csv)\b|文件|档案|\bfile\b)/i.test(text);
  const hasProductionVerb = /\b(create|produce|generate|write|save|export|render|materialize|build|deliver|output)\b|创建|生成|写入|保存|导出|渲染|产出|输出|交付|制作/.test(text);
  return mentionsFileArtifact && hasProductionVerb;
}

function reject(message: string): never {
  throw new AppError("PLAN_NOT_ADMITTED", message, 422);
}
