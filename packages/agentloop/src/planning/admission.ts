import { randomUUID } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import { buildSkillReferenceMap } from "../skills/skill-identity.ts";
import type { PrivateSkill } from "../skills/skill-service.ts";
import type { EvidenceContract, EvidenceKind, ExecutionPlan, PlanProposal, PlanStep, PlanningCapability, PlanningToolSummary, RefinementState, RequiredFact, SuccessCriterion } from "./contracts.ts";
import {
  createStepExecutionBinding,
  unknownUploadedSourceIds,
  unknownVisibleDirectoryIds,
  unknownToolSourceIds,
  unknownPlanningCapabilities,
  unresolvedToolSourceIds,
  unsatisfiedToolCapabilities,
  planningCapabilitiesFromToolNames,
  planningCapabilitiesFromTools,
  skillSourceProviderCapabilityId,
} from "./step-execution-binding.ts";

const FILE_PRODUCER_TOOL_NAMES = new Set([
  "materialize_paginated_html",
  "computer_patch_file",
  "computer_write_file",
  "computer_run_command",
]);

const SKILL_QA_ONLY_EVIDENCE_KINDS = new Set(["basic_navigation"]);
const ARTIFACT_DELIVERY_EVIDENCE_KINDS = new Set([
  "artifact_path",
  "artifact_non_empty",
  "artifact_acceptance",
  "artifact_openable",
  "format_matches_request",
]);
const TOOL_PRODUCED_EVIDENCE_KINDS = new Set([
  "schema_summary",
  "record_counts",
  "table_coverage",
  "structured_extraction_artifact",
  "derived_aggregation",
  "artifact_path",
  "artifact_non_empty",
  "artifact_acceptance",
  "artifact_openable",
  "format_matches_request",
]);
const REUSABLE_SOURCE_EVIDENCE_KINDS = new Set<EvidenceKind>([
  "source_summary",
  "source_urls",
  "schema_summary",
  "record_counts",
  "table_coverage",
  "structured_extraction_artifact",
  "derived_aggregation",
  "explicit_caveats",
]);

export function admitPlan(input: {
  runId: string;
  proposal: PlanProposal;
  availableSkills: readonly PrivateSkill[];
  availableToolNames: ReadonlySet<string>;
  availableTools?: readonly PlanningToolSummary[];
  availableCapabilities?: readonly PlanningCapability[];
  requiredToolSourceIds?: readonly string[];
  availableUploadedSourceIds?: readonly string[];
  availableVisibleDirectoryIds?: readonly string[];
  taskIntent?: {
    readonly deliverySurface?: "conversation" | "workspace_artifact";
    readonly artifactKind?: string;
  };
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
  const availableSkills = buildSkillReferenceMap(input.availableSkills);
  const selectedSkillIds = proposal.selectedSkillIds.map((skillReference) => {
    const skill = availableSkills.get(skillReference);
    if (skill === undefined) reject(`Plan selected unavailable Skill ${skillReference}`);
    return skill.id;
  });
  assertUnique(selectedSkillIds, "selected skill IDs");
  for (const skillId of selectedSkillIds) {
    if (!availableSkills.has(skillId)) reject(`Plan selected unavailable Skill ${skillId}`);
  }

  const stepIds = proposal.steps.map((step) => step.id);
  assertUnique(stepIds, "step IDs");
  const stepIdSet = new Set(stepIds);
  const selectedSet = new Set(selectedSkillIds);
  const selectedRoleBySkillId = new Map<string, string>();
  for (const selection of proposal.selectedSkillRoles ?? []) {
    const skill = availableSkills.get(selection.skillId);
    selectedRoleBySkillId.set(skill?.id ?? selection.skillId, selection.role);
  }
  const boundSkillIds = new Set<string>();
  const canProduceFiles = hasFileProducer(input.availableToolNames);

  const steps: PlanStep[] = proposal.steps.map((step, position) => {
    const kind = step.kind ?? "leaf";
    const refinementState = normalizeRefinementState(kind, step.refinementState);
    const requiredFacts = step.requiredFacts ?? [];
    assertUnique(step.dependencies, `dependencies for step ${step.id}`);
    const stepSkillIds = step.skillIds.map((skillReference) => {
      const skill = availableSkills.get(skillReference);
      if (skill === undefined) reject(`Step ${step.id} binds unavailable Skill ${skillReference}`);
      return skill.id;
    });
    assertUnique(stepSkillIds, `Skill bindings for step ${step.id}`);
    assertUnique(step.requiredCapabilities, `required capabilities for step ${step.id}`);
    const constrainedToolSourceIds = step.sourceConstraint?.requiredToolSourceIds ?? [];
    const constrainedUploadedSourceIds = step.sourceConstraint?.requiredUploadedSourceIds ?? [];
    const constrainedVisibleDirectoryIds = step.sourceConstraint?.requiredVisibleDirectoryIds ?? [];
    assertUnique(constrainedToolSourceIds, `required ToolSources for step ${step.id}`);
    assertUnique(constrainedUploadedSourceIds, `required uploaded sources for step ${step.id}`);
    assertUnique(constrainedVisibleDirectoryIds, `required visible directories for step ${step.id}`);
    const unknownToolSources = unknownToolSourceIds(constrainedToolSourceIds, input.availableTools ?? []);
    if (unknownToolSources.length > 0) {
      reject(`Step ${step.id} requires unavailable ToolSource(s): ${unknownToolSources.join(", ")}`);
    }
    const unknownUploadedSources = unknownUploadedSourceIds(constrainedUploadedSourceIds, input.availableUploadedSourceIds ?? []);
    if (unknownUploadedSources.length > 0) {
      reject(`Step ${step.id} requires unavailable uploaded source(s): ${unknownUploadedSources.join(", ")}`);
    }
    const unknownVisibleDirectories = unknownVisibleDirectoryIds(
      constrainedVisibleDirectoryIds,
      input.availableVisibleDirectoryIds ?? [],
    );
    if (unknownVisibleDirectories.length > 0) {
      reject(`Step ${step.id} requires unavailable visible directory(s): ${unknownVisibleDirectories.join(", ")}`);
    }
    if (!recoveryPlan && step.role === "repair") {
      reject(`Initial OutcomePlan cannot contain repair leaf ${step.id}`);
    }
    if (step.evidenceContract !== undefined) assertEvidenceContract(step.id, step.evidenceContract);
    const evidenceContract = normalizeEvidenceContract(step.evidenceContract);
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
      if (step.requiredCapabilities.length > 0) {
        reject(`Milestone ${step.id} cannot require execution capabilities; refine it into leaf steps first`);
      }
      if (refinementState === "not_refinable") {
        reject(`Milestone ${step.id} must be refinable`);
      }
    }
    if (kind === "leaf" && stepSkillIds.length > 0 && isPureSkillActivationStep(step)) {
      reject(
        `Step ${step.id} is only a Skill activation step; bind the Skill to a concrete user-deliverable step instead`,
      );
    }
    const fileProducingStep = kind === "leaf" && requiresFileProduction(step, input.taskIntent);
    if (!canProduceFiles && fileProducingStep) {
      reject(
        `Step ${step.id} requires file or artifact production, but no file-producing Tool is available in this Run; enable write/command tools or submit a text-only Plan without file-output success criteria`,
      );
    }
    const requiredCapabilities = new Set(step.requiredCapabilities);
    if (kind === "leaf" && stepSkillIds.length > 0) requiredCapabilities.add("skill_instruction_load");
    if (
      kind === "leaf"
      && evidenceContract?.requiredKinds.includes("artifact_acceptance")
      && input.availableToolNames.has("verify_artifact_acceptance")
    ) {
      requiredCapabilities.add("artifact_acceptance");
    }
    const completionEvidenceContract = normalizeCompletionEvidenceContract(step.role, evidenceContract, input.taskIntent);
    const completionCriteria = normalizeCompletionSuccessCriteria(step.role, step.successCriteria, input.taskIntent);
    normalizeCompletionCapabilities(step.role, requiredCapabilities, input.taskIntent);
    const criteria: SuccessCriterion[] = [...completionCriteria];
    for (const skillId of stepSkillIds) {
      if (!selectedSet.has(skillId)) reject(`Step ${step.id} binds unselected Skill ${skillId}`);
      const skill = availableSkills.get(skillId);
      if (skill === undefined) reject(`Step ${step.id} binds unavailable Skill ${skillId}`);
      boundSkillIds.add(skillId);
      for (const capability of capabilitiesRequiredBySkill(skill)) requiredCapabilities.add(capability);
    }
    if (criteria.length === 0) reject(`Step ${step.id} has no success criteria`);
    assertUnique(criteria.map((criterion) => criterion.id), `criteria for step ${step.id}`);
    const executionBinding = createStepExecutionBinding({
      step: { ...step, requiredCapabilities: [...requiredCapabilities] },
      availableToolNames: input.availableToolNames,
      ...(input.availableTools === undefined ? {} : { availableTools: input.availableTools }),
      evidenceContract: completionEvidenceContract,
    });
    const unknownCapabilities = unknownPlanningCapabilities(
      executionBinding.requiredCapabilities,
      input.availableTools,
      input.availableCapabilities,
    );
    if (unknownCapabilities.length > 0) {
      reject(`Step ${step.id} requires unknown capabilities: ${unknownCapabilities.join(", ")}`);
    }
    const unsatisfiedCapabilities = unsatisfiedToolCapabilities(
      executionBinding.requiredCapabilities,
      input.availableToolNames,
      input.availableTools,
      executionBinding.requiredToolSourceIds,
    );
    if (unsatisfiedCapabilities.length > 0) {
      reject(`Step ${step.id} requires capabilities that cannot be satisfied by this Run: ${unsatisfiedCapabilities.join(", ")}`);
    }
    const unresolvedSourceIds = unresolvedToolSourceIds(
      executionBinding.requiredToolSourceIds ?? [],
      executionBinding.resolvedToolNames,
      input.availableTools ?? [],
    );
    if (unresolvedSourceIds.length > 0) {
      reject(`Step ${step.id} constrains ToolSource(s) without a resolved Tool: ${unresolvedSourceIds.join(", ")}`);
    }
    const { evidenceContract: _proposalEvidenceContract, ...stepWithoutEvidenceContract } = step;
    return {
      ...stepWithoutEvidenceContract,
      kind,
      position,
      skillIds: stepSkillIds,
      refinementState,
      requiredFacts,
      requiredCapabilities: executionBinding.requiredCapabilities,
      executionBinding,
      ...(completionEvidenceContract === undefined ? {} : { evidenceContract: completionEvidenceContract }),
      successCriteria: criteria,
      status: "pending",
    };
  });

  const admittedSteps = normalizeConversationTerminalEvidenceReuse(steps, input.taskIntent);
  const availableCapabilities = input.availableCapabilities
    ?? (input.availableTools === undefined
      ? planningCapabilitiesFromToolNames([...input.availableToolNames])
      : planningCapabilitiesFromTools(input.availableTools));
  for (const step of admittedSteps) {
    assertEvidenceContractIsProducible({
      stepId: step.id,
      evidenceContract: step.evidenceContract,
      requiredCapabilities: step.executionBinding.requiredCapabilities,
      availableCapabilities,
    });
  }

  for (const skillId of selectedSet) {
    const selectedRole = selectedRoleBySkillId.get(skillId);
    const nonExecutingRecoveryRole = recoveryPlan
      && (selectedRole === "source_provider" || selectedRole === "support" || selectedRole === "qa");
    if (!nonExecutingRecoveryRole && !boundSkillIds.has(skillId)) {
      reject(`Selected Skill ${skillId} is not bound to any Plan step`);
    }
  }
  if (admittedSteps.every((step) => step.kind !== "leaf")) {
    reject("Plan must contain at least one executable leaf step");
  }
  const requiredToolSourceIds = new Set(input.requiredToolSourceIds ?? []);
  if (requiredToolSourceIds.size > 0) {
    const boundToolSourceIds = new Set(admittedSteps.flatMap((step) => step.executionBinding.requiredToolSourceIds ?? []));
    const missingToolSourceIds = [...requiredToolSourceIds].filter((sourceId) => !boundToolSourceIds.has(sourceId));
    if (missingToolSourceIds.length > 0) {
      reject(`Plan does not bind user-required ToolSource(s): ${missingToolSourceIds.join(", ")}`);
    }
  }
  assertParentTree(admittedSteps);
  assertAcyclic(admittedSteps);
  const now = input.now ?? Date.now();
  return {
    id: randomUUID(),
    runId: input.runId,
    version: 1,
    goal: proposal.goal,
    selectedSkillIds,
    status: "admitted",
    steps: admittedSteps,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Source evidence is owned by the acquisition leaf that produced it. A later
 * conversation-only delivery leaf may rely on that completed dependency, but
 * must not be forced to repeat the acquisition merely to recreate the same
 * receipt in its local tool-call list.
 */
function normalizeConversationTerminalEvidenceReuse(
  steps: readonly PlanStep[],
  taskIntent: { readonly deliverySurface?: "conversation" | "workspace_artifact"; readonly artifactKind?: string } | undefined,
): readonly PlanStep[] {
  if (taskIntent?.deliverySurface !== "conversation" || taskIntent.artifactKind !== "none") return steps;
  const dependedOn = new Set(steps.flatMap((step) => step.dependencies));
  const byId = new Map(steps.map((step) => [step.id, step]));
  return steps.map((step) => {
    if (
      step.kind !== "leaf"
      || dependedOn.has(step.id)
      || step.role === "fact_acquisition"
      || step.role === "repair"
      || step.evidenceContract === undefined
      || step.executionBinding.sourceKinds.some((kind) => kind !== "conversation_workset")
    ) return step;
    const reusedKinds = step.evidenceContract.requiredKinds.filter((kind) =>
      REUSABLE_SOURCE_EVIDENCE_KINDS.has(kind)
      && dependencyProvidesEvidenceKind(step.dependencies, kind, byId),
    );
    if (reusedKinds.length === 0) return step;
    const reusedKindIds = new Set<string>(reusedKinds);
    const requiredKinds = step.evidenceContract.requiredKinds.filter((kind) => !reusedKindIds.has(kind));
    const successCriteria = step.successCriteria.filter((criterion) => !reusedKindIds.has(criterion.id));
    return {
      ...step,
      ...(requiredKinds.length === 0 ? { evidenceContract: undefined } : {
        evidenceContract: { ...step.evidenceContract, requiredKinds },
      }),
      successCriteria: successCriteria.length > 0 ? successCriteria : [{
        id: "conversation_delivery",
        description: "A complete user-facing response is returned in the conversation.",
        source: "planner",
      }],
      executionBinding: {
        ...step.executionBinding,
        evidenceKinds: requiredKinds,
      },
    };
  });
}

function dependencyProvidesEvidenceKind(
  dependencyIds: readonly string[],
  kind: EvidenceKind,
  byId: ReadonlyMap<string, PlanStep>,
): boolean {
  const seen = new Set<string>();
  const visit = (stepId: string): boolean => {
    if (seen.has(stepId)) return false;
    seen.add(stepId);
    const dependency = byId.get(stepId);
    if (dependency === undefined) return false;
    if (dependency.evidenceContract?.requiredKinds.includes(kind)) return true;
    return dependency.dependencies.some(visit);
  };
  return dependencyIds.some(visit);
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

function assertEvidenceContractIsProducible(input: {
  readonly stepId: string;
  readonly evidenceContract?: EvidenceContract;
  readonly requiredCapabilities: readonly string[];
  readonly availableCapabilities: readonly PlanningCapability[];
}): void {
  if (input.evidenceContract === undefined) return;
  const capabilityById = new Map(input.availableCapabilities.map((capability) => [capability.id, capability]));
  const produced = new Set(input.requiredCapabilities.flatMap((id) => capabilityById.get(id)?.produces ?? []));
  const unavailable = input.evidenceContract.requiredKinds.filter((kind) =>
    TOOL_PRODUCED_EVIDENCE_KINDS.has(kind) && !produced.has(kind),
  );
  if (unavailable.length > 0) {
    reject(
      `Step ${input.stepId} requires evidence that its bound capabilities cannot produce: ${unavailable.join(", ")}`,
    );
  }
}

function normalizeEvidenceContract(contract: EvidenceContract | undefined): EvidenceContract | undefined {
  if (contract === undefined) return undefined;
  // Delivery is already a durable Runtime event. Keeping it in a Plan's
  // required evidence turns an audit record into a circular completion gate.
  const requiredKinds = contract.requiredKinds.filter((kind) =>
    !SKILL_QA_ONLY_EVIDENCE_KINDS.has(kind) && kind !== "delivery_receipt"
  );
  if (requiredKinds.length === 0) {
    return undefined;
  }
  return { ...contract, requiredKinds };
}

function normalizeCompletionEvidenceContract(
  role: PlanProposal["steps"][number]["role"],
  contract: EvidenceContract | undefined,
  taskIntent: { readonly deliverySurface?: "conversation" | "workspace_artifact"; readonly artifactKind?: string } | undefined,
): EvidenceContract | undefined {
  // Evidence contracts are explicit semantic requirements, not a generic
  // delivery protocol. Runtime records every delivery and Tool result for
  // audit; admission must not turn those observations into a hard criterion.
  if (contract === undefined || role === undefined || role === "fact_acquisition" || role === "repair") return contract;
  if (taskIntent?.deliverySurface === "conversation" && taskIntent.artifactKind === "none") {
    const requiredKinds = contract.requiredKinds.filter((kind) => !ARTIFACT_DELIVERY_EVIDENCE_KINDS.has(kind));
    return requiredKinds.length === 0 ? undefined : { ...contract, requiredKinds };
  }
  return contract;
}

function normalizeCompletionSuccessCriteria(
  role: PlanProposal["steps"][number]["role"],
  criteria: readonly SuccessCriterion[],
  taskIntent: { readonly deliverySurface?: "conversation" | "workspace_artifact"; readonly artifactKind?: string } | undefined,
): readonly SuccessCriterion[] {
  if (role === undefined || role === "fact_acquisition" || role === "repair") return criteria;
  if (taskIntent?.deliverySurface !== "conversation" || taskIntent.artifactKind !== "none") return criteria;
  const normalized = criteria.filter((criterion) => !ARTIFACT_DELIVERY_EVIDENCE_KINDS.has(criterion.id));
  return normalized.length > 0 ? normalized : [{
    id: "conversation_delivery",
    description: "A complete user-facing response is returned in the conversation.",
    source: "planner",
  }];
}

function normalizeCompletionCapabilities(
  role: PlanProposal["steps"][number]["role"],
  capabilities: Set<string>,
  taskIntent: { readonly deliverySurface?: "conversation" | "workspace_artifact"; readonly artifactKind?: string } | undefined,
): void {
  if (role === undefined || role === "fact_acquisition" || role === "repair") return;
  if (taskIntent?.deliverySurface !== "conversation" || taskIntent.artifactKind !== "none") return;
  capabilities.delete("workspace_artifact_write");
  capabilities.delete("artifact_acceptance");
  if (!capabilities.has("conversation_delivery")) capabilities.add("conversation_delivery");
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
  const nonActivationCapabilities = step.requiredCapabilities.filter((name) => name !== "skill_instruction_load");
  if (nonActivationCapabilities.length > 0) return false;
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

function capabilitiesRequiredBySkill(skill: PrivateSkill): string[] {
  const profiles = skill.agentLoop?.executionProfiles ?? [];
  const capabilities = new Set<string>();
  if (profiles.includes("local_script")) capabilities.add("workspace_artifact_write");
  if (skill.agentLoop?.roles.includes("source_provider") && (skill.agentLoop.producesEvidenceKinds?.length ?? 0) > 0) {
    for (const sourceKind of skill.agentLoop.sourceKinds) {
      capabilities.add(skillSourceProviderCapabilityId(skill.id, sourceKind));
    }
  }
  return [...capabilities];
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

function requiresFileProduction(
  step: PlanProposal["steps"][number],
  taskIntent: {
    readonly deliverySurface?: "conversation" | "workspace_artifact";
    readonly artifactKind?: string;
  } | undefined,
): boolean {
  // A file producer is an authorization requirement, so it must be derived
  // from the structured delivery contract rather than natural-language text.
  if (taskIntent?.deliverySurface === "conversation" && taskIntent.artifactKind === "none") return false;
  return step.requiredCapabilities.includes("workspace_artifact_write")
    || step.evidenceContract?.requiredKinds.some((kind) => ARTIFACT_DELIVERY_EVIDENCE_KINDS.has(kind)) === true
    || step.successCriteria.some((criterion) => ARTIFACT_DELIVERY_EVIDENCE_KINDS.has(criterion.id));
}

function reject(message: string): never {
  throw new AppError("PLAN_NOT_ADMITTED", message, 422);
}
