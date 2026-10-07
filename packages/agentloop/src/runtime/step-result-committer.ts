import { AppError } from "../shared/errors.ts";
import type { ExecutionPlan, PlanStep, SkillComplianceAssessment, StepEvidence } from "../planning/contracts.ts";
import type { PlanRepository } from "../planning/plan-repository.ts";
import { createRuntimeResult, type RuntimeResultRecord, type RuntimeResultRef } from "./runtime-result.ts";

/** The only boundary allowed to publish a formal Step result. */
export class StepResultCommitter {
  private readonly plans: PlanRepository;

  constructor(plans: PlanRepository) {
    this.plans = plans;
  }

  async commit(input: {
    readonly runId: string;
    readonly plan: ExecutionPlan;
    readonly step: PlanStep;
    readonly evidence: StepEvidence;
  }): Promise<{ readonly plan: ExecutionPlan; readonly result: RuntimeResultRecord }> {
    const persistedPlan = await this.plans.get(input.plan.id);
    const step = persistedPlan.steps.find((candidate) => candidate.id === input.step.id);
    if (
      input.plan.runId !== input.runId
      || persistedPlan.runId !== input.runId
      || step === undefined
      || step.status !== "running"
      || step.retiredAt !== undefined
    ) {
      throw new AppError("CONFLICT", `Step result producer does not match a running Plan step: ${input.step.id}`, 409);
    }
    const assessments = await this.plans.assessments(persistedPlan.id);
    const assessment = assessments.filter((item) => item.stepId === step.id).at(-1);
    const caveated = isCaveatedStepResult(assessment, input.evidence);
    if (assessment === undefined || (!assessment.approved && !caveated)) {
      throw new AppError(
        "ASSESSMENT_ERROR",
        `Step result publication requires an approved or explicitly caveated assessment for step ${step.id}`,
        409,
      );
    }
    assertDependencyResultsWereRead(persistedPlan, step, input.evidence.toolCalls);
    const result = createRuntimeResult({
      kind: "step",
      producer: {
        runId: input.runId,
        planId: persistedPlan.id,
        stepId: step.id,
      },
      value: input.evidence.candidateOutput,
      inputs: uniqueResultRefs([
        ...dependencyResultRefs(persistedPlan, step),
        ...input.evidence.toolCalls.flatMap((toolCall) => toolCall.resultRef === undefined ? [] : [toolCall.resultRef]),
      ]),
      publication: {
        status: "published",
        assessmentRef: assessment.id,
        decision: caveated ? "caveated" : "approved",
      },
    });
    const plan = await this.plans.completeStep(
      persistedPlan.id,
      step.id,
      result.payload.content,
      { ...input.evidence, publishedResult: result },
    );
    if (plan.steps.find((candidate) => candidate.id === step.id)?.evidence?.publishedResult?.ref.resultId !== result.ref.resultId) {
      throw new AppError("CONFLICT", `Step result publication lost the running-step commit race: ${step.id}`, 409);
    }
    return { plan, result };
  }
}

/** A rejected assessment can publish only when every unresolved signal is explicitly non-blocking. */
export function isCaveatedStepResult(
  assessment: SkillComplianceAssessment | undefined,
  evidence: Pick<StepEvidence, "completionCaveat">,
): boolean {
  if (assessment === undefined) return false;
  const runtimeBoundary = evidence.completionCaveat?.reason === "repair_limit"
    || evidence.completionCaveat?.reason === "evidence_boundary";
  if (runtimeBoundary) return true;
  const skippedValidation = assessment.skills.some((skill) => skill.status === "skipped_unavailable");
  if (evidence.completionCaveat?.reason === "deferred_validation") return skippedValidation;
  const processCaveat = assessment.skills.some((skill) => skill.status === "process_caveat");
  if (evidence.completionCaveat?.reason === "process_caveat") return processCaveat;
  // A Runtime-bound user decision is already authoritative. An explicit
  // downstream mismatch is delivered as an honest warning and must not be
  // invalidated by unrelated Skill observation status.
  const decisionCaveat = assessment.decisionBindings?.some((binding) =>
    binding.status === "conflict" && !binding.blocking
  ) === true;
  if (decisionCaveat) return true;
  const blockingCriterion = assessment.criteria.some((criterion) =>
    criterion.status !== "satisfied"
    && criterion.satisfied !== true
    && criterion.blocking !== false
  );
  const blockingDecision = assessment.decisionBindings?.some((binding) =>
    binding.status !== "satisfied" && binding.blocking
  ) === true;
  const blockingSkill = assessment.skills.some((skill) =>
    skill.followed !== true
    && skill.status !== "skipped_unavailable"
    && skill.status !== "process_caveat"
  );
  if (blockingCriterion || blockingDecision || blockingSkill) return false;
  return skippedValidation
    || processCaveat
    || assessment.criteria.some((criterion) =>
      criterion.status !== "satisfied"
      && criterion.satisfied !== true
      && criterion.blocking === false
    );
}

function dependencyResultRefs(plan: ExecutionPlan, step: PlanStep): RuntimeResultRef[] {
  return step.dependencies.flatMap((dependencyId) => {
    const result = plan.steps.find((candidate) => candidate.id === dependencyId)?.evidence?.publishedResult;
    return result === undefined ? [] : [result.ref];
  });
}

/** Final publication fence: a dependency Result can contribute only after the current Step read that same opaque identity. */
function assertDependencyResultsWereRead(
  plan: ExecutionPlan,
  step: PlanStep,
  toolCalls: StepEvidence["toolCalls"],
): void {
  const required = dependencyResultRefs(plan, step);
  if (required.length === 0) return;
  const consumed = new Set(toolCalls.flatMap((toolCall) => {
    if (toolCall.isError || toolCall.toolName !== "read_result") return [];
    const value = parseRecord(toolCall.result);
    const sourceResultRef = parseRecord(value?.sourceResultRef);
    const resultId = typeof sourceResultRef?.resultId === "string" ? sourceResultRef.resultId : undefined;
    return resultId === undefined ? [] : [resultId];
  }));
  const unread = required.filter((ref) => !consumed.has(ref.resultId));
  if (unread.length === 0) return;
  throw new AppError(
    "ASSESSMENT_ERROR",
    `Step result publication requires read_result consumption of dependency Results: ${unread.map((ref) => ref.resultId).join(", ")}`,
    409,
  );
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return parseRecord(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function uniqueResultRefs(refs: readonly RuntimeResultRef[]): RuntimeResultRef[] {
  const unique = new Map(refs.map((ref) => [ref.resultId, ref]));
  return [...unique.values()];
}
