import { randomUUID } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import type { ConversationTurnResolution, ExecutionPlan, FailedBoundary, SkillComplianceAssessment, StepEvidence } from "../planning/contracts.ts";
import type { StructuredTaskUnderstanding } from "./task-intent.ts";
import type { WorkProductSemantics } from "./work-product-semantics.ts";
import type { RuntimeDeliveryClaim } from "./contracts.ts";

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
  /** Ordered owners of this same unresolved gap; Plan revisions do not reset it. */
  readonly repairStepIds?: readonly string[];
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
  /** Current user-delivery identity, derived from an admitted target binding. */
  readonly artifactBinding?: {
    readonly stepId: string;
    readonly declarationId: string;
    readonly path: string;
    readonly versionId: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly observedByToolCallId: string;
    readonly boundAt: number;
  };
  readonly claims: readonly {
    readonly stepId: string;
    readonly assessmentId: string;
    readonly evidenceRefs: readonly string[];
    readonly artifact?: RuntimeDeliveryClaim["artifact"];
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
  const deliverables = input.understanding.deliverables ?? [];
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
  const state: CanonicalRunState = Object.freeze({
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
  assertCanonicalDeliveryTargetInventory(state);
  return state;
}

/**
 * The frozen intent and target inventory are two views of one delivery
 * contract. Reject persisted or manually constructed states that let Planning
 * see a target which canonical progress cannot own.
 */
export function assertCanonicalDeliveryTargetInventory(state: CanonicalRunState): void {
  const deliverables = state.intent.understanding.deliverables ?? [];
  const resolvedDeliverables = state.intent.turnResolution?.taskIntent.deliverables;
  const targets = Object.values(state.targets);
  const duplicateIntentIds = deliverables
    .map((target) => target.targetId)
    .filter((targetId, index, ids) => ids.indexOf(targetId) !== index);
  const intentById = new Map(deliverables.map((target) => [target.targetId, target]));
  const mismatched = targets.filter((target) => {
    const intentTarget = intentById.get(target.targetId);
    return intentTarget === undefined
      || target.purpose !== intentTarget.purpose
      || target.surface !== intentTarget.surface
      || target.kind !== intentTarget.kind
      || target.format !== intentTarget.format
      || target.expectedCount !== intentTarget.expectedArtifactCount;
  }).map((target) => target.targetId);
  const missing = deliverables.filter((target) => state.targets[target.targetId] === undefined).map((target) => target.targetId);
  const unexpected = targets.filter((target) => !intentById.has(target.targetId)).map((target) => target.targetId);
  const resolutionMismatch = resolvedDeliverables === undefined
    ? []
    : deliveryInventoryMismatchIds(deliverables, resolvedDeliverables);
  if (
    duplicateIntentIds.length === 0
    && missing.length === 0
    && unexpected.length === 0
    && mismatched.length === 0
    && resolutionMismatch.length === 0
  ) return;
  const details = [
    ...(duplicateIntentIds.length === 0 ? [] : [`duplicate intent IDs ${[...new Set(duplicateIntentIds)].join(", ")}`]),
    ...(missing.length === 0 ? [] : [`missing targets ${missing.join(", ")}`]),
    ...(unexpected.length === 0 ? [] : [`unexpected targets ${unexpected.join(", ")}`]),
    ...(mismatched.length === 0 ? [] : [`mismatched targets ${mismatched.join(", ")}`]),
    ...(resolutionMismatch.length === 0 ? [] : [`resolver/understanding mismatch ${resolutionMismatch.join(", ")}`]),
  ];
  throw conflict(`Canonical delivery target inventory contradicts frozen intent: ${details.join("; ")}`);
}

function deliveryInventoryMismatchIds(
  left: NonNullable<StructuredTaskUnderstanding["deliverables"]>,
  right: NonNullable<StructuredTaskUnderstanding["deliverables"]>,
): string[] {
  const rightById = new Map(right.map((target) => [target.targetId, target]));
  return [...new Set([
    ...left.filter((target) => {
      const peer = rightById.get(target.targetId);
      return peer === undefined
        || peer.purpose !== target.purpose
        || peer.expectedArtifactCount !== target.expectedArtifactCount
        || peer.action !== target.action
        || peer.kind !== target.kind
        || peer.format !== target.format
        || peer.surface !== target.surface;
    }).map((target) => target.targetId),
    ...right.filter((target) => !left.some((candidate) => candidate.targetId === target.targetId)).map((target) => target.targetId),
  ])];
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
  assertCanonicalDeliveryTargetInventory(state);
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
  repairs: readonly { readonly gapId: string; readonly replacementStepId: string }[] = [],
): CanonicalRunState {
  assertMutable(state);
  if (plan.runId !== state.runId || state.plan?.id !== plan.id) {
    throw conflict("Canonical state cannot bind a revision from another Plan");
  }
  if (new Set(repairs.map((repair) => repair.gapId)).size !== repairs.length
    || repairs.some((repair) => !state.gaps.some((gap) => gap.id === repair.gapId))) {
    throw conflict("GoalGap repair mappings must identify distinct existing gaps");
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
    gaps: Object.freeze(state.gaps.map((gap) => {
      const repair = repairs.find((item) => item.gapId === gap.id);
      if (repair === undefined) return gap;
      if (gap.status !== "open" || gap.stepId === undefined || steps[gap.stepId]?.status !== "retired"
        || steps[repair.replacementStepId]?.status !== "pending") {
        throw conflict("GoalGap repair must transfer an open retired-step gap to an admitted pending Step");
      }
      return Object.freeze({ ...gap, stepId: repair.replacementStepId,
        repairStepIds: Object.freeze([...(gap.repairStepIds ?? [gap.stepId]), repair.replacementStepId]) });
    })),
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
  const currentGap = state.gaps.find((gap) => gap.targetId === undefined && gap.stepId === assessment.stepId && gap.status === "open");
  const acceptedTargetIds = new Set(assessment.criteria
    .filter((criterion) => criterion.satisfied && criterion.targetId !== undefined)
    .map((criterion) => criterion.targetId!)
    .filter((targetId) => step.targetIds.includes(targetId))
    .filter((targetId) => deliveryClaimMatchesCurrentTargetBinding(
      state.targets[targetId],
      evidence.deliveryCandidate?.deliveryClaims.find((claim) => claim.targetId === targetId),
    )));
  const targets = Object.fromEntries(Object.entries(state.targets).map(([targetId, target]) => {
    if (!acceptedTargetIds.has(targetId)) return [targetId, target];
    const claim = evidence.deliveryCandidate?.deliveryClaims.find((candidate) => candidate.targetId === targetId);
    return [targetId, Object.freeze({
      ...target,
      status: "accepted" as const,
      claims: Object.freeze([...target.claims, {
        stepId: assessment.stepId,
        assessmentId: assessment.id,
        evidenceRefs,
        ...(claim?.artifact === undefined ? {} : { artifact: claim.artifact }),
        acceptedAt: now,
      }]),
    })];
  }));
  const progressedGaps = state.gaps.map((gap) =>
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
    id: currentGap?.id ?? randomUUID(),
    stepId: assessment.stepId,
    status: "open" as const,
    missingEvidenceKinds: Object.freeze([...boundary.missingEvidenceKinds]),
    violatedSkillRequirements: Object.freeze([...boundary.violatedSkillRequirements]),
    evidenceRefs: Object.freeze([...new Set([...(currentGap?.evidenceRefs ?? []), ...boundary.reusableEvidenceRefs, ...evidenceRefs])]),
    suggestedAction: boundary.suggestedRepairShape,
    openedAt: currentGap?.openedAt ?? now,
    repairStepIds: currentGap?.repairStepIds ?? Object.freeze([assessment.stepId]),
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
    gaps: Object.freeze(gap === undefined ? progressedGaps
      : currentGap === undefined ? [...progressedGaps, gap]
      : progressedGaps.map((existing) => existing.id === gap.id ? gap : existing)),
  }, now);
}

/**
 * Reconcile current target/version bindings from committed ActionResult facts.
 * This does not assign ownership or alter the Plan: a single leaf may bind
 * many targets. Rewriting a bound path clears acceptance for that target until
 * the new current version is explicitly re-bound and accepted.
 */
export function reconcileCanonicalDeliveryTargetBindings(
  state: CanonicalRunState,
  input: {
    readonly stepId: string;
    readonly bindings: NonNullable<WorkProductSemantics["deliveryTargets"]>;
    readonly now?: number;
  },
): CanonicalRunState {
  assertMutable(state);
  const now = input.now ?? Date.now();
  const byTarget = new Map<string, NonNullable<WorkProductSemantics["deliveryTargets"]>>();
  for (const binding of input.bindings) {
    const key = binding.deliveryTargetId;
    byTarget.set(key, [...(byTarget.get(key) ?? []), binding]);
  }
  let changed = false;
  const targets = Object.fromEntries(Object.entries(state.targets).map(([targetId, target]) => {
    if (!target.ownerStepIds.includes(input.stepId)) return [targetId, target];
    const bindings = byTarget.get(targetId) ?? [];
    if (bindings.length === 0) {
      if (target.artifactBinding?.stepId !== input.stepId) return [targetId, target];
      changed = true;
      return [targetId, Object.freeze({ ...target, status: "open" as const, artifactBinding: undefined })];
    }
    // The single field is the current decision projection for a target. The
    // full target cardinality remains in the candidate's exact artifact list;
    // this prevents plural outputs from being turned into additional leaves.
    const binding = bindings[0]!;
    const nextBinding = {
      stepId: input.stepId,
      declarationId: binding.declarationId,
      path: binding.path,
      versionId: binding.versionId,
      sha256: binding.sha256,
      bytes: binding.bytes,
      observedByToolCallId: binding.observedByToolCallId,
      boundAt: now,
    };
    const current = target.artifactBinding;
    if (current !== undefined
      && current.stepId === nextBinding.stepId
      && current.declarationId === nextBinding.declarationId
      && current.path === nextBinding.path
      && current.versionId === nextBinding.versionId
      && current.sha256 === nextBinding.sha256
      && current.bytes === nextBinding.bytes
      && current.observedByToolCallId === nextBinding.observedByToolCallId) return [targetId, target];
    changed = true;
    return [targetId, Object.freeze({ ...target, status: "open" as const, artifactBinding: Object.freeze(nextBinding) })];
  }));
  if (!changed) return state;
  return next(state, { targets: Object.freeze(targets) }, now);
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

function deliveryClaimMatchesCurrentTargetBinding(
  target: CanonicalDeliveryTarget | undefined,
  claim: RuntimeDeliveryClaim | undefined,
): boolean {
  if (target === undefined || claim === undefined) return false;
  if (target.artifactBinding === undefined) return true;
  const artifacts = claim.artifacts ?? (claim.artifact === undefined ? [] : [claim.artifact]);
  if (artifacts.length < target.expectedCount) return false;
  return artifacts.some((artifact) => artifact.path === target.artifactBinding!.path
    && artifact.versionId === target.artifactBinding!.versionId
    && artifact.sha256 === target.artifactBinding!.sha256
    && artifact.bytes === target.artifactBinding!.bytes
    && artifact.observedByToolCallId === target.artifactBinding!.observedByToolCallId);
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
