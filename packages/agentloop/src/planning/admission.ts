import { randomUUID } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import { buildSkillReferenceMap } from "../skills/skill-identity.ts";
import type { PrivateSkill } from "../skills/skill-service.ts";
import { taskEvidencePolicyForTaskUnderstanding, type StructuredTaskUnderstanding } from "../runtime/task-intent.ts";
import {
  assertCanonicalDeliveryTargetInventory,
  canonicalRunStateRef,
  type CanonicalDeliveryTarget,
  type CanonicalRunState,
} from "../runtime/canonical-run-state.ts";
import type { ArtifactTarget, ConversationTurnResolution, ConversationWorkingSet, EvidenceContract, EvidenceKind, ExecutionPlan, PlanProposal, PlanStep, PlanningCapability, PlanningToolSummary, RefinementState, RequiredFact, StepExecutionBinding, SuccessCriterion } from "./contracts.ts";
import { parseRuntimeResultBinding, type RuntimeResultBinding } from "../runtime/runtime-result.ts";
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
  "explicit_caveats",
]);
const SOURCE_GROUNDING_EVIDENCE_KINDS = new Set<EvidenceKind>([
  "source_summary",
  "source_urls",
  "schema_summary",
  "record_counts",
  "table_coverage",
  "structured_extraction_artifact",
]);
const SOURCE_PROVIDER_EVIDENCE_KINDS = new Set<EvidenceKind>([
  "source_summary",
  "source_urls",
  "schema_summary",
  "record_counts",
  "table_coverage",
  "structured_extraction_artifact",
  "explicit_caveats",
]);

export function admitPlan(input: {
  runId: string;
  proposal: PlanProposal;
  availableSkills: readonly PrivateSkill[];
  availableToolNames: ReadonlySet<string>;
  availableTools?: readonly PlanningToolSummary[];
  availableCapabilities?: readonly PlanningCapability[];
  availableUploadedSourceIds?: readonly string[];
  availableVisibleDirectoryIds?: readonly string[];
  /** Accepted evidence canonically bound to the resolved prior Run. */
  reusableEvidenceKinds?: readonly EvidenceKind[];
  /** Server-validated Runtime Result inputs for this new Plan. */
  resultBindings?: readonly RuntimeResultBinding[];
  /** The Run-owned state is the only task-semantics authority at Admission. */
  canonicalState: CanonicalRunState;
  now?: number;
}): ExecutionPlan {
  if (input.canonicalState.runId !== input.runId) reject("Canonical Run State belongs to another Run");
  assertCanonicalDeliveryTargetInventory(input.canonicalState);
  const taskSemantics = input.canonicalState.intent.understanding;
  const canonicalTargets = Object.values(input.canonicalState.targets);
  const taskIntent = taskSemantics.intent;
  const canonicalRequiredToolSourceIds = input.canonicalState.intent.requiredToolSourceIds;
  const proposal = bindRequiredSkillCompanions(input.proposal, input.availableSkills);
  assertRuntimeResultBindings(input.resultBindings ?? []);
  if (proposal.steps.length === 0 || proposal.steps.length > 100) {
    reject("Plan must contain between 1 and 100 steps");
  }
  const recoveryPlan = proposal.shape === "recovery_patch";
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
  const dependedOnStepIds = new Set(proposal.steps.flatMap((step) => step.dependencies));
  const selectedSet = new Set(selectedSkillIds);
  const selectedRoleBySkillId = new Map<string, string>();
  for (const selection of proposal.selectedSkillRoles ?? []) {
    const skill = availableSkills.get(selection.skillId);
    selectedRoleBySkillId.set(skill?.id ?? selection.skillId, selection.role);
  }
  const boundSkillIds = new Set<string>();
  const canProduceFiles = hasFileProducer(input.availableToolNames);
  const availableCapabilities = input.availableCapabilities
    ?? (input.availableTools === undefined
      ? planningCapabilitiesFromToolNames([...input.availableToolNames])
      : planningCapabilitiesFromTools(input.availableTools));

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
    const constrainedUploadedSourceIds = step.sourceConstraint?.requiredUploadedSourceIds ?? [];
    const constrainedVisibleDirectoryIds = step.sourceConstraint?.requiredVisibleDirectoryIds ?? [];
    assertUnique(constrainedUploadedSourceIds, `required uploaded sources for step ${step.id}`);
    assertUnique(constrainedVisibleDirectoryIds, `required visible directories for step ${step.id}`);
    assertSourceConstraintNamespaces({
      stepId: step.id,
      requiredToolSourceIds: canonicalRequiredToolSourceIds,
      requiredUploadedSourceIds: constrainedUploadedSourceIds,
      requiredVisibleDirectoryIds: constrainedVisibleDirectoryIds,
      availableToolSourceIds: new Set((input.availableTools ?? []).flatMap((tool) => tool.source === undefined ? [] : [tool.source.id])),
      availableUploadedSourceIds: new Set(input.availableUploadedSourceIds ?? []),
      availableVisibleDirectoryIds: new Set(input.availableVisibleDirectoryIds ?? []),
      availableSkillIds: new Set(input.availableSkills.map((skill) => skill.id)),
      availableSkillNames: new Set(input.availableSkills.map((skill) => skill.name)),
    });
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
    let evidenceContract = normalizeEvidenceContract(step.evidenceContract);
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
    const targetIds = normalizeTargetIdsForStep(step, canonicalTargets);
    // A Run may own both workspace artifacts and a final conversational
    // explanation.  The aggregate TaskIntent describes the Run, while a leaf
    // owns only the targets named here.  Do not make a conversation-only
    // summary satisfy file receipts merely because a sibling leaf writes one.
    const stepTaskIntent = deliveryIntentForStep(targetIds, canonicalTargets, taskIntent);
    const fileProducingStep = kind === "leaf" && requiresFileProduction(step, stepTaskIntent);
    const artifactTargets = normalizeArtifactTargetsForStep({
      step,
      taskSemantics,
    });
    if (!canProduceFiles && fileProducingStep) {
      reject(
        `Step ${step.id} requires file or artifact production, but no file-producing Tool is available in this Run; enable write/command tools or submit a text-only Plan without file-output success criteria`,
      );
    }
    const artifactAcceptanceAvailable = input.availableToolNames.has("verify_artifact_acceptance");
    evidenceContract = normalizeWorkspaceArtifactEvidenceContract({
      contract: evidenceContract,
      terminalLeaf: kind === "leaf" && !dependedOnStepIds.has(step.id),
      fileProducingStep,
      taskIntent: stepTaskIntent,
      artifactAcceptanceAvailable,
    });
    const requiredCapabilities = new Set(step.requiredCapabilities);
    if (kind === "leaf" && stepSkillIds.length > 0) requiredCapabilities.add("skill_instruction_load");
    // Artifact delivery observations are a single receipt family. A planner
    // may ask for openability or format matching without repeating the
    // receipt's umbrella name. Bind the verifier from the Runtime-owned
    // capability catalog instead of making that redundant spelling a
    // precondition for admission.
    if (
      kind === "leaf"
      && evidenceContract?.requiredKinds.some((kind) => ARTIFACT_DELIVERY_EVIDENCE_KINDS.has(kind))
      && artifactAcceptanceAvailable
    ) {
      requiredCapabilities.add("artifact_acceptance");
    }
    const completionEvidenceContract = normalizeCompletionEvidenceContract(
      step.role,
      evidenceContract,
      stepTaskIntent,
      fileProducingStep && artifactAcceptanceAvailable,
    );
    const completionCriteria = ensureArtifactDeliverySuccessCriteria(
      normalizeCompletionSuccessCriteria(step.role, step.successCriteria, stepTaskIntent),
      completionEvidenceContract,
    );
    const targetCriteria = deliveryTargetSuccessCriteria(targetIds, canonicalTargets);
    normalizeCompletionCapabilities(step.role, requiredCapabilities, stepTaskIntent);
    const criteria: SuccessCriterion[] = [...completionCriteria, ...targetCriteria].map((criterion) => ({
      ...criterion,
      blocking: criterion.blocking ?? criterionBlocksCompletion(criterion.id, step, stepTaskIntent),
    }));
    for (const skillId of stepSkillIds) {
      if (!selectedSet.has(skillId)) reject(`Step ${step.id} binds unselected Skill ${skillId}`);
      const skill = availableSkills.get(skillId);
      if (skill === undefined) reject(`Step ${step.id} binds unavailable Skill ${skillId}`);
      boundSkillIds.add(skillId);
      for (const capability of capabilitiesRequiredBySkill(skill)) requiredCapabilities.add(capability);
    }
    if (criteria.length === 0) reject(`Step ${step.id} has no success criteria`);
    assertUnique(criteria.map((criterion) => criterion.id), `criteria for step ${step.id}`);
    const sourceConstraint = deriveRuntimeSourceConstraint({
      proposalConstraint: step.sourceConstraint,
      requiredCapabilities: [...requiredCapabilities],
      requiredToolSourceIds: canonicalRequiredToolSourceIds,
      availableCapabilities,
    });
    const constrainedToolSourceIds = sourceConstraint?.requiredToolSourceIds ?? [];
    assertSourceConstraintNamespaces({
      stepId: step.id,
      requiredToolSourceIds: constrainedToolSourceIds,
      requiredUploadedSourceIds: constrainedUploadedSourceIds,
      requiredVisibleDirectoryIds: constrainedVisibleDirectoryIds,
      availableToolSourceIds: new Set((input.availableTools ?? []).flatMap((tool) => tool.source === undefined ? [] : [tool.source.id])),
      availableUploadedSourceIds: new Set(input.availableUploadedSourceIds ?? []),
      availableVisibleDirectoryIds: new Set(input.availableVisibleDirectoryIds ?? []),
      availableSkillIds: new Set(input.availableSkills.map((skill) => skill.id)),
      availableSkillNames: new Set(input.availableSkills.map((skill) => skill.name)),
    });
    const unknownToolSources = unknownToolSourceIds(constrainedToolSourceIds, input.availableTools ?? []);
    if (unknownToolSources.length > 0) {
      reject(`Step ${step.id} requires unavailable ToolSource(s): ${unknownToolSources.join(", ")}`);
    }
    const executionBinding = createStepExecutionBinding({
      step: { ...step, targetIds, sourceConstraint, requiredCapabilities: [...requiredCapabilities] },
      artifactTargets,
      availableToolNames: input.availableToolNames,
      ...(input.availableTools === undefined ? {} : { availableTools: input.availableTools }),
      availableCapabilities,
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
    const {
      evidenceContract: _proposalEvidenceContract,
      sourceConstraint: _proposalSourceConstraint,
      targetIds: _proposalTargetIds,
      ...stepWithoutEvidenceContract
    } = step;
    return {
      ...stepWithoutEvidenceContract,
      ...(sourceConstraint === undefined ? {} : { sourceConstraint }),
      targetIds,
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

  const admittedSteps = normalizeDependencyEvidenceReuse(steps);
  assertDeliveryTargetCoverage(admittedSteps, canonicalTargets);
  assertArtifactTargetCoverage(admittedSteps, taskSemantics);
  assertStructuredCapabilitiesMatchTaskSemantics(admittedSteps, taskSemantics);
  assertTerminalArtifactDelivery(admittedSteps, taskIntent);
  assertRequiredSourceGrounding(
    admittedSteps,
    { evidenceDemand: taskIntent.sourceNeed },
    availableCapabilities,
    input.reusableEvidenceKinds ?? [],
  );
  for (const step of admittedSteps) {
    assertEvidenceContractIsProducible({
      stepId: step.id,
      role: step.role,
      evidenceContract: step.evidenceContract,
      successCriteria: step.successCriteria,
      requiredCapabilities: step.executionBinding.requiredCapabilities,
      evidenceProducers: step.executionBinding.evidenceProducers,
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
  const requiredToolSourceIds = new Set(canonicalRequiredToolSourceIds);
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
    canonicalStateRef: canonicalRunStateRef(input.canonicalState),
    ...(input.resultBindings === undefined || input.resultBindings.length === 0 ? {} : { resultBindings: input.resultBindings }),
    status: "admitted",
    steps: admittedSteps,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A visible directory is an authorization boundary, not a declaration that
 * its contents are tables.  Reject a direct/ad-hoc Plan that attempts to
 * bind a table extractor after Runtime semantics identified the input as a
 * document corpus.  Normal Planner flow removes this incompatible binding;
 * Admission keeps the invariant fail-closed for every other caller.
 */
function assertStructuredCapabilitiesMatchTaskSemantics(
  steps: readonly PlanStep[],
  taskSemantics: StructuredTaskUnderstanding | undefined,
): void {
  if (taskSemantics === undefined) return;
  const policy = taskEvidencePolicyForTaskUnderstanding(taskSemantics);
  if (policy.sourceShape !== "document_corpus") return;
  const incompatible = steps.filter((step) => step.executionBinding.requiredCapabilities.some((capability) =>
    capability === "visible_table_extraction"
    || capability === "uploaded_table_extraction"
    || capability === "workspace_structured_artifact_read",
  ));
  if (incompatible.length === 0) return;
  reject(
    `Document-corpus task semantics cannot bind structured extraction capabilities: ${incompatible.map((step) => step.id).join(", ")}`,
  );
}

function assertSourceConstraintNamespaces(input: {
  readonly stepId: string;
  readonly requiredToolSourceIds: readonly string[];
  readonly requiredUploadedSourceIds: readonly string[];
  readonly requiredVisibleDirectoryIds: readonly string[];
  readonly availableToolSourceIds: ReadonlySet<string>;
  readonly availableUploadedSourceIds: ReadonlySet<string>;
  readonly availableVisibleDirectoryIds: ReadonlySet<string>;
  readonly availableSkillIds: ReadonlySet<string>;
  readonly availableSkillNames: ReadonlySet<string>;
}): void {
  const uploaded = new Set(input.requiredUploadedSourceIds);
  const toolSources = new Set(input.requiredToolSourceIds);
  const visibleDirectories = new Set(input.requiredVisibleDirectoryIds);
  const uploadedInToolSources = [...toolSources].filter((id) => uploaded.has(id) || input.availableUploadedSourceIds.has(id));
  const uploadedInDirectories = [...visibleDirectories].filter((id) => uploaded.has(id) || input.availableUploadedSourceIds.has(id));
  const toolSourceInUploads = [...uploaded].filter((id) => toolSources.has(id) || input.availableToolSourceIds.has(id));
  const toolSourceInDirectories = [...visibleDirectories].filter((id) => toolSources.has(id) || input.availableToolSourceIds.has(id));
  const directoryInUploads = [...uploaded].filter((id) => visibleDirectories.has(id) || input.availableVisibleDirectoryIds.has(id));
  const directoryInToolSources = [...toolSources].filter((id) => visibleDirectories.has(id) || input.availableVisibleDirectoryIds.has(id));
  const skillIdentities = [...new Set([
    ...input.requiredToolSourceIds,
    ...input.requiredUploadedSourceIds,
    ...input.requiredVisibleDirectoryIds,
  ])].filter((id) => input.availableSkillIds.has(id) || input.availableSkillNames.has(id));
  if (skillIdentities.length > 0) {
    reject(`Step ${input.stepId} uses Skill ID(s) or Skill name(s) in sourceConstraint: ${skillIdentities.join(", ")}; bind Skills through skillIds and source-provider capabilities, not resource IDs`);
  }
  if (uploadedInToolSources.length > 0 || toolSourceInUploads.length > 0) {
    reject(`Step ${input.stepId} mixes uploaded source IDs with required ToolSource IDs; bind uploaded files only through requiredUploadedSourceIds`);
  }
  if (uploadedInDirectories.length > 0 || directoryInUploads.length > 0) {
    reject(`Step ${input.stepId} mixes uploaded source IDs with required visible directory IDs; bind uploaded files only through requiredUploadedSourceIds`);
  }
  if (toolSourceInDirectories.length > 0 || directoryInToolSources.length > 0) {
    reject(`Step ${input.stepId} mixes ToolSource IDs with visible directory IDs; keep sourceConstraint namespaces separate`);
  }
}

/**
 * A Planner describes capability demand, not the Host implementation chosen
 * to satisfy it. Preserve concrete Runtime-issued input identities from the
 * proposal, then derive external ToolSource bindings only from the current
 * Host capability catalog and a source explicitly required by the user.
 *
 * This deliberately ignores model-authored tool_source values. They are
 * transport/provenance hints, not authorization: accepting them would let a
 * historical MCP name leak from an acquisition leaf into downstream
 * producers. The admitted execution binding is the sole durable authority.
 */
function deriveRuntimeSourceConstraint(input: {
  readonly proposalConstraint: PlanStep["sourceConstraint"] | undefined;
  readonly requiredCapabilities: readonly string[];
  readonly requiredToolSourceIds: readonly string[];
  readonly availableCapabilities: readonly PlanningCapability[];
}): PlanStep["sourceConstraint"] | undefined {
  const requiredCapabilities = new Set(input.requiredCapabilities);
  const requiredToolSourceIds = new Set(input.requiredToolSourceIds.filter((sourceId) =>
    input.availableCapabilities.some((capability) =>
      requiredCapabilities.has(capability.id) && capability.sourceIds?.includes(sourceId) === true
    )
  ));
  const requiredUploadedSourceIds = input.proposalConstraint?.requiredUploadedSourceIds ?? [];
  const requiredVisibleDirectoryIds = input.proposalConstraint?.requiredVisibleDirectoryIds ?? [];
  if (
    requiredToolSourceIds.size === 0
    && requiredUploadedSourceIds.length === 0
    && requiredVisibleDirectoryIds.length === 0
  ) return undefined;
  return {
    ...(requiredToolSourceIds.size === 0 ? {} : { requiredToolSourceIds: [...requiredToolSourceIds] }),
    ...(requiredUploadedSourceIds.length === 0 ? {} : { requiredUploadedSourceIds }),
    ...(requiredVisibleDirectoryIds.length === 0 ? {} : { requiredVisibleDirectoryIds }),
  };
}

function assertRuntimeResultBindings(bindings: readonly RuntimeResultBinding[]): void {
  const identities = new Set<string>();
  for (const binding of bindings) {
    const parsed = parseRuntimeResultBinding(binding);
    if (parsed === undefined || parsed.relation === "dependency") reject("Plan has an invalid Runtime Result input binding");
    const result = parsed.result;
    const identity = `${binding.relation}:${result.resultId}`;
    if (identities.has(identity)) reject("Plan has duplicate Runtime Result input bindings");
    identities.add(identity);
  }
}

function assertTerminalArtifactDelivery(
  steps: readonly PlanStep[],
  taskIntent: {
    readonly deliverySurface?: "conversation" | "workspace_artifact";
    readonly artifactKind?: string;
  } | undefined,
): void {
  if (taskIntent?.deliverySurface !== "workspace_artifact" || taskIntent.artifactKind === undefined || taskIntent.artifactKind === "none") return;
  const dependedOn = new Set(steps.flatMap((step) => step.dependencies));
  const terminalLeaves = steps.filter((step) => step.kind === "leaf" && !dependedOn.has(step.id));
  const hasArtifactProducer = terminalLeaves.some((step) =>
    step.evidenceContract === undefined
      || step.evidenceContract.requiredKinds.some((kind) => ARTIFACT_DELIVERY_EVIDENCE_KINDS.has(kind)),
  );
  if (!hasArtifactProducer) {
    reject("Requested workspace artifact has no terminal producer with observable artifact evidence; a Human-in-the-Loop-only or text-only terminal step must be repaired before execution");
  }
}

function assertRequiredSourceGrounding(
  steps: readonly PlanStep[],
  taskIntent: {
    readonly evidenceDemand?: "none" | "lookup_lite" | "source_grounded" | "strict_user_source";
  } | undefined,
  availableCapabilities: readonly PlanningCapability[],
  reusableEvidenceKinds: readonly EvidenceKind[],
): void {
  if (taskIntent?.evidenceDemand === undefined || taskIntent.evidenceDemand === "none") return;
  const planDeclaresSourceAcquisition = steps.some((step) => step.role === "fact_acquisition");
  if (
    !planDeclaresSourceAcquisition
    && reusableEvidenceKinds.some((kind) => SOURCE_GROUNDING_EVIDENCE_KINDS.has(kind))
  ) return;
  const capabilityById = new Map(availableCapabilities.map((capability) => [capability.id, capability]));
  const grounded = steps.some((step) => {
    const requiredKinds = step.evidenceContract?.requiredKinds.filter((kind) => SOURCE_GROUNDING_EVIDENCE_KINDS.has(kind)) ?? [];
    if (requiredKinds.length === 0) return false;
    const producedKinds = new Set(step.requiredCapabilities.flatMap((id) => capabilityById.get(id)?.produces ?? []));
    return requiredKinds.some((kind) => producedKinds.has(kind));
  });
  if (!grounded) {
    reject(`Plan for ${taskIntent.evidenceDemand} work must bind a capability that produces required source-grounding evidence`);
  }
}

/**
 * Cross-Run evidence reuse is admitted only through the resolver's explicit
 * semantic edge to a prior Run. Completed evidence from unrelated conversation
 * history must never satisfy a new, corrected, or challenged goal.
 */
export function reusableSourceEvidenceKindsForTurn(
  workset: ConversationWorkingSet | undefined,
  turnResolution: ConversationTurnResolution | undefined,
): EvidenceKind[] {
  if (
    workset?.evidenceLedger === undefined
    || turnResolution?.targetRunId === undefined
    || turnResolution.evidenceDemand !== "source_grounded"
    || (turnResolution.relation !== "continue_prior" && turnResolution.relation !== "refine_prior")
  ) return [];
  const kinds = new Set<EvidenceKind>();
  for (const summary of workset.evidenceLedger.sourceSummaries) {
    if (summary.runId !== turnResolution.targetRunId) continue;
    if (summary.facts.length > 0 || summary.coveredTopics.length > 0) kinds.add("source_summary");
    if (summary.facts.some((fact) => fact.sourceRefs.some((reference) => reference.url !== undefined))) {
      kinds.add("source_urls");
    }
    if (summary.missingOrUnverified.length > 0) kinds.add("explicit_caveats");
  }
  return [...kinds];
}

/**
 * A primary Skill's declared companions are part of its execution contract,
 * not a Planner hint.  Normalize them before every Admission pass so preview
 * Admission and persisted Admission evaluate the same Skill graph.
 */
export function bindRequiredSkillCompanions(
  proposal: PlanProposal,
  availableSkills: readonly PrivateSkill[],
): PlanProposal {
  const skillByName = new Map(availableSkills.map((skill) => [skill.name, skill]));
  const skillById = new Map(availableSkills.map((skill) => [skill.id, skill]));
  const selected = new Set(proposal.selectedSkillIds);
  const roles = [...(proposal.selectedSkillRoles ?? [])];
  let steps = proposal.steps;
  const pending = [...selected];

  for (let parentId = pending.shift(); parentId !== undefined; parentId = pending.shift()) {
    const parent = skillById.get(parentId);
    if (parent === undefined) continue;
    for (const requiredName of parent.agentLoop?.requiredSkillNames ?? []) {
      const companion = skillByName.get(requiredName);
      if (companion === undefined) reject(`Skill ${parent.name} requires unavailable Skill ${requiredName}`);
      if (!selected.has(companion.id)) {
        selected.add(companion.id);
        pending.push(companion.id);
      }
      if (!roles.some((role) => role.skillId === companion.id)) {
        roles.push({
          skillId: companion.id,
          role: companion.agentLoop?.roles.includes("source_provider") === true ? "source_provider" : "primary_builder",
          reason: `Required by selected Skill ${parent.name}.`,
        });
      }
      const databaseProvider = companion.agentLoop?.sourceKinds.includes("database") === true;
      steps = steps.map((step) => {
        if (!step.skillIds.includes(parent.id)) return step;
        return {
          ...step,
          skillIds: step.skillIds.includes(companion.id) ? step.skillIds : [...step.skillIds, companion.id],
          requiredCapabilities: databaseProvider
            ? step.requiredCapabilities.filter((capability) => capability !== "external_api_call" && capability !== "web_research")
            : step.requiredCapabilities,
        };
      });
    }
  }
  return {
    ...proposal,
    selectedSkillIds: [...selected],
    ...(roles.length === 0 ? {} : { selectedSkillRoles: roles }),
    steps,
  };
}

/**
 * A dependency edge transports the committed Runtime Result, including the
 * source receipts that satisfied the upstream leaf.  Requiring a downstream
 * leaf to reproduce the same receipt locally creates a false gap when its
 * evidence-producer binding correctly limits it to different tools.
 *
 * This only removes source kinds a dependency explicitly owned.  The Runtime
 * still injects the immutable upstream tool receipt into Assessment, so this
 * is evidence transport, not a prose-based or path-based fallback.  Artifact
 * target ownership is deliberately excluded: each delivery target remains
 * owned and accepted exactly once by its producing leaf.
 */
function normalizeDependencyEvidenceReuse(
  steps: readonly PlanStep[],
): readonly PlanStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  return steps.map((step) => {
    if (
      step.kind !== "leaf"
      || step.role === "repair"
      || step.evidenceContract === undefined
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
        evidenceProducers: step.executionBinding.evidenceProducers.filter((producer) => requiredKinds.includes(producer.evidenceKind)),
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
  readonly role?: PlanStep["role"];
  readonly evidenceContract?: EvidenceContract;
  readonly successCriteria: readonly SuccessCriterion[];
  readonly requiredCapabilities: readonly string[];
  readonly evidenceProducers: StepExecutionBinding["evidenceProducers"];
  readonly availableCapabilities: readonly PlanningCapability[];
}): void {
  if (input.evidenceContract === undefined) return;
  const capabilityById = new Map(input.availableCapabilities.map((capability) => [capability.id, capability]));
  const boundCapabilities = input.requiredCapabilities
    .map((id) => capabilityById.get(id))
    .filter((capability): capability is PlanningCapability => capability !== undefined);
  const produced = new Set(boundCapabilities.flatMap((capability) => capability.produces));
  const boundProducerKinds = new Set(input.evidenceProducers
    .filter((producer) => producer.resolvedToolNames.length > 0)
    .map((producer) => producer.evidenceKind));
  const sourceProviderCapabilities = boundCapabilities.filter((capability) => capability.category === "skill_source_provider");
  // Source acquisition remains an Admission responsibility even when it is
  // intentionally absent from Assessment success criteria. Artifact delivery
  // retains its existing result-level blocking semantics.
  const blockingKinds = new Set(input.successCriteria
    .filter((criterion) => criterion.blocking !== false)
    .map((criterion) => criterion.id));
  const unavailable = new Set(input.evidenceContract.requiredKinds.filter((kind) =>
    TOOL_PRODUCED_EVIDENCE_KINDS.has(kind)
    && (SOURCE_GROUNDING_EVIDENCE_KINDS.has(kind) || blockingKinds.has(kind))
    && (!produced.has(kind) || !boundProducerKinds.has(kind)),
  ));
  // A fact-acquisition leaf may combine providers only for evidence that each
  // bound provider can actually publish.  Treating their capabilities as a
  // union lets an unrelated provider make a required receipt look admissible,
  // although the executing provider cannot satisfy it at runtime.  Different
  // source evidence interfaces belong in separate fact leaves with an
  // explicit dependency instead.
  if (input.role === "fact_acquisition" && sourceProviderCapabilities.length > 0) {
    for (const kind of input.evidenceContract.requiredKinds) {
      if (
        SOURCE_PROVIDER_EVIDENCE_KINDS.has(kind)
        && SOURCE_GROUNDING_EVIDENCE_KINDS.has(kind)
        && !sourceProviderCapabilities.every((capability) => capability.produces.includes(kind))
      ) {
        unavailable.add(kind);
      }
    }
  }
  if (unavailable.size > 0) {
    reject(
      `Step ${input.stepId} requires evidence that its bound capabilities cannot produce: ${[...unavailable].join(", ")}`,
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

/**
 * Extension and legacy planners can bypass ModelPlanner's proposal
 * normalization. Admission is therefore the final common boundary that turns
 * a requested workspace artifact into an observable delivery contract rather
 * than a text-only terminal leaf. This is format-neutral: the acceptance Tool
 * selects the applicable profile from the produced artifact.
 */
function normalizeWorkspaceArtifactEvidenceContract(input: {
  readonly contract: EvidenceContract | undefined;
  readonly terminalLeaf: boolean;
  readonly fileProducingStep: boolean;
  readonly taskIntent: { readonly deliverySurface?: "conversation" | "workspace_artifact"; readonly artifactKind?: string } | undefined;
  readonly artifactAcceptanceAvailable: boolean;
}): EvidenceContract | undefined {
  if (
    !input.terminalLeaf
    || !input.fileProducingStep
    || input.taskIntent?.deliverySurface !== "workspace_artifact"
    || input.taskIntent.artifactKind === undefined
    || input.taskIntent.artifactKind === "none"
  ) return input.contract;
  return {
    requiredKinds: uniqueEvidenceKindList([
      ...(input.contract?.requiredKinds ?? []),
      "artifact_path",
      "artifact_non_empty",
      "format_matches_request",
      ...(input.artifactAcceptanceAvailable
        ? ["artifact_acceptance" as const, "artifact_openable" as const]
        : []),
    ]),
    caveatPolicy: input.contract?.caveatPolicy ?? "none",
  };
}

function normalizeCompletionEvidenceContract(
  role: PlanProposal["steps"][number]["role"],
  contract: EvidenceContract | undefined,
  taskIntent: { readonly deliverySurface?: "conversation" | "workspace_artifact"; readonly artifactKind?: string } | undefined,
  requireArtifactAcceptance: boolean,
): EvidenceContract | undefined {
  // Evidence contracts are explicit semantic requirements, not a generic
  // delivery protocol. Runtime records every delivery and Tool result for
  // audit; admission must not turn those observations into a hard criterion.
  if (contract === undefined || role === "repair") return contract;
  if (taskIntent?.deliverySurface === "conversation" && taskIntent.artifactKind === "none") {
    const requiredKinds = contract.requiredKinds.filter((kind) =>
      !ARTIFACT_DELIVERY_EVIDENCE_KINDS.has(kind) && kind !== "delivery_receipt"
    );
    return requiredKinds.length === 0 ? undefined : { ...contract, requiredKinds };
  }
  if (role === undefined) return contract;
  if (!requireArtifactAcceptance || taskIntent?.deliverySurface !== "workspace_artifact") return contract;
  return {
    ...contract,
    requiredKinds: uniqueEvidenceKindList([
      ...contract.requiredKinds,
      "artifact_acceptance",
      "artifact_openable",
    ]),
  };
}

/**
 * The evidence contract is the authority for completion, but recording its
 * Runtime-owned terminal checks as criteria keeps Assessment feedback and
 * recovery focused on the missing receipt rather than on model prose.
 */
function ensureArtifactDeliverySuccessCriteria(
  criteria: readonly SuccessCriterion[],
  contract: EvidenceContract | undefined,
): readonly SuccessCriterion[] {
  if (contract === undefined) return criteria;
  const requiredTerminalKinds = contract.requiredKinds.filter((kind) =>
    kind === "artifact_acceptance" || kind === "artifact_openable",
  );
  if (requiredTerminalKinds.length === 0) return criteria;
  const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  for (const kind of requiredTerminalKinds) {
    if (byId.has(kind)) continue;
    byId.set(kind, {
      id: kind,
      description: kind === "artifact_acceptance"
        ? "The final artifact has an accepted or caveated Runtime acceptance receipt."
        : "The final artifact can be opened by the applicable Runtime acceptance check.",
      source: "planner",
    });
  }
  return [...byId.values()];
}

function uniqueEvidenceKindList(values: readonly EvidenceKind[]): EvidenceKind[] {
  return [...new Set(values)];
}

function normalizeCompletionSuccessCriteria(
  role: PlanProposal["steps"][number]["role"],
  criteria: readonly SuccessCriterion[],
  taskIntent: { readonly deliverySurface?: "conversation" | "workspace_artifact"; readonly artifactKind?: string } | undefined,
): readonly SuccessCriterion[] {
  if (role === "repair") return criteria;
  if (taskIntent?.deliverySurface !== "conversation" || taskIntent.artifactKind !== "none") return criteria;
  const normalized = criteria.filter((criterion) =>
    !ARTIFACT_DELIVERY_EVIDENCE_KINDS.has(criterion.id) && criterion.id !== "delivery_receipt"
  );
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
  if (role === "repair") return;
  if (taskIntent?.deliverySurface !== "conversation" || taskIntent.artifactKind !== "none") return;
  capabilities.delete("workspace_artifact_write");
  capabilities.delete("artifact_acceptance");
  if (!capabilities.has("conversation_delivery")) capabilities.add("conversation_delivery");
}

function criterionBlocksCompletion(
  criterionId: string,
  step: PlanProposal["steps"][number],
  taskIntent: {
    readonly deliverySurface?: "conversation" | "workspace_artifact";
    readonly artifactKind?: string;
    readonly sourceNeed?: "none" | "lookup_lite" | "source_grounded" | "strict_user_source";
  } | undefined,
): boolean {
  if (criterionId === "explicit_caveats") return false;
  if (criterionId === "artifact_acceptance" || criterionId === "artifact_openable") return false;
  if (criterionId === "source_summary" || criterionId === "source_urls") {
    return step.role === "fact_acquisition" || taskIntent?.sourceNeed === "strict_user_source";
  }
  return true;
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
  if (taskIntent?.deliverySurface === "workspace_artifact" && taskIntent.artifactKind !== "none") return true;
  return step.requiredCapabilities.includes("workspace_artifact_write")
    || step.evidenceContract?.requiredKinds.some((kind) => ARTIFACT_DELIVERY_EVIDENCE_KINDS.has(kind)) === true
    || step.successCriteria.some((criterion) => ARTIFACT_DELIVERY_EVIDENCE_KINDS.has(criterion.id));
}

/**
 * TaskIntent is a Run-level projection.  A multi-target Run can contain both
 * workspace and conversation delivery, so Admission must project that intent
 * through the leaf's exact target ownership before it derives capabilities or
 * evidence gates.  Targetless prerequisite leaves retain the legacy Run-level
 * fallback because they do not themselves claim a terminal delivery target.
 */
function deliveryIntentForStep(
  targetIds: readonly string[],
  canonicalTargets: readonly CanonicalDeliveryTarget[],
  fallback: {
    readonly deliverySurface?: "conversation" | "workspace_artifact";
    readonly artifactKind?: string;
    readonly sourceNeed?: "none" | "lookup_lite" | "source_grounded" | "strict_user_source";
  } | undefined,
): {
  readonly deliverySurface?: "conversation" | "workspace_artifact";
  readonly artifactKind?: string;
  readonly sourceNeed?: "none" | "lookup_lite" | "source_grounded" | "strict_user_source";
} | undefined {
  if (targetIds.length === 0) return fallback;
  const targets = new Map(canonicalTargets.map((target) => [target.targetId, target]));
  const owned = targetIds
    .map((targetId) => targets.get(targetId))
    .filter((target): target is CanonicalDeliveryTarget => target !== undefined);
  const artifactTarget = owned.find((target) => target.surface === "workspace_artifact" && target.kind !== "none");
  if (artifactTarget !== undefined) {
    return {
      deliverySurface: "workspace_artifact",
      artifactKind: artifactTarget.kind,
      ...(fallback?.sourceNeed === undefined ? {} : { sourceNeed: fallback.sourceNeed }),
    };
  }
  return {
    deliverySurface: "conversation",
    artifactKind: "none",
    ...(fallback?.sourceNeed === undefined ? {} : { sourceNeed: fallback.sourceNeed }),
  };
}

function normalizeArtifactTargetsForStep(input: {
  readonly step: PlanProposal["steps"][number];
  readonly taskSemantics?: StructuredTaskUnderstanding;
}): readonly ArtifactTarget[] {
  const requested = input.taskSemantics?.artifactTargets ?? [];
  const ownedDeliveryTargetIds = new Set(input.step.targetIds ?? []);
  return requested.filter((target) => ownedDeliveryTargetIds.has(target.deliveryTargetId)).map((target) => {
    return {
      id: target.id,
      deliveryTargetId: target.deliveryTargetId,
      purpose: target.purpose,
      kind: target.kind,
      ...(target.format === undefined ? {} : { format: target.format }),
      terminalRequired: true,
    };
  });
}

function normalizeTargetIdsForStep(
  step: PlanProposal["steps"][number],
  canonicalTargets: readonly CanonicalDeliveryTarget[],
): readonly string[] {
  const requestedIds = new Set(canonicalTargets.map((target) => target.targetId));
  const targetIds = [...new Set(step.targetIds ?? [])];
  const unknown = targetIds.filter((targetId) => !requestedIds.has(targetId));
  if (unknown.length > 0) reject(`Step ${step.id} binds unknown delivery target(s): ${unknown.join(", ")}`);
  return targetIds;
}

function deliveryTargetSuccessCriteria(
  targetIds: readonly string[],
  canonicalTargets: readonly CanonicalDeliveryTarget[],
): readonly SuccessCriterion[] {
  const byId = new Map(canonicalTargets.map((target) => [target.targetId, target]));
  return targetIds.map((targetId) => {
    const target = byId.get(targetId);
    if (target === undefined) reject(`Unknown delivery target ${targetId}`);
    return {
      id: `delivery_target:${targetId}`,
      targetId,
      description: `The delivered result fulfills canonical target ${targetId}: ${target.purpose}`,
      source: "task" as const,
      verification: "model_judged" as const,
      blocking: true,
    };
  });
}

function assertDeliveryTargetCoverage(
  steps: readonly PlanStep[],
  canonicalTargets: readonly CanonicalDeliveryTarget[],
): void {
  if (canonicalTargets.length === 0) return;
  const owners = new Map<string, string[]>();
  for (const step of steps) {
    for (const targetId of step.executionBinding.targetIds) {
      owners.set(targetId, [...(owners.get(targetId) ?? []), step.id]);
    }
  }
  const missing = canonicalTargets.filter((target) => (owners.get(target.targetId)?.length ?? 0) === 0);
  const duplicate = [...owners].filter(([, stepIds]) => stepIds.length > 1);
  if (missing.length > 0 || duplicate.length > 0) {
    const details = [
      ...(missing.length === 0 ? [] : [`missing ${missing.map((target) => target.targetId).join(", ")}`]),
      ...(duplicate.length === 0 ? [] : [`multiply owned ${duplicate.map(([targetId]) => targetId).join(", ")}`]),
    ];
    reject(`Plan targetIds must cover canonical delivery targets exactly once: ${details.join("; ")}`);
  }
}

function assertArtifactTargetCoverage(
  steps: readonly PlanStep[],
  taskSemantics?: StructuredTaskUnderstanding,
): void {
  const requested = taskSemantics?.artifactTargets ?? [];
  if (requested.length === 0) return;
  const targets = steps.flatMap((step) => step.executionBinding.artifactTargets ?? []);
  const ids = new Set<string>();
  for (const target of targets) {
    if (ids.has(target.id)) reject(`Artifact target ${target.id} is declared by more than one step`);
    ids.add(target.id);
  }
  const terminal = targets.filter((target) => target.terminalRequired);
  const requestedHasExplicitIdentity = taskSemantics?.deliverables?.filter((item) =>
    item.surface === "workspace_artifact" && item.kind !== "none"
  ).every((item) => item.targetId !== undefined && item.purpose !== undefined) === true;
  if (requestedHasExplicitIdentity) {
    const terminalIds = new Set(terminal.map((target) => target.id));
    const missing = requested.filter((target) => !terminalIds.has(target.id));
    const unexpected = terminal.filter((target) => !requested.some((requestedTarget) => requestedTarget.id === target.id));
    if (missing.length > 0 || unexpected.length > 0) {
      const details = [
        ...(missing.length === 0 ? [] : [`missing ${missing.map((target) => target.id).join(", ")}`]),
        ...(unexpected.length === 0 ? [] : [`unexpected ${unexpected.map((target) => target.id).join(", ")}`]),
      ];
      reject(`Plan targetIds must cover the requested targets exactly: ${details.join("; ")}`);
    }
    return;
  }
  const targetCounts = countArtifactTargetShapes(terminal);
  const requestedCounts = countArtifactTargetShapes(requested);
  for (const [shape, count] of requestedCounts) {
    if ((targetCounts.get(shape) ?? 0) < count) {
      reject(`Plan has no terminal artifactTargets covering requested ${shape} deliverable(s)`);
    }
  }
}

function countArtifactTargetShapes(values: readonly Pick<ArtifactTarget, "kind" | "format">[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const shape = `${value.kind.trim().toLowerCase()}:${value.format?.trim().toLowerCase().replace(/^\./u, "") ?? "*"}`;
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  return counts;
}

function reject(message: string): never {
  throw new AppError("PLAN_NOT_ADMITTED", message, 422);
}
