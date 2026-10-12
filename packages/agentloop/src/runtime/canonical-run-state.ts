import { randomUUID } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import type { ConversationTurnResolution, ExecutionPlan, FailedBoundary, SkillComplianceAssessment, StepEvidence } from "../planning/contracts.ts";
import type { StructuredTaskUnderstanding } from "./task-intent.ts";

export type CanonicalRunPhase =
  | "understood"
  | "planned"
  | "executing"
  | "blocked"
  | "ready_for_terminal"
  | "completed"
  | "failed"
  | "cancelled";

export type CanonicalStepStatus = "pending" | "running" | "satisfied" | "repairable" | "blocked" | "retired";

export interface CanonicalRunStateRef {
  readonly stateId: string;
  readonly runId: string;
  readonly intentId: string;
  readonly revision: number;
}

export interface CanonicalGoalGap {
  readonly id: string;
  readonly stepId?: string;
  readonly targetId?: string;
  readonly status: "open" | "resolved";
  readonly missingEvidenceKinds: readonly string[];
  readonly violatedSkillRequirements: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly suggestedAction: FailedBoundary["suggestedRepairShape"];
  readonly openedAt: number;
  readonly resolvedAt?: number;
}

export interface CanonicalStepProgress {
  readonly stepId: string;
  readonly targetIds: readonly string[];
  readonly status: CanonicalStepStatus;
  readonly evidenceRefs: readonly string[];
  readonly assessmentId?: string;
  readonly updatedAt: number;
}

export interface CanonicalDeliveryTarget {
  readonly targetId: string;
  readonly purpose: string;
  readonly surface: "conversation" | "workspace_artifact";
  readonly kind: string;
  readonly format?: string;
  readonly expectedCount: number;
  readonly terminalRequired: true;
  readonly status: "open" | "accepted";
  readonly ownerStepIds: readonly string[];
  readonly claims: readonly {
    readonly stepId: string;
    readonly assessmentId: string;
    readonly evidenceRefs: readonly string[];
    readonly acceptedAt: number;
  }[];
}

export interface CanonicalRunState {
  readonly schema: "agentloop.canonicalRunState/v1";
  readonly stateId: string;
  readonly runId: string;
  readonly revision: number;
  readonly phase: CanonicalRunPhase;
  readonly intent: {
    readonly id: string;
    readonly revision: 1;
    readonly userInput: string;
    readonly turnResolution?: ConversationTurnResolution;
    readonly understanding: StructuredTaskUnderstanding;
    /** Exact ToolSource identities explicitly required by the user for this Run. */
    readonly requiredToolSourceIds: readonly string[];
    readonly lockedAt: number;
  };
  readonly plan?: {
    readonly id: string;
    readonly version: number;
  };
  readonly steps: Readonly<Record<string, CanonicalStepProgress>>;
  readonly targets: Readonly<Record<string, CanonicalDeliveryTarget>>;
  readonly gaps: readonly CanonicalGoalGap[];
  readonly terminal?: {
    readonly status: "completed" | "failed" | "cancelled";
    readonly reasonCode: string;
    readonly committedAt: number;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function createCanonicalRunState(input: {
  readonly runId: string;
  readonly userInput: string;
  readonly turnResolution?: ConversationTurnResolution;
  readonly understanding: StructuredTaskUnderstanding;
  readonly requiredToolSourceIds?: readonly string[];
  readonly now?: number;
}): CanonicalRunState {
  const now = input.now ?? Date.now();
  const deliverables = input.turnResolution?.mode === "reply"
    ? []
    : input.understanding.deliverables ?? input.turnResolution?.taskIntent.deliverables ?? [];
  const targets = Object.fromEntries(deliverables.map((target) => [target.targetId, Object.freeze({
    targetId: target.targetId,
    purpose: target.purpose,
    surface: target.surface,
    kind: target.kind,
    ...(target.format === undefined ? {} : { format: target.format }),
    expectedCount: target.expectedArtifactCount,
    terminalRequired: true as const,
    status: "open" as const,
    ownerStepIds: Object.freeze([] as string[]),
    claims: Object.freeze([]),
  })]));
  const gaps = deliverables.map((target) => Object.freeze({
    id: randomUUID(),
    targetId: target.targetId,
    status: "open" as const,
    missingEvidenceKinds: Object.freeze([`delivery_target:${target.targetId}`]),
    violatedSkillRequirements: Object.freeze([] as string[]),
    evidenceRefs: Object.freeze([] as string[]),
    suggestedAction: "revise_plan" as const,
    openedAt: now,
  }));
  return Object.freeze({
    schema: "agentloop.canonicalRunState/v1",
    stateId: randomUUID(),
    runId: input.runId,
    revision: 1,
    phase: "understood",
    intent: Object.freeze({
      id: randomUUID(),
      revision: 1 as const,
      userInput: input.userInput,
      ...(input.turnResolution === undefined ? {} : { turnResolution: input.turnResolution }),
      understanding: input.understanding,
      requiredToolSourceIds: Object.freeze([...new Set((input.requiredToolSourceIds ?? []).map((id) => id.trim()).filter(Boolean))]),
      lockedAt: now,
    }),
    steps: Object.freeze({}),
    targets: Object.freeze(targets),
    gaps: Object.freeze(gaps),
    createdAt: now,
    updatedAt: now,
  });
}

export function canonicalRunStateRef(state: CanonicalRunState): CanonicalRunStateRef {
  return {
    stateId: state.stateId,
    runId: state.runId,
    intentId: state.intent.id,
    revision: state.revision,
  };
}

export function bindCanonicalPlan(
  state: CanonicalRunState,
  plan: Pick<ExecutionPlan, "id" | "runId" | "version" | "steps">,
  now = Date.now(),
): CanonicalRunState {
  assertMutable(state);
  if (plan.runId !== state.runId) throw conflict("Canonical state cannot bind a Plan from another Run");
  const steps = Object.fromEntries(plan.steps.map((step) => [step.id, {
    stepId: step.id,
    targetIds: Object.freeze([...step.executionBinding.targetIds]),
    status: "pending" as const,
    evidenceRefs: Object.freeze([] as string[]),
    updatedAt: now,
  }]));
  return next(state, {
    phase: "planned",
    plan: Object.freeze({ id: plan.id, version: plan.version }),
    steps: Object.freeze(steps),
    targets: bindTargetOwners(state.targets, plan.steps),
  }, now);
}

export function reviseCanonicalPlan(
  state: CanonicalRunState,
  plan: Pick<ExecutionPlan, "id" | "runId" | "version" | "steps">,
  now = Date.now(),
): CanonicalRunState {
  assertMutable(state);
  if (plan.runId !== state.runId || state.plan?.id !== plan.id) {
    throw conflict("Canonical state cannot bind a revision from another Plan");
  }
  const steps = { ...state.steps };
  for (const step of plan.steps) {
    const current = steps[step.id];
    if (step.retiredAt !== undefined) {
      if (current !== undefined) {
        steps[step.id] = Object.freeze({ ...current, status: "retired" as const, updatedAt: now });
      }
      continue;
    }
    if (current !== undefined) continue;
    steps[step.id] = Object.freeze({
      stepId: step.id,
      targetIds: Object.freeze([...step.executionBinding.targetIds]),
      status: "pending" as const,
      evidenceRefs: Object.freeze([] as string[]),
      updatedAt: now,
    });
  }
  return next(state, {
    phase: "planned",
    plan: Object.freeze({ id: plan.id, version: plan.version }),
    steps: Object.freeze(steps),
    targets: bindTargetOwners(state.targets, plan.steps.filter((step) => step.retiredAt === undefined)),
    gaps: Object.freeze(state.gaps.map((gap) =>
      gap.targetId === undefined && gap.stepId !== undefined && steps[gap.stepId]?.status === "retired" && gap.status === "open"
        ? { ...gap, status: "resolved" as const, resolvedAt: now }
        : gap
    )),
  }, now);
}

export function startCanonicalStep(state: CanonicalRunState, stepId: string, now = Date.now()): CanonicalRunState {
  assertMutable(state);
  const step = requiredStep(state, stepId);
  if (step.status !== "pending" && step.status !== "running") {
    throw conflict(`Canonical Step ${stepId} cannot start from ${step.status}`);
  }
  return next(state, {
    phase: "executing",
    steps: replaceStep(state, { ...step, status: "running", updatedAt: now }),
  }, now);
}

export function recordCanonicalAssessment(
  state: CanonicalRunState,
  assessment: Pick<SkillComplianceAssessment, "id" | "stepId" | "approved" | "criteria" | "failedBoundary">,
  evidence: StepEvidence,
  now = Date.now(),
): CanonicalRunState {
  assertMutable(state);
  const step = requiredStep(state, assessment.stepId);
  const evidenceRefs = canonicalEvidenceRefs(evidence);
  const otherGaps = state.gaps.map((gap) =>
    gap.targetId === undefined && gap.stepId === assessment.stepId && gap.status === "open"
      ? { ...gap, status: "resolved" as const, resolvedAt: now }
      : gap);
  const acceptedTargetIds = new Set(assessment.criteria
    .filter((criterion) => criterion.satisfied && criterion.targetId !== undefined)
    .map((criterion) => criterion.targetId!)
    .filter((targetId) => step.targetIds.includes(targetId))
    .filter((targetId) => evidence.deliveryCandidate?.deliveryClaims.some((claim) => claim.targetId === targetId) === true));
  const targets = Object.fromEntries(Object.entries(state.targets).map(([targetId, target]) => {
    if (!acceptedTargetIds.has(targetId)) return [targetId, target];
    return [targetId, Object.freeze({
      ...target,
      status: "accepted" as const,
      claims: Object.freeze([...target.claims, {
        stepId: assessment.stepId,
        assessmentId: assessment.id,
        evidenceRefs,
        acceptedAt: now,
      }]),
    })];
  }));
  const progressedGaps = otherGaps.map((gap) =>
    gap.status === "open" && gap.targetId !== undefined && acceptedTargetIds.has(gap.targetId)
      ? { ...gap, status: "resolved" as const, resolvedAt: now }
      : gap);
  if (assessment.approved) {
    const resolved = progressedGaps.map((gap) =>
      gap.status === "open" && gap.targetId === undefined && gap.stepId === assessment.stepId
        ? { ...gap, status: "resolved" as const, resolvedAt: now }
        : gap);
    return next(state, {
      steps: replaceStep(state, {
        ...step,
        status: "satisfied",
        evidenceRefs,
        assessmentId: assessment.id,
        updatedAt: now,
      }),
      targets: Object.freeze(targets),
      gaps: Object.freeze(resolved),
    }, now);
  }
  const boundary = assessment.failedBoundary;
  const status = boundary?.suggestedRepairShape === "ask_user" || boundary?.suggestedRepairShape === "fail"
    ? "blocked" as const
    : "repairable" as const;
  const gap = boundary === undefined ? undefined : Object.freeze({
    id: randomUUID(),
    stepId: assessment.stepId,
    status: "open" as const,
    missingEvidenceKinds: Object.freeze([...boundary.missingEvidenceKinds]),
    violatedSkillRequirements: Object.freeze([...boundary.violatedSkillRequirements]),
    evidenceRefs: Object.freeze([...new Set([...boundary.reusableEvidenceRefs, ...evidenceRefs])]),
    suggestedAction: boundary.suggestedRepairShape,
    openedAt: now,
  });
  return next(state, {
    phase: status === "blocked" ? "blocked" : "executing",
    steps: replaceStep(state, {
      ...step,
      status,
      evidenceRefs,
      assessmentId: assessment.id,
      updatedAt: now,
    }),
    targets: Object.freeze(targets),
    gaps: Object.freeze(gap === undefined ? progressedGaps : [...progressedGaps, gap]),
  }, now);
}

export function recordCanonicalStepResult(
  state: CanonicalRunState,
  stepId: string,
  evidence: StepEvidence,
  now = Date.now(),
): CanonicalRunState {
  assertMutable(state);
  const step = requiredStep(state, stepId);
  if (step.status !== "satisfied") {
    throw conflict(`Canonical Step ${stepId} cannot publish a Result before an approved Assessment`);
  }
  return next(state, {
    steps: replaceStep(state, {
      ...step,
      status: "satisfied",
      evidenceRefs: Object.freeze([...new Set([...step.evidenceRefs, ...canonicalEvidenceRefs(evidence)])]),
      updatedAt: now,
    }),
  }, now);
}

export function markCanonicalReadyForTerminal(state: CanonicalRunState, now = Date.now()): CanonicalRunState {
  assertMutable(state);
  const steps = Object.values(state.steps).filter((step) => step.status !== "retired");
  if (steps.length === 0 || steps.some((step) => step.status !== "satisfied")) {
    throw conflict("Canonical state cannot become terminal-ready before every Step is satisfied");
  }
  if (state.gaps.some((gap) => gap.status === "open")) {
    throw conflict("Canonical state cannot become terminal-ready with open GoalGaps");
  }
  if (Object.values(state.targets).some((target) => target.terminalRequired && target.status !== "accepted")) {
    throw conflict("Canonical state cannot become terminal-ready before every delivery target is accepted");
  }
  return next(state, { phase: "ready_for_terminal" }, now);
}

function bindTargetOwners(
  targets: CanonicalRunState["targets"],
  steps: readonly Pick<ExecutionPlan["steps"][number], "id" | "executionBinding">[],
): CanonicalRunState["targets"] {
  const owners = new Map<string, string[]>();
  for (const step of steps) {
    for (const targetId of step.executionBinding.targetIds) {
      if (targets[targetId] === undefined) throw conflict(`Plan binds unknown canonical delivery target ${targetId}`);
      owners.set(targetId, [...(owners.get(targetId) ?? []), step.id]);
    }
  }
  return Object.freeze(Object.fromEntries(Object.entries(targets).map(([targetId, target]) => [targetId, Object.freeze({
    ...target,
    ownerStepIds: Object.freeze(owners.get(targetId) ?? []),
  })])));
}

export function commitCanonicalTerminal(
  state: CanonicalRunState,
  terminal: { readonly status: "completed" | "failed" | "cancelled"; readonly reasonCode: string },
  now = Date.now(),
): CanonicalRunState {
  assertMutable(state);
  if (terminal.status === "completed" && state.phase !== "ready_for_terminal") {
    throw conflict("Canonical completion requires ready_for_terminal state");
  }
  return next(state, {
    phase: terminal.status,
    terminal: Object.freeze({ ...terminal, committedAt: now }),
  }, now);
}

function canonicalEvidenceRefs(evidence: StepEvidence): readonly string[] {
  return Object.freeze([...new Set([
    ...evidence.toolCalls.map((toolCall) => toolCall.resultRef?.resultId ?? toolCall.toolCallId),
    ...(evidence.publishedResult === undefined ? [] : [evidence.publishedResult.ref.resultId]),
    ...(evidence.deliveryCandidate?.sourceToolCallIds ?? []),
  ])]);
}

function next(
  state: CanonicalRunState,
  patch: Partial<Omit<CanonicalRunState, "schema" | "stateId" | "runId" | "revision" | "intent" | "createdAt" | "updatedAt">>,
  now: number,
): CanonicalRunState {
  return Object.freeze({ ...state, ...patch, revision: state.revision + 1, updatedAt: now });
}

function replaceStep(state: CanonicalRunState, step: CanonicalStepProgress): Readonly<Record<string, CanonicalStepProgress>> {
  return Object.freeze({ ...state.steps, [step.stepId]: Object.freeze(step) });
}

function requiredStep(state: CanonicalRunState, stepId: string): CanonicalStepProgress {
  const step = state.steps[stepId];
  if (step === undefined) throw conflict(`Canonical state has no Step ${stepId}`);
  return step;
}

function assertMutable(state: CanonicalRunState): void {
  if (state.terminal !== undefined) throw conflict("Canonical terminal state is immutable");
}

function conflict(message: string): AppError {
  return new AppError("CONFLICT", message, 409);
}
