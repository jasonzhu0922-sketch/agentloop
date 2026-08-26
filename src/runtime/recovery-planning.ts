import { AppError, badRequest } from "../shared/errors.ts";
import { requireRecord, requireString, requireStringArray } from "../shared/validation.ts";
import type { PlanProposal, PlanRevisionAssessment, PlanRevisionAssessmentInput, PlanRevisionAssessor, PlanStepProposal, SuccessCriterion } from "../planning/contracts.ts";
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
  readonly events: readonly Readonly<{ seq: number; type: string; data: Readonly<Record<string, unknown>> }>[];
  readonly userResponses: readonly Readonly<{ actionId: string; response: string; createdAt: number }>[];
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
        "Choose exactly one structured recovery decision. replayPolicy=unsafe never permits resume_step.",
        "A revise_plan decision may retire only unfinished work with no unconfirmed external effect; it must include the complete revised Plan.",
        "ask_user is required when an unknown external effect or user-only fact prevents a safe conclusion.",
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
        "Approve only when the revised Plan still covers the explicit user request and every retired step is unfinished and has no unsafe unconfirmed effect.",
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
    selectedSkillIds: requireStringArray(record.selectedSkillIds, "planRevision.selectedSkillIds", 100),
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
    objective: requireString(record.objective, `planRevision.steps[${index}].objective`, { max: 20_000 }),
    dependencies: requireStringArray(record.dependencies, `planRevision.steps[${index}].dependencies`, 100),
    skillIds: requireStringArray(record.skillIds, `planRevision.steps[${index}].skillIds`, 100),
    recommendedToolNames: requireStringArray(record.recommendedToolNames, `planRevision.steps[${index}].recommendedToolNames`, 100),
    successCriteria: record.successCriteria.map((criterion, criterionIndex): SuccessCriterion => {
      const row = requireRecord(criterion, `planRevision.steps[${index}].successCriteria[${criterionIndex}]`);
      return {
        id: requireString(row.id, "criterion id", { max: 128 }),
        description: requireString(row.description, "criterion description", { max: 2_000 }),
        source: "planner",
      };
    }),
  };
}

function planProposalSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["goal", "selectedSkillIds", "steps"],
    properties: {
      goal: { type: "string" },
      selectedSkillIds: { type: "array", items: { type: "string" } },
      steps: { type: "array", items: { type: "object" } },
    },
  };
}
