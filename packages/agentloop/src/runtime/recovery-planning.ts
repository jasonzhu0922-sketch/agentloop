import { AppError, badRequest } from "../shared/errors.ts";
import { requireRecord, requireString, requireStringArray } from "../shared/validation.ts";
import { parseCriterionBasis } from "../planning/criterion-basis.ts";
import type {
  EvidenceContract,
  FailedBoundary,
  OutcomeLeafRole,
  PlanProposal,
  PlanRevisionAssessment,
  PlanRevisionAssessmentInput,
  PlanRevisionAssessor,
  PlanStepKind,
  PlanStepProposal,
  RefinementState,
  SelectedSkillRole,
  SuccessCriterion,
  PlanningCapability,
  PlanningToolSummary,
} from "../planning/contracts.ts";
import type { CanonicalGoalGap, CanonicalRunState } from "./canonical-run-state.ts";
import type { ModelAdapter, ModelToolCall, RuntimeContextSnapshot } from "./contracts.ts";
import type { RuntimeActionRecord } from "./runtime-action-repository.ts";

export type RecoveryDecisionKind = "resume_step" | "revise_plan" | "ask_user" | "fail";

export interface RecoveryDecisionProposal {
  readonly actionId: string;
  readonly expectedActionRevision: number;
  readonly decision: RecoveryDecisionKind;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
  readonly planRevision?: PlanProposal;
  readonly question?: string;
}

export interface RecoveryPlannerInput {
  readonly runId: string;
  readonly userInput: string;
  readonly action: RuntimeActionRecord;
  readonly plan?: PlanRevisionAssessmentInput["currentPlan"];
  readonly failedBoundary?: FailedBoundary;
  readonly events: readonly Readonly<{ seq: number; type: string; data: Readonly<Record<string, unknown>> }>[];
  readonly userResponses: readonly Readonly<{ actionId: string; response: string; createdAt: number }>[];
  readonly canonicalGap?: CanonicalGoalGap;
  readonly canonicalState?: CanonicalRunState;
  readonly availableTools?: readonly PlanningToolSummary[];
  readonly availableSkills?: readonly { readonly id: string; readonly name: string; readonly description: string }[];
  readonly availableCapabilities?: readonly PlanningCapability[];
  /** Unsafe Actions whose effect remains unknown at this Recovery boundary. */
  readonly unresolvedActionEffects?: readonly Readonly<{
    readonly actionId: string;
    readonly stepId?: string;
    readonly kind: string;
    readonly toolName?: string;
    readonly effectState: "unknown";
  }>[];
}

export interface RecoveryPlanner {
  decide(input: RecoveryPlannerInput, signal?: AbortSignal): Promise<RecoveryDecisionProposal>;
}

const SUBMIT_RECOVERY_DECISION_TOOL = {
  name: "submit_recovery_decision",
  description: "Submit the only valid recovery decision. Do not use prose for recovery control.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["actionId", "expectedActionRevision", "decision", "rationale", "evidenceRefs"],
    properties: {
      actionId: { type: "string" },
      expectedActionRevision: { type: "integer", minimum: 1 },
      decision: { enum: ["resume_step", "revise_plan", "ask_user", "fail"] },
      rationale: { type: "string" },
      evidenceRefs: { type: "array", items: { type: "string" } },
      planRevision: planProposalSchema(),
      question: { type: "string" },
    },
  },
} as const;

const SUBMIT_PLAN_REVISION_ASSESSMENT_TOOL = {
  name: "submit_plan_revision_assessment",
  description: "Submit the independent assessment of a proposed recovery Plan revision.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["approved", "feedback", "evidenceRefs"],
    properties: {
      approved: { type: "boolean" },
      feedback: { type: "string" },
      evidenceRefs: { type: "array", items: { type: "string" } },
    },
  },
} as const;

export class ModelRecoveryPlanner implements RecoveryPlanner {
  private readonly model: ModelAdapter;

  constructor(model: ModelAdapter) {
    this.model = model;
  }

  async decide(input: RecoveryPlannerInput, signal?: AbortSignal): Promise<RecoveryDecisionProposal> {
    const response = await this.model.complete({
      runId: input.runId,
      phase: "planning",
      systemPrompt: [
        "You are the recovery planner in a plan-first runtime.",
        "You cannot execute tools, declare completion, or alter recovery facts.",
        "For assessment_failed_boundary, choose revise_plan, ask_user or fail. resume_step is reserved for interrupted execution and cannot restart an exhausted candidate loop.",
        "Choose exactly one structured recovery decision. replayPolicy=unsafe never permits resume_step.",
        "A Plan revision retires a Step from future scheduling only. It never erases, authorizes, compensates for, or replays an Action already recorded for that Step. If a retired Action has an unknown external effect, preserve that fact and choose a continuation that neither relies on nor repeats that effect, or fail when no such continuation exists.",
        "If the failed boundary shows the current Plan's evidence contract is wrong for the evidence that actually exists, prefer revise_plan and repair the Plan boundary rather than resubmitting the same step.",
        "Use failedBoundary.unmetCriteria to identify the actual result gap and any contractIssue. Choose a continuation that can change that cause, considering previously attempted strategies, available capabilities and the remaining gap budget in runtimeContext. A locally stalled turn does not prove global exhaustion. Never repeat unchanged work or weaken an explicit user requirement to obtain approval.",
        "Do not ask the user to authorize a Plan revision, confirm whether a recorded Action had an effect, or accept a candidate as evidence that it meets a result criterion. Those are Runtime recovery and assessment obligations. Use ask_user only for a concrete, missing input that only the user can supply and that an execution continuation will consume; a missing capability to observe or verify the requested result is not such an input. When the available capabilities cannot change or verify a remaining result gap, choose fail and retain the stage artifact and its evidence.",
      ].join("\n"),
      runtimeContext: recoveryRuntimeContext(input),
      messages: [{ role: "user", content: input.userInput }],
      tools: [SUBMIT_RECOVERY_DECISION_TOOL],
      toolChoice: { name: SUBMIT_RECOVERY_DECISION_TOOL.name },
    }, signal);
    if (response.finishReason === "length" || response.toolCalls.length !== 1 || response.toolCalls[0].name !== SUBMIT_RECOVERY_DECISION_TOOL.name) {
      throw new AppError("PLANNING_ERROR", "Recovery Planner must submit exactly one structured recovery decision", 422);
    }
    return parseRecoveryDecision(response.toolCalls[0]);
  }
}

export class ModelPlanRevisionAssessor implements PlanRevisionAssessor {
  private readonly model: ModelAdapter;

  constructor(model: ModelAdapter) {
    this.model = model;
  }

  async assess(input: PlanRevisionAssessmentInput, signal?: AbortSignal): Promise<PlanRevisionAssessment> {
    const response = await this.model.complete({
      runId: input.runId,
      phase: "assessment",
      systemPrompt: [
        "You are the independent Plan Revision Assessor in a plan-first runtime.",
        "Approve only when the revised Plan still covers the explicit user request. Retiring a Step does not discard its recorded Actions: an unknown external effect remains a durable caveat and the revised Plan must neither claim it succeeded nor replay or depend on it without a new justified execution path.",
        "Check criterion basis against the original userInput: a plan may replace execution methods and repair unjustified derived conditions, but cannot remove or weaken the original requested result, source constraints or explicit user requirements. A quote and rationale are provenance, not proof that a derived condition is necessary.",
        "Do not infer completion from an artifact, model prose, or an event alone.",
        "Return exactly one submit_plan_revision_assessment tool call.",
      ].join("\n"),
      runtimeContext: planRevisionRuntimeContext(input),
      messages: [{ role: "user", content: input.userInput }],
      tools: [SUBMIT_PLAN_REVISION_ASSESSMENT_TOOL],
      toolChoice: { name: SUBMIT_PLAN_REVISION_ASSESSMENT_TOOL.name },
    }, signal);
    if (response.finishReason === "length" || response.toolCalls.length !== 1 || response.toolCalls[0].name !== SUBMIT_PLAN_REVISION_ASSESSMENT_TOOL.name) {
      throw new AppError("ASSESSMENT_ERROR", "Plan Revision Assessor must submit exactly one structured assessment", 422);
    }
    const value = requireRecord(response.toolCalls[0].arguments, "submit_plan_revision_assessment arguments");
    if (typeof value.approved !== "boolean") throw badRequest("approved must be boolean");
    return {
      approved: value.approved,
      feedback: typeof value.feedback === "string" ? value.feedback.trim().slice(0, 8_000) : "",
      evidenceRefs: requireStringArray(value.evidenceRefs, "evidenceRefs", 100),
    };
  }
}

export function parseRecoveryDecision(call: ModelToolCall): RecoveryDecisionProposal {
  try {
    const value = requireRecord(call.arguments, "submit_recovery_decision arguments");
    const decision = requireString(value.decision, "decision", { max: 32 }) as RecoveryDecisionKind;
    if (!["resume_step", "revise_plan", "ask_user", "fail"].includes(decision)) {
      throw badRequest("decision is invalid");
    }
    if (!Number.isSafeInteger(value.expectedActionRevision) || (value.expectedActionRevision as number) < 1) {
      throw badRequest("expectedActionRevision must be a positive integer");
    }
    const planRevision = value.planRevision === undefined ? undefined : parsePlanProposal(value.planRevision);
    const question = value.question === undefined ? undefined : requireString(value.question, "question", { max: 8_000 });
    if (decision === "revise_plan" && planRevision === undefined) throw badRequest("planRevision is required for revise_plan");
    if (decision !== "revise_plan" && planRevision !== undefined) throw badRequest("planRevision is only valid for revise_plan");
    if (decision === "ask_user" && question === undefined) throw badRequest("question is required for ask_user");
    if (decision !== "ask_user" && question !== undefined) throw badRequest("question is only valid for ask_user");
    return {
      actionId: requireString(value.actionId, "actionId", { max: 128 }),
      expectedActionRevision: value.expectedActionRevision as number,
      decision,
      rationale: requireString(value.rationale, "rationale", { max: 8_000 }),
      evidenceRefs: requireStringArray(value.evidenceRefs, "evidenceRefs", 100),
      ...(planRevision === undefined ? {} : { planRevision }),
      ...(question === undefined ? {} : { question }),
    };
  } catch (error) {
    if (error instanceof AppError) throw new AppError("PLANNING_ERROR", error.message, 422);
    throw error;
  }
}

function recoveryRuntimeContext(input: RecoveryPlannerInput): RuntimeContextSnapshot {
  return {
    id: `${input.runId}:recovery:${input.action.id}:${input.action.revision}`,
    phase: "planning",
    content: JSON.stringify({
      recoveryAction: {
        id: input.action.id,
        kind: input.action.kind,
        state: input.action.state,
        revision: input.action.revision,
        replayPolicy: input.action.replayPolicy,
        attempt: input.action.attempt,
        maxAttempts: input.action.maxAttempts,
        metadata: input.action.metadata,
      },
      currentPlan: input.plan,
      failedBoundary: input.failedBoundary,
      canonicalGap: input.canonicalGap,
      canonicalState: input.canonicalState,
      availableTools: input.availableTools,
      availableSkills: input.availableSkills,
      availableCapabilities: input.availableCapabilities,
      unresolvedActionEffects: input.unresolvedActionEffects,
      userResponses: input.userResponses,
      events: input.events.slice(-100),
    }),
  };
}

function planRevisionRuntimeContext(input: PlanRevisionAssessmentInput): RuntimeContextSnapshot {
  return {
    id: `${input.runId}:plan-revision:${input.currentPlan.id}:${input.currentPlan.version + 1}`,
    phase: "assessment",
    content: JSON.stringify({
      currentPlan: input.currentPlan,
      canonicalState: input.canonicalState,
      proposedPlan: input.proposal,
      retiredStepIds: input.retiredStepIds,
      recoveryAction: input.recoveryAction,
    }),
  };
}

function parsePlanProposal(value: unknown): PlanProposal {
  const record = requireRecord(value, "planRevision");
  if (!Array.isArray(record.steps) || record.steps.length === 0 || record.steps.length > 100) {
    throw badRequest("planRevision.steps must contain between 1 and 100 entries");
  }
  return {
    goal: requireString(record.goal, "planRevision.goal", { max: 20_000 }),
    ...(record.shape === undefined ? {} : { shape: parsePlanShape(record.shape) }),
    selectedSkillIds: requireStringArray(record.selectedSkillIds, "planRevision.selectedSkillIds", 100),
    ...(record.selectedSkillRoles === undefined ? {} : { selectedSkillRoles: parseSelectedSkillRoles(record.selectedSkillRoles) }),
    steps: record.steps.map((step, index) => parseStep(step, index)),
  };
}

function parseStep(value: unknown, index: number): PlanStepProposal {
  const record = requireRecord(value, `planRevision.steps[${index}]`);
  if (!Array.isArray(record.successCriteria) || record.successCriteria.length === 0 || record.successCriteria.length > 50) {
    throw badRequest(`planRevision.steps[${index}].successCriteria must contain between 1 and 50 entries`);
  }
  return {
    id: requireString(record.id, `planRevision.steps[${index}].id`, { max: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }),
    ...(record.kind === undefined ? {} : { kind: parseStepKind(record.kind, index) }),
    ...(record.parentId === undefined ? {} : { parentId: requireString(record.parentId, `planRevision.steps[${index}].parentId`, { max: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }) }),
    objective: requireString(record.objective, `planRevision.steps[${index}].objective`, { max: 20_000 }),
    dependencies: requireStringArray(record.dependencies, `planRevision.steps[${index}].dependencies`, 100),
    ...(record.role === undefined ? {} : { role: parseOutcomeLeafRole(record.role, index) }),
    ...(record.refinementState === undefined ? {} : { refinementState: parseRefinementState(record.refinementState, index) }),
    skillIds: requireStringArray(record.skillIds, `planRevision.steps[${index}].skillIds`, 100),
    requiredCapabilities: requireStringArray(record.requiredCapabilities, `planRevision.steps[${index}].requiredCapabilities`, 100),
    ...(record.targetIds === undefined ? {} : { targetIds: requireStringArray(record.targetIds, "targetIds", 100) }),
    ...(record.sourceConstraint === undefined ? {} : { sourceConstraint: parseRecoverySourceConstraint(record.sourceConstraint) }),
    ...(record.requiredFacts === undefined ? {} : { requiredFacts: parseRecoveryRequiredFacts(record.requiredFacts) }),
    ...(record.evidenceContract === undefined ? {} : { evidenceContract: parseEvidenceContract(record.evidenceContract, index) }),
    successCriteria: record.successCriteria.map((criterion, criterionIndex): SuccessCriterion => {
      const row = requireRecord(criterion, `planRevision.steps[${index}].successCriteria[${criterionIndex}]`);
      return {
        id: requireString(row.id, "criterion id", { max: 128 }),
        description: requireString(row.description, "criterion description", { max: 2_000 }),
        source: row.source === "task" ? "task" : "planner",
        ...(row.targetId === undefined ? {} : { targetId: requireString(row.targetId, "criterion targetId", { max: 128 }) }),
        ...(row.basis === undefined ? {} : { basis: parseCriterionBasis(row.basis, "criterion basis") }),
        ...(row.blocking === undefined ? {} : { blocking: parseBoolean(row.blocking, "criterion blocking") }),
        ...(row.verification === undefined ? {} : { verification: parseCriterionVerification(row.verification) }),
      };
    }),
  };
}

function parseRecoveryRequiredFacts(value: unknown): NonNullable<PlanStepProposal["requiredFacts"]> {
  if (!Array.isArray(value) || value.length > 20) throw badRequest("requiredFacts must be an array of at most 20 facts");
  return value.map((item) => {
    const row = requireRecord(item, "required fact");
    return { id: requireString(row.id, "fact id", { max: 128 }),
      description: requireString(row.description, "fact description", { max: 2_000 }),
      evidenceKinds: requireStringArray(row.evidenceKinds, "fact evidenceKinds", 20),
      basis: parseCriterionBasis(row.basis, "fact basis") };
  });
}

function parseRecoverySourceConstraint(value: unknown): NonNullable<PlanStepProposal["sourceConstraint"]> {
  const row = requireRecord(value, "sourceConstraint");
  return {
    ...(row.requiredToolSourceIds === undefined ? {} : { requiredToolSourceIds: requireStringArray(row.requiredToolSourceIds, "requiredToolSourceIds", 100) }),
    ...(row.requiredUploadedSourceIds === undefined ? {} : { requiredUploadedSourceIds: requireStringArray(row.requiredUploadedSourceIds, "requiredUploadedSourceIds", 100) }),
    ...(row.requiredVisibleDirectoryIds === undefined ? {} : { requiredVisibleDirectoryIds: requireStringArray(row.requiredVisibleDirectoryIds, "requiredVisibleDirectoryIds", 100) }),
  };
}

function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw badRequest(`${name} must be a boolean`);
  return value;
}

function parseCriterionVerification(value: unknown): NonNullable<SuccessCriterion["verification"]> {
  if (value === "deterministic" || value === "model_judged" || value === "decision_context") return value;
  throw badRequest("criterion verification is invalid");
}

function planProposalSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["goal", "selectedSkillIds", "steps"],
    properties: {
      goal: { type: "string" },
      shape: { enum: ["single_leaf", "fact_then_produce", "multi_deliverable", "pipeline", "recovery_patch"] },
      selectedSkillIds: { type: "array", items: { type: "string" } },
      selectedSkillRoles: { type: "array", items: { type: "object" } },
      steps: { type: "array", items: { type: "object" } },
    },
  };
}

function parsePlanShape(value: unknown): PlanProposal["shape"] {
  const shape = requireString(value, "planRevision.shape", { max: 32 });
  if (shape === "single_leaf" || shape === "fact_then_produce" || shape === "multi_deliverable" || shape === "pipeline" || shape === "recovery_patch") {
    return shape;
  }
  throw badRequest("planRevision.shape is invalid");
}

function parseSelectedSkillRoles(value: unknown): SelectedSkillRole[] {
  if (!Array.isArray(value)) throw badRequest("planRevision.selectedSkillRoles must be an array");
  return value.map((item, index): SelectedSkillRole => {
    const record = requireRecord(item, `planRevision.selectedSkillRoles[${index}]`);
    return {
      skillId: requireString(record.skillId, `planRevision.selectedSkillRoles[${index}].skillId`, { max: 128 }),
      role: parseSkillRole(record.role, index),
      reason: requireString(record.reason, `planRevision.selectedSkillRoles[${index}].reason`, { max: 1_000 }),
    };
  });
}

function parseSkillRole(value: unknown, index: number): SelectedSkillRole["role"] {
  const role = requireString(value, `planRevision.selectedSkillRoles[${index}].role`, { max: 32 });
  if (role === "primary_builder" || role === "source_provider" || role === "support" || role === "qa") return role;
  throw badRequest(`planRevision.selectedSkillRoles[${index}].role is invalid`);
}

function parseStepKind(value: unknown, index: number): PlanStepKind {
  const kind = requireString(value, `planRevision.steps[${index}].kind`, { max: 32 });
  if (kind === "leaf" || kind === "milestone") return kind;
  throw badRequest(`planRevision.steps[${index}].kind is invalid`);
}

function parseOutcomeLeafRole(value: unknown, index: number): OutcomeLeafRole {
  const role = requireString(value, `planRevision.steps[${index}].role`, { max: 32 });
  if (role === "fact_acquisition" || role === "produce" || role === "deliver" || role === "repair") return role;
  throw badRequest(`planRevision.steps[${index}].role is invalid`);
}

function parseRefinementState(value: unknown, index: number): RefinementState {
  const state = requireString(value, `planRevision.steps[${index}].refinementState`, { max: 32 });
  if (state === "not_refinable" || state === "pending_facts" || state === "ready_to_refine" || state === "refining" || state === "refined") return state;
  throw badRequest(`planRevision.steps[${index}].refinementState is invalid`);
}

function parseEvidenceContract(value: unknown, index: number): EvidenceContract {
  const record = requireRecord(value, `planRevision.steps[${index}].evidenceContract`);
  const requiredKinds = requireStringArray(record.requiredKinds, `planRevision.steps[${index}].evidenceContract.requiredKinds`, 20);
  if (requiredKinds.length === 0) throw badRequest(`planRevision.steps[${index}].evidenceContract.requiredKinds must contain at least 1 entry`);
  const normalizedKinds = requiredKinds
    .filter((kind) => kind.trim() !== "basic_navigation")
    .map((kind, kindIndex) => parseEvidenceKind(kind, index, kindIndex));
  if (normalizedKinds.length === 0) {
    throw badRequest(`planRevision.steps[${index}].evidenceContract.requiredKinds must contain at least 1 Runtime evidence kind`);
  }
  const caveatPolicy = requireString(record.caveatPolicy, `planRevision.steps[${index}].evidenceContract.caveatPolicy`, { max: 64 });
  if (caveatPolicy === "none" || caveatPolicy === "mark_unverified_facts" || caveatPolicy === "strict_fail_on_missing_source") {
    return { requiredKinds: normalizedKinds, caveatPolicy };
  }
  throw badRequest(`planRevision.steps[${index}].evidenceContract.caveatPolicy is invalid`);
}

function parseEvidenceKind(value: string, stepIndex: number, kindIndex: number): EvidenceContract["requiredKinds"][number] {
  const kind = value.trim();
  if (
    kind === "source_summary"
    || kind === "source_urls"
    || kind === "schema_summary"
    || kind === "record_counts"
    || kind === "structured_extraction_artifact"
    || kind === "artifact_path"
    || kind === "artifact_non_empty"
    || kind === "artifact_acceptance"
    || kind === "artifact_openable"
    || kind === "format_matches_request"
    || kind === "delivery_receipt"
    || kind === "explicit_caveats"
  ) {
    return kind;
  }
  throw badRequest(`planRevision.steps[${stepIndex}].evidenceContract.requiredKinds[${kindIndex}] is invalid`);
}
