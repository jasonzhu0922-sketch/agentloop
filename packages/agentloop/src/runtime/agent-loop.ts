import { createHash } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import { createConcurrencyLimiter, mapWithConcurrencyLimit } from "../shared/concurrency.ts";
import { buildSkillReferenceMap } from "../skills/skill-identity.ts";
import { ContextAssembler, type ContextPolicy } from "./context-assembler.ts";
import { appendDeliveryCandidateCaveats, buildRuntimeDeliveryCandidate, normalizeDeliveryCandidate } from "./delivery-candidate.ts";
import type {
  AgentLoopResult,
  AgentLoopToolEvidence,
  CandidateCompletionContext,
  CandidateCompletionEvaluation,
  CapabilityGrant,
  ModelAdapter,
  ModelInvocation,
  ModelMessage,
  ModelResponse,
  ModelToolCall,
  RuntimeContextSnapshot,
  RuntimeEvent,
  RuntimeEventSink,
  RuntimeDeliveryCandidate,
} from "./contracts.ts";
import type { RuntimeResultRef } from "./runtime-result.ts";
import type { StepSemanticFrame } from "./step-semantic-frame.ts";
import type { PreparedToolCall } from "../tools/tool-registry.ts";
import { ToolRegistry } from "../tools/tool-registry.ts";
import { HUMAN_LOOP_TOOL_NAME } from "../tools/human-loop-tool.ts";
import { completeWithStreaming } from "./model-streaming.ts";
import { isTextToolInvocation } from "./text-tool-invocation.ts";
import {
  classifyToolOperationOutcome,
  type ToolInvocationStatus,
  type ToolOperationStatus,
} from "./tool-operation-outcome.ts";
import {
  DefaultStepExecutionStrategy,
  type StepExecutionDecision,
  type StepExecutionStrategy,
} from "./step-execution-strategy.ts";
import {
  deriveRuntimeStepEvidenceState,
  deriveEvidenceCompletionCandidate,
  evaluateRuntimeToolProgress,
  initialRuntimeToolProgressState,
  candidateRejectionProgressHint,
  type RuntimeToolProgressPolicy,
} from "./tool-progress-policy.ts";
import {
  createHumanLoopControlSignal,
  firstHumanLoopControlSignal,
} from "./runtime-control-signal.ts";
import { WorkProductContext, type WorkProductContextOptions } from "./work-product-context.ts";
import { CompletionFailure } from "./completion-failure.ts";

export interface AgentLoopOptions {
  readonly runId: string;
  readonly systemPrompt: string;
  readonly runtimeContext?: Omit<RuntimeContextSnapshot, "id" | "supersedesId">;
  readonly input: string;
  /** Prior user/assistant turns from the same conversation, newest last. */
  readonly conversationHistory?: readonly ModelMessage[];
  /** Complete, persisted exchanges from a prior interrupted execution. */
  readonly initialMessages?: readonly ModelMessage[];
  readonly initialToolEvidence?: readonly AgentLoopToolEvidence[];
  readonly model: ModelAdapter;
  readonly tools: ToolRegistry;
  readonly grant: CapabilityGrant;
  readonly availableSkills?: readonly {
    readonly id: string;
    readonly name: string;
    readonly contentHash: string;
  }[];
  readonly maxSteps: number;
  /** Additional tool-enabled steps allowed after `maxSteps` when the model is still working. */
  readonly convergenceGraceSteps?: number;
  /** Additional tool-enabled steps available when a completion candidate needs another Runtime repair turn. */
  readonly candidateRepairGraceSteps?: number;
  /** Bounds rejected assessed candidates and malformed no-tool candidates before the Runtime terminates or caves the result. */
  readonly candidateRepairAssessmentLimit?: number;
  /** The Run owner may still revise a failed leaf; report only if it commits failure. */
  readonly deferFailureReport?: boolean;
  /**
   * Runtime-enforced per-Tool call ceilings for this Plan step.  These cap
   * external effects; they do not decide whether the model should summarize
   * earlier when the next acquisition would add no material value.
   */
  readonly toolCallLimits?: Readonly<Record<string, number>>;
  readonly maxToolResultCharacters?: number;
  readonly maxParallelToolCalls?: number;
  readonly contextPolicy?: ContextPolicy;
  readonly stepSemanticFrame?: Pick<StepSemanticFrame, "completionBoundary" | "evidenceMode" | "phaseRole">;
  readonly convergencePrompt?: string;
  readonly convergenceMaxOutputTokens?: number;
  readonly shouldConvergeAfterToolStep?: (
    context: ToolStepConvergenceContext,
  ) => boolean | ToolStepConvergenceDecision | Promise<boolean | ToolStepConvergenceDecision>;
  readonly shouldUseFinalConvergence?: (
    context: ToolStepConvergenceContext,
  ) => boolean | Promise<boolean>;
  readonly progressPolicy?: RuntimeToolProgressPolicy;
  readonly stepExecutionStrategy?: StepExecutionStrategy;
  /** Stage 3: current-leaf visibility only; no assessment/recovery policy change. */
  readonly workProductContext?: WorkProductContextOptions;
  readonly signal?: AbortSignal;
  readonly emit?: RuntimeEventSink;
  readonly actionTracker?: {
    executeToolCall<T>(input: {
      step: number;
      toolCallId: string;
      toolName: string;
      replaySafe: boolean;
      publishesRuntimeResult: boolean;
      timeoutMs?: number;
    }, operation: () => Promise<T>): Promise<Readonly<{ value: T; resultRef?: RuntimeResultRef }>>;
  };
  readonly evaluateCandidate?: (
    context: CandidateCompletionContext,
  ) => Promise<CandidateCompletionEvaluation>;
}

export interface ToolStepConvergenceContext {
  readonly step: number;
  readonly messages: readonly ModelMessage[];
  readonly toolEvidence: readonly AgentLoopToolEvidence[];
  readonly latestToolEvidence: readonly AgentLoopToolEvidence[];
  readonly activatedSkillNames: readonly string[];
}

export interface ToolStepConvergenceDecision {
  readonly converge: boolean;
  readonly reason?: string;
}

type PreparedEntry =
  | { readonly kind: "ready"; readonly value: PreparedToolCall }
  | { readonly kind: "rejected"; readonly call: ModelToolCall; readonly message: string };

interface ToolOutcome {
  readonly call: ModelToolCall;
  readonly content: string;
  readonly invocationStatus: ToolInvocationStatus;
  readonly operationStatus: ToolOperationStatus;
  readonly exitCode?: number | null;
  readonly isError: boolean;
  readonly failurePhase?: "prepare" | "execute" | "operation" | "runtime";
  readonly resultRef?: RuntimeResultRef;
}

interface StructuredToolCandidate {
  readonly deliveryCandidate: RuntimeDeliveryCandidate;
  readonly projection: string;
  /** Bounded, machine-readable observation for a later synthesis turn. */
  readonly observation: string;
  readonly sourceToolCallId: string;
  readonly sourceToolCallIds: readonly string[];
  readonly schema?: string;
  readonly aggregation?: StructuredCandidateAggregation;
}

interface StructuredCandidateAggregation {
  readonly groupId: string;
  readonly partIndex: number;
  readonly partCount: number;
  readonly mergeStrategy: "append_markdown";
}

interface StructuredToolCandidateSelection {
  readonly directCandidate?: StructuredToolCandidate;
  readonly observations: readonly StructuredToolCandidate[];
}

// Execution turns need the model's declared room because reasoning-heavy
// providers count hidden reasoning against the same output budget used for the
// visible answer or tool-call arguments.
const CONVERGENCE_MAX_OUTPUT_TOKENS = 4_096;
const EMPTY_CANDIDATE_REPAIR_ATTEMPTS = 2;
// Extra tool-enabled steps granted after the primary budget when the model is
// still actively executing. Defaults to 0 so the primary `maxSteps` budget is
// the tight cost cap; callers may raise it (e.g. for file-producing Skills)
// so a "write → run → verify" workflow is not cut off one render short.
const DEFAULT_CONVERGENCE_GRACE_STEPS = 0;

const CONVERGENCE_PROMPT = [
  "<runtime_convergence>",
  "This is the final model step allowed by the current step budget.",
  "No execution tools are available on this turn.",
  "Use the canonical tool results already present in the conversation to submit one concise completion candidate.",
  "Return 1-3 short sentences. Name what was completed, cite the concrete evidence or tool results used, and state any unmet criterion truthfully.",
  "Never return an empty response.",
  "This response is only a candidate: the independent assessor and Terminal Committer remain authoritative.",
  "Do not request or emit tool calls.",
  "</runtime_convergence>",
].join("\n");

const EMPTY_CANDIDATE_REPAIR_PROMPT = [
  "<runtime_candidate_repair>",
  "The previous completion candidate was empty, so it cannot be assessed.",
  "Return a non-empty completion candidate in 1-3 short sentences.",
  "Name the completed work, cite the concrete evidence or tool results used, and state any unmet criterion truthfully.",
  "Do not request or emit tool calls.",
  "</runtime_candidate_repair>",
].join("\n");

const TEXT_TOOL_INVOCATION_REPAIR_PROMPT = [
  "<runtime_candidate_repair>",
  "The previous completion candidate was an unexecuted text tool invocation, so it cannot be assessed.",
  "Execution tools are not available on this convergence turn.",
  "Return a real completion candidate in 1-3 short sentences using only the canonical evidence already present.",
  "Do not request, describe, or emit tool calls or provider tool-call protocol markup.",
  "</runtime_candidate_repair>",
].join("\n");

const INTERNAL_EVIDENCE_MARKUP_REPAIR_PROMPT = [
  "<runtime_candidate_repair>",
  "The previous completion candidate exposed internal Runtime evidence markup instead of a user-visible answer.",
  "Return a complete standalone answer for the user using only canonical evidence already present.",
  "Do not include Runtime tags, server-provided evidence envelopes, JSON evidence records, tool-call records, or provider protocol markup.",
  "Do not request or emit tool calls.",
  "</runtime_candidate_repair>",
].join("\n");

const DEFAULT_CANDIDATE_REPAIR_ASSESSMENT_LIMIT = 2;

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const workProducts = options.workProductContext === undefined ? undefined : new WorkProductContext(options.runId, options.workProductContext);
  const emit = async (event: RuntimeEvent): Promise<void> => {
    const observed = workProducts?.capture(event) ?? event;
    await options.emit?.(observed);
  };
  const maxToolResultCharacters = options.maxToolResultCharacters ?? 50_000;
  const maxParallelToolCalls = options.maxParallelToolCalls ?? 4;
  const graceSteps = Math.max(0, options.convergenceGraceSteps ?? DEFAULT_CONVERGENCE_GRACE_STEPS);
  const candidateRepairGraceSteps = Math.max(0, options.candidateRepairGraceSteps ?? 0);
  const convergenceMaxOutputTokens = Math.max(1, options.convergenceMaxOutputTokens ?? CONVERGENCE_MAX_OUTPUT_TOKENS);
  const convergencePrompt = options.convergencePrompt ?? CONVERGENCE_PROMPT;
  const stepExecutionStrategy = options.stepExecutionStrategy ?? new DefaultStepExecutionStrategy();
  const candidateRepairAssessmentLimit = Math.max(
    0,
    options.candidateRepairAssessmentLimit ?? DEFAULT_CANDIDATE_REPAIR_ASSESSMENT_LIMIT,
  );
  const toolCallLimits = normalizeToolCallLimits(options.toolCallLimits);
  let grantedCandidateRepairGraceSteps = 0;
  let grantedFinalConvergenceGraceSteps = 0;
  let rejectedCandidateAssessments = 0;
  let rejectedUnassessableCandidates = 0;
  let evidenceProgressBaseline: number | undefined;
  let evidenceProgressBoundary: CandidateCompletionEvaluation["failedBoundary"];
  let pendingCandidateRepairDirective: string | undefined;
  let pendingStructuredObservationSynthesisDirective: string | undefined;
  const messages: ModelMessage[] = [
    ...(options.conversationHistory ?? []),
    ...(options.initialMessages === undefined
      ? [{ role: "user", content: options.input } satisfies ModelMessage]
      : options.initialMessages),
  ];
  const toolEvidence: AgentLoopToolEvidence[] = [...(options.initialToolEvidence ?? [])];
  const availableSkillList = options.availableSkills ?? [];
  const availableSkills = buildSkillReferenceMap(availableSkillList);
  const activatedSkillNames = new Set(
    collectActivatedSkillNames(options.initialMessages ?? [], availableSkills),
  );
  const contextAssembler = new ContextAssembler({
    runId: options.runId,
    systemPrompt: options.systemPrompt,
    runtimeContext: options.runtimeContext ?? {
      phase: "execution",
      content: "No additional server runtime state was supplied for this invocation.",
    },
    model: options.model,
    policy: options.contextPolicy,
    emit,
  });

  await emit({
    type: "loop.started",
    data: { runId: options.runId, depth: options.grant.depth },
  });
  if (availableSkillList.length > 0) {
    await emit({
      type: "skill.activation.available",
      data: {
        skills: availableSkillList.map((skill) => ({
          id: skill.id,
          name: skill.name,
          contentHash: skill.contentHash,
        })),
      },
    });
  }

  let convergenceRequested = false;
  let previousPrepareRejectionSignature: string | undefined;
  let consecutivePrepareRejectionSteps = 0;
  let invalidHumanLoopAttempts = 0;
  let humanLoopRepairPending = false;
  let toolProgressState = initialRuntimeToolProgressState();
  let stalled = false;
  let requestedConvergenceReason: string | undefined;
  const currentLimit = (): number =>
    currentHardLimit(options.maxSteps, graceSteps, grantedCandidateRepairGraceSteps, grantedFinalConvergenceGraceSteps);
  const grantCandidateRepairGrace = async (step: number, feedback: string): Promise<void> => {
    if (candidateRepairGraceSteps <= grantedCandidateRepairGraceSteps) return;
    grantedCandidateRepairGraceSteps = candidateRepairGraceSteps;
    await emit({
      type: "loop.candidate_repair_grace_granted",
      data: {
        step,
        candidateRepairGraceSteps,
        hardLimit: currentLimit(),
        feedback,
      },
    });
  };
  const setCandidateRepairDirective = (directive: string): void => {
    pendingCandidateRepairDirective = directive;
    contextAssembler.setRuntimeDirective(directive);
  };
  const evaluateCandidate = async (
    step: number,
    context: CandidateCompletionContext,
  ): Promise<CandidateCompletionEvaluation> => {
    if (evidenceProgressBaseline !== undefined && context.toolEvidence.length <= evidenceProgressBaseline) {
      return {
        approved: false,
        feedback: "The holistic assessment identified a substantive gap. No new tool evidence was produced, so another rewritten completion candidate cannot resolve it.",
        requiresEvidenceProgress: true,
        evidenceProgressBlocked: true,
        ...(evidenceProgressBoundary === undefined ? {} : { failedBoundary: evidenceProgressBoundary }),
      };
    }
    if (options.evaluateCandidate === undefined) return { approved: true, feedback: "" };
    const evaluation = await options.evaluateCandidate(context);
    if (evaluation.assessmentReused === true) {
      await emit({
        type: "candidate.assessment_reused",
        data: {
          step,
          approved: evaluation.approved,
          deferredValidation: evaluation.deferredValidation === true,
          feedback: evaluation.feedback,
        },
      });
    }
    if (!evaluation.approved && evaluation.requiresEvidenceProgress === true) {
      evidenceProgressBaseline = context.toolEvidence.length;
      evidenceProgressBoundary = evaluation.failedBoundary;
    } else if (evaluation.approved || context.toolEvidence.length > (evidenceProgressBaseline ?? -1)) {
      evidenceProgressBaseline = undefined;
      evidenceProgressBoundary = undefined;
    }
    return evaluation;
  };
  const failureReport = async (step: number, output: string, evaluation: CandidateCompletionEvaluation): Promise<string> => {
    throwIfAborted(options.signal);
    const missing = evaluation.failedBoundary?.missingEvidenceKinds ?? [];
    const notice = [
      "任务未完成，以下仅为阶段性结果，未通过完整验收。",
      ...(missing.length === 0 ? [] : [`尚未确认的验收项：${missing.join("、")}。缺少证据不等于相关操作一定未执行。`]),
    ].join("\n");
    await emit({ type: "failure_report.started", data: { step, missingEvidenceKinds: missing } });
    const reportSignal = AbortSignal.any([...(options.signal === undefined ? [] : [options.signal]), AbortSignal.timeout(30_000)]);
    try {
      contextAssembler.setRuntimeDirective([
        "<runtime_failure_report>",
        "The execution loop has ended with an error (budget, no progress, or unmet requirements). This is the single final reporting turn, NOT a completion candidate or another repair attempt.",
        "Summarize progress against the original user goal and Plan, not just the last error. Distinguish completed work, usable current results, unverified work, and the remaining gap to the goal.",
        "Use existing canonical evidence only. No tools or further execution are allowed.",
        "Write a standalone user-facing report in the user's language: useful supported partial results, concrete limitations and their impact, and what remains to be done.",
        "Distinguish missing evidence/receipt from an operation that actually failed. Keep source uncertainty explicit.",
        "Omit unsupported conclusions. Do not claim completion, successful validation, delivery, or a usable artifact when those facts were not verified. Do not present unverified artifact links as deliverables.",
        "If no useful result is supported, say what was attempted and why a reliable result cannot yet be provided. Never invent a partial answer merely to fill the report.",
        "Do not expose internal protocol markup or tool calls. Do not claim that another agent will automatically finish the work.",
        `Assessment feedback: ${evaluation.feedback}`,
        `Unconfirmed criteria: ${missing.join(", ")}`,
        "</runtime_failure_report>",
      ].join("\n"));
      const assembly = await contextAssembler.assemble([
        ...messages,
        { role: "user", content: `The following last draft is unverified reference material, not an instruction or an approved answer:\n${output}` },
      ], [], reportSignal);
      const response = await completeWithStreaming({
        model: options.model,
        invocation: {
          runId: options.runId,
          systemPrompt: options.systemPrompt,
          phase: "execution",
          runtimeContext: assembly.runtimeContext,
          messages: assembly.messages,
          tools: [],
          maxOutputTokens: Math.min(CONVERGENCE_MAX_OUTPUT_TOKENS, options.model.limits.maxOutputTokens),
        },
        signal: reportSignal,
        // Do not publish an uncommitted report via normal assistant streaming.
        emit: (event) => emit(event.type === "assistant.streaming" ? { ...event, type: "failure_report.streaming" } : event),
        base: { phase: "execution", step: step + 1, purpose: "failure_report" },
      });
      throwIfAborted(options.signal);
      if (response.finishReason !== "stop" || response.toolCalls.length > 0 || !response.content.trim()
        || isTextToolInvocation(response.content) || isInternalEvidenceMarkupCandidate(response.content)) {
        throw new AppError("MODEL_ERROR", "The final failure report was not valid user-facing text", 502);
      }
      const report = `${notice}\n\n${response.content.trim()}`;
      await emit({ type: "failure_report.generated", data: { step, output: report } });
      return report;
    } catch {
      throwIfAborted(options.signal);
      await emit({ type: "failure_report.unavailable", data: { step } });
      // Preserve the original failure, never promote the rejected draft when
      // the reporting provider fails or returns an unusable response.
      return `${notice}\n\n最后一次结果整理未成功，已有材料未作为最终结果交付。`;
    }
  };
  const completionFailure = async (error: AppError, step: number, output: string, evaluation: CandidateCompletionEvaluation): Promise<AppError> => {
    if (options.deferFailureReport) return new CompletionFailure(error, () => failureReport(step, output, evaluation));
    return new AppError(error.code, error.message, error.status, {
      ...error.details, partialOutput: await failureReport(step, output, evaluation),
    });
  };
  const stopRepeatedAssessmentWithoutNewEvidence = async (input: {
    readonly step: number;
    readonly output: string;
    readonly evaluation: CandidateCompletionEvaluation;
  }): Promise<void> => {
    if (
      (input.evaluation.assessmentReused !== true && input.evaluation.evidenceProgressBlocked !== true)
      || input.evaluation.approved
    ) return;
    await emit({
      type: "candidate.repair_limit_blocked",
      data: {
        step: input.step,
        output: input.output,
        feedback: input.evaluation.feedback,
        reason: input.evaluation.evidenceProgressBlocked === true
          ? "holistic_assessment_requires_new_evidence"
          : "assessment_reused_without_new_evidence",
      },
    });
    throw await completionFailure(new AppError(
      "STEP_NOT_COMPLETED",
      input.evaluation.evidenceProgressBlocked === true
        ? "The holistic assessment identified a substantive gap, but no new tool evidence was produced to repair it."
        : "The exact completion candidate was already rejected against the same evidence; resubmitting it has no material benefit.",
      422,
      {
        feedback: input.evaluation.feedback,
        repairExhausted: true,
        ...(input.evaluation.failedBoundary === undefined ? {} : { failedBoundary: input.evaluation.failedBoundary }),
      },
    ), input.step, input.output, input.evaluation);
  };
  const evaluateToolBackedCandidate = async (input: {
    readonly step: number;
    readonly output: string;
    readonly projectedToolEvidence: readonly AgentLoopToolEvidence[];
    readonly stepSemanticFrame?: Pick<StepSemanticFrame, "completionBoundary" | "evidenceMode" | "phaseRole">;
    readonly rejectionDirective: string;
  }): Promise<AgentLoopResult | undefined> => {
    const evaluation = await evaluateCandidate(input.step, {
      output: input.output,
      stepSemanticFrame: input.stepSemanticFrame,
      deliveryCandidate: buildRuntimeDeliveryCandidate({
        output: input.output,
        stepSemanticFrame: input.stepSemanticFrame,
        toolEvidence,
        sourceToolCallIds: input.projectedToolEvidence.map((item) => item.toolCallId),
      }),
      messages,
      modelSteps: input.step,
      toolEvidence,
      projectedToolEvidence: input.projectedToolEvidence,
      activatedSkillNames: [...activatedSkillNames],
      ...(contextAssembler.contextSummary === undefined
        ? {}
        : { contextSummary: contextAssembler.contextSummary }),
    });
    await emit({
      type: evaluation.approved ? "candidate.approved" : "candidate.rejected",
      data: { step: input.step, output: input.output, feedback: evaluation.feedback },
    });
    if (evaluation.approved) {
      await emit({ type: "loop.completed", data: { step: input.step, output: input.output } });
      return {
        output: input.output,
        deliveryCandidate: buildRuntimeDeliveryCandidate({
          output: input.output,
          stepSemanticFrame: input.stepSemanticFrame,
          toolEvidence,
          sourceToolCallIds: input.projectedToolEvidence.map((item) => item.toolCallId),
        }),
        messages,
        steps: input.step,
        toolEvidence,
        activatedSkillNames: [...activatedSkillNames],
      };
    }
    if (evaluation.deferredValidation === true) {
      const output = deferredValidationOutput(input.output, evaluation.feedback);
      const completionCaveat = { reason: "deferred_validation" as const, feedback: evaluation.feedback };
      const deliveryCandidate = buildRuntimeDeliveryCandidate({
        output,
        stepSemanticFrame: input.stepSemanticFrame,
        toolEvidence,
        sourceToolCallIds: input.projectedToolEvidence.map((item) => item.toolCallId),
      });
      await emit({
        type: "candidate.validation_deferred",
        data: { step: input.step, output, feedback: evaluation.feedback },
      });
      await emit({ type: "loop.completed", data: { step: input.step, output, deferredValidation: true, completionCaveat } });
      return {
        output,
        deliveryCandidate,
        messages,
        steps: input.step,
        toolEvidence,
        activatedSkillNames: [...activatedSkillNames],
        deferredValidation: true,
        completionCaveat,
      };
    }
    if (evaluation.evidenceBoundary === true) {
      const output = evidenceBoundaryOutput(input.output, evaluation.feedback);
      const completionCaveat = { reason: "evidence_boundary" as const, feedback: evaluation.feedback };
      const deliveryCandidate = buildRuntimeDeliveryCandidate({
        output,
        stepSemanticFrame: input.stepSemanticFrame,
        toolEvidence,
        sourceToolCallIds: input.projectedToolEvidence.map((item) => item.toolCallId),
      });
      await emit({
        type: "candidate.evidence_boundary_accepted",
        data: { step: input.step, output, feedback: evaluation.feedback },
      });
      await emit({ type: "loop.completed", data: { step: input.step, output, completionCaveat } });
      return {
        output,
        deliveryCandidate,
        messages,
        steps: input.step,
        toolEvidence,
        activatedSkillNames: [...activatedSkillNames],
        completionCaveat,
      };
    }
    await stopRepeatedAssessmentWithoutNewEvidence({
      step: input.step,
      output: input.output,
      evaluation,
    });
    rejectedCandidateAssessments += 1;
    if (rejectedCandidateAssessments > candidateRepairAssessmentLimit) {
      if (evaluation.allowRepairLimitCompletion !== true) {
        await emit({
          type: "candidate.repair_limit_blocked",
          data: {
            step: input.step,
            output: input.output,
            feedback: evaluation.feedback,
            rejectedCandidateAssessments,
            candidateRepairAssessmentLimit,
          },
        });
        throw await completionFailure(new AppError(
          "STEP_NOT_COMPLETED",
          "The latest completion candidate still fails required success criteria and cannot be accepted with a repair-limit caveat.",
          422,
          {
            feedback: evaluation.feedback,
            repairExhausted: true,
            ...(evaluation.failedBoundary === undefined ? {} : { failedBoundary: evaluation.failedBoundary }),
          },
        ), input.step, input.output, evaluation);
      }
      const output = repairLimitCompletionOutput(input.output, candidateRepairAssessmentLimit);
      const completionCaveat = { reason: "repair_limit" as const, feedback: evaluation.feedback };
      const deliveryCandidate = buildRuntimeDeliveryCandidate({
        output,
        stepSemanticFrame: input.stepSemanticFrame,
        toolEvidence,
        sourceToolCallIds: input.projectedToolEvidence.map((item) => item.toolCallId),
      });
      await emit({
        type: "candidate.completion_caveated",
        data: {
          step: input.step,
          output,
          feedback: evaluation.feedback,
          reason: completionCaveat.reason,
          rejectedCandidateAssessments,
          candidateRepairAssessmentLimit,
        },
      });
      await emit({ type: "loop.completed", data: { step: input.step, output, completionCaveat } });
      return {
        output,
        deliveryCandidate,
        messages,
        steps: input.step,
        toolEvidence,
        activatedSkillNames: [...activatedSkillNames],
        completionCaveat,
      };
    }
    requestedConvergenceReason = undefined;
    setCandidateRepairDirective([
      candidateRepairDirective(evaluation, input.rejectionDirective),
      candidateRejectionProgressHint({
        policy: options.progressPolicy,
        evidence: toolEvidence,
        rejectedCandidateCount: rejectedCandidateAssessments,
      }),
    ].join("\n"));
    return undefined;
  };
  let lastModelStep = 0;
  try {
  for (let step = 1; step <= currentLimit(); step += 1) {
    lastModelStep = step;
    throwIfAborted(options.signal);
    const inGrace = step > options.maxSteps;
    const hardLimit = currentLimit();
    // A convergence turn removes every executable Tool.  It is only sound
    // when the current step has no remaining receipt-backed obligation.  A
    // caller-specific heuristic (for example, a complete source extraction)
    // may say that exploration is no longer useful, but it cannot bypass a
    // still-missing hard evidence kind such as derived_aggregation.
    const stepEvidenceState = deriveRuntimeStepEvidenceState({
      policy: options.progressPolicy,
      evidence: toolEvidence,
    });
    const missingToolEvidenceKinds = stepEvidenceState?.missingToolEvidenceKinds ?? [];
    const canConvergeFromCurrentEvidence = missingToolEvidenceKinds.length === 0;
    const finalConvergenceAllowed = requestedConvergenceReason !== undefined
      || step !== hardLimit
      || await shouldUseFinalConvergence(options.shouldUseFinalConvergence, {
        step,
        messages,
        toolEvidence,
        latestToolEvidence: toolEvidence,
        activatedSkillNames: [...activatedSkillNames],
      });
    const convergenceOnly = !humanLoopRepairPending
      && toolEvidence.length > 0
      && canConvergeFromCurrentEvidence
      && (requestedConvergenceReason !== undefined || (step === hardLimit && finalConvergenceAllowed));
    if (convergenceOnly) {
      convergenceRequested = true;
      const directive = pendingCandidateRepairDirective
        ?? pendingStructuredObservationSynthesisDirective
        ?? convergencePrompt;
      pendingCandidateRepairDirective = undefined;
      pendingStructuredObservationSynthesisDirective = undefined;
      contextAssembler.setRuntimeDirective(directive);
      await emit({
        type: "loop.convergence_requested",
        data: {
          step,
          maxSteps: options.maxSteps,
          convergenceGraceSteps: graceSteps,
          hardLimit,
          priorToolResultCount: toolEvidence.length,
          ...(requestedConvergenceReason === undefined ? {} : { reason: requestedConvergenceReason }),
        },
      });
    }
    await emit({ type: "step.started", data: { step, phase: convergenceOnly ? "convergence" : "execution" } });

    // Ported from OpenCode's materialization boundary: each model step gets a
    // fresh authorized snapshot, and preparation remains tied to that snapshot.
    const grantedMaterialized = options.tools.materialize(options.grant, {
      decisionLedger: options.runtimeContext?.decisionLedger,
    });
    const workProductProjection = await workProducts?.project();
    const stepExecutionDecision = stepExecutionStrategy.prepareModelStep({
      modelStep: step,
      maxSteps: options.maxSteps,
      hardLimit,
      convergenceOnly,
      availableTools: convergenceOnly ? [] : grantedMaterialized.definitions,
      priorToolEvidence: toolEvidence,
      stepEvidenceState,
      stepSemanticFrame: options.stepSemanticFrame,
      ...(workProductProjection === undefined ? {} : { workProductContext: workProductProjection }),
    });
    validateToolRecommendations(
      convergenceOnly ? [] : grantedMaterialized.definitions,
      stepExecutionDecision,
    );
    // Recommendations order the model-visible catalog; they never rewrite the
    // Run grant. A tool that is not preferred for this step remains callable.
    const executionDefinitions = orderDefinitionsByPreference(
      grantedMaterialized.definitions,
      stepExecutionDecision.toolCatalog.preferredToolNames,
    );
    // Runtime owns fact visibility, including with strategies that predate this optional input.
    // Strategy recommendations and completion gates remain unchanged.
    contextAssembler.setRuntimeStepFrame(JSON.stringify(workProductProjection === undefined
      ? stepExecutionDecision.loopStepFrame
      : { ...stepExecutionDecision.loopStepFrame, currentEvidenceState: undefined, workProductContext: workProductProjection }));
    contextAssembler.setPromptProjectionPolicy(stepExecutionDecision.promptProjection);
    await emit({
      type: "step_execution.policy_applied",
      data: {
        step,
        strategyId: stepExecutionDecision.strategyId,
        toolCatalogMode: stepExecutionDecision.toolCatalog.mode,
        availableToolCount: executionDefinitions.length,
        preferredToolCount: stepExecutionDecision.toolCatalog.preferredToolNames.length,
        deprioritizedToolGroupCount: stepExecutionDecision.toolCatalog.deprioritizedToolGroups.length,
        promptProjectionMode: stepExecutionDecision.promptProjection.mode,
        trace: stepExecutionDecision.trace,
      },
    });
    let assembly = await contextAssembler.assemble(messages, convergenceOnly ? [] : executionDefinitions, options.signal);

    let earlyOutcomes = new Map<string, ToolOutcome>();
    let response: ModelResponse | undefined;
    for (let candidateAttempt = 1; candidateAttempt <= EMPTY_CANDIDATE_REPAIR_ATTEMPTS; candidateAttempt += 1) {
      const invocation: ModelInvocation = {
        runId: options.runId,
        systemPrompt: options.systemPrompt,
        phase: "execution",
        runtimeContext: assembly.runtimeContext,
        messages: assembly.messages,
        tools: convergenceOnly ? [] : executionDefinitions,
        ...(convergenceOnly || executionDefinitions.length === 0
          ? {}
          : { toolChoice: "auto" as const }),
        maxOutputTokens: convergenceOnly
          ? Math.min(convergenceMaxOutputTokens, options.model.limits.maxOutputTokens)
          : options.model.limits.maxOutputTokens,
      };
      earlyOutcomes = new Map<string, ToolOutcome>();
      response = await completeWithStreamingAndDispatch({
        model: options.model,
        invocation,
        emit,
        step,
        signal: options.signal,
        grant: options.grant,
        prepare: (call) => grantedMaterialized.prepare(call),
        maxToolResultCharacters,
        maxParallelToolCalls,
        actionTracker: options.actionTracker,
        toolCallLimits,
        priorToolCallCounts: countToolCallsByName(toolEvidence),
        // Each ready call is admitted against the same per-Tool ceiling as a
        // completed response. Later calls beyond that ceiling are rejected;
        // they never roll back a valid, already-dispatched earlier call.
        allowEarlyDispatch: true,
      }, earlyOutcomes);
      if (
        response.toolCalls.length === 0
        && response.finishReason === "stop"
        && response.content.trim().length === 0
        && candidateAttempt < EMPTY_CANDIDATE_REPAIR_ATTEMPTS
      ) {
        await emit({
          type: "candidate.rejected",
          data: { step, output: response.content, feedback: "Completion candidate was empty" },
        });
        contextAssembler.setRuntimeDirective(EMPTY_CANDIDATE_REPAIR_PROMPT);
        assembly = await contextAssembler.assemble(
          messages,
          convergenceOnly ? [] : executionDefinitions,
          options.signal,
        );
        continue;
      }
      if (
        convergenceOnly
        && response.toolCalls.length === 0
        && response.finishReason === "stop"
        && (isTextToolInvocation(response.content) || isInternalEvidenceMarkupCandidate(response.content))
        && candidateAttempt < EMPTY_CANDIDATE_REPAIR_ATTEMPTS
      ) {
        const internalEvidenceMarkup = isInternalEvidenceMarkupCandidate(response.content);
        await emit({
          type: "candidate.rejected",
          data: {
            step,
            output: response.content,
            feedback: internalEvidenceMarkup
              ? "Completion candidate exposed internal Runtime evidence markup"
              : "Completion candidate was an unexecuted tool invocation",
          },
        });
        contextAssembler.setRuntimeDirective(internalEvidenceMarkup
          ? INTERNAL_EVIDENCE_MARKUP_REPAIR_PROMPT
          : TEXT_TOOL_INVOCATION_REPAIR_PROMPT);
        assembly = await contextAssembler.assemble(messages, [], options.signal);
        continue;
      }
      break;
    }
    if (response === undefined) throw new AppError("MODEL_ERROR", "Model did not produce a response", 502);
    // A length-truncated response can contain an incomplete native tool call.
    // Only calls that a provider explicitly marked ready may have executed, so
    // never carry the remaining calls into the next provider-native transcript.
    // Their outcomes still become Runtime-owned evidence below.
    const replayableToolCalls = response.finishReason === "length"
      ? response.toolCalls.filter((call) => earlyOutcomes.has(call.id))
      : response.toolCalls;

    // This awaited event is the durable checkpoint before any external effect.
    await emit({
      type: "assistant.committed",
      data: {
        step,
        content: response.content,
        finishReason: response.finishReason,
        toolCalls: response.toolCalls,
        ...(response.finishReason === "length"
          ? { providerReplayableToolCallIds: replayableToolCalls.map((call) => call.id) }
          : {}),
        ...(response.reasoningContent === undefined ? {} : { reasoningContent: response.reasoningContent }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      },
    });

    if (response.toolCalls.length === 0) {
      const assistantMessage: ModelMessage = {
        role: "assistant",
        content: response.content,
        ...(response.reasoningContent === undefined ? {} : { reasoningContent: response.reasoningContent }),
      };
      // Do not retain an unexecuted, truncated assistant turn as a prior model
      // message. The next-turn Runtime directive carries its explicit failure
      // evidence without pretending that a native function exchange occurred.
      if (response.finishReason !== "length") messages.push(assistantMessage);
      if (response.finishReason !== "stop") {
        const feedback = `Completion candidate was not accepted because the model finished with ${response.finishReason}`;
        await emit({ type: "candidate.rejected", data: { step, output: response.content, feedback } });
        removeRejectedAssistantCandidate(messages, assistantMessage);
        await grantCandidateRepairGrace(step, feedback);
        contextAssembler.setRuntimeDirective(lengthTruncationRepairDirective({
          feedback,
          convergenceOnly,
          toolAvailable: executionDefinitions.length > 0,
        }));
        continue;
      }
      // A no-tool turn cannot execute a provider protocol envelope. Treat a
      // literal rendered tool call as an invalid completion candidate before it
      // reaches the assessor or direct-answer delivery.
      if (isTextToolInvocation(response.content)) {
        const feedback = "Completion candidate was an unexecuted tool invocation; the model must either call an available Tool structurally or provide a real completion statement";
        await emit({
          type: "candidate.rejected",
          data: {
            step,
            output: response.content,
            feedback,
          },
        });
        removeRejectedAssistantCandidate(messages, assistantMessage);
        if (convergenceOnly) {
          throw new AppError(
            "STEP_NOT_COMPLETED",
            "Convergence could not produce a completion candidate because the model emitted an unexecuted text tool invocation after execution tools were reserved.",
            422,
            { feedback, convergenceRequested: true },
          );
        }
        continue;
      }
      if (isInternalEvidenceMarkupCandidate(response.content)) {
        const feedback = "Completion candidate exposed internal Runtime evidence markup instead of a user-visible assistant answer";
        await emit({
          type: "candidate.rejected",
          data: {
            step,
            output: response.content,
            feedback,
          },
        });
        removeRejectedAssistantCandidate(messages, assistantMessage);
        // This candidate never reaches Assessment, but it must consume the
        // same bounded repair budget.  Otherwise a provider that imitates a
        // server transcript can exhaust the Run without acquiring any new
        // evidence or producing a user-visible summary.
        rejectedUnassessableCandidates += 1;
        if (rejectedUnassessableCandidates >= Math.max(1, candidateRepairAssessmentLimit)) {
          await emit({
            type: "candidate.repair_limit_blocked",
            data: {
              step,
              output: response.content,
              feedback,
              rejectedCandidateAssessments: rejectedUnassessableCandidates,
              rejectedUnassessableCandidates,
              candidateRepairAssessmentLimit,
            },
          });
          throw new AppError(
            "STEP_NOT_COMPLETED",
            "The model repeatedly emitted internal Runtime markup instead of a user-visible completion candidate.",
            422,
            { feedback, rejectedUnassessableCandidateCount: rejectedUnassessableCandidates },
          );
        }
        await grantCandidateRepairGrace(step, feedback);
        setCandidateRepairDirective([
          INTERNAL_EVIDENCE_MARKUP_REPAIR_PROMPT,
          candidateRejectionProgressHint({
            policy: options.progressPolicy,
            evidence: toolEvidence,
            rejectedCandidateCount: rejectedUnassessableCandidates,
          }),
        ].join("\n"));
        continue;
      }
      const evaluation = await evaluateCandidate(step, {
        output: response.content,
        stepSemanticFrame: options.stepSemanticFrame,
        deliveryCandidate: buildRuntimeDeliveryCandidate({
          output: response.content,
          stepSemanticFrame: options.stepSemanticFrame,
          toolEvidence,
        }),
        messages,
        modelSteps: step,
        toolEvidence,
        projectedToolEvidence: contextAssembler.projectToolEvidence(messages, toolEvidence),
        activatedSkillNames: [...activatedSkillNames],
        ...(contextAssembler.contextSummary === undefined
          ? {}
          : { contextSummary: contextAssembler.contextSummary }),
      });
      await emit({
        type: evaluation.approved ? "candidate.approved" : "candidate.rejected",
        data: { step, output: response.content, feedback: evaluation.feedback },
      });
      if (evaluation.approved) {
        await emit({ type: "loop.completed", data: { step, output: response.content } });
        return {
          output: response.content,
          deliveryCandidate: buildRuntimeDeliveryCandidate({
            output: response.content,
            stepSemanticFrame: options.stepSemanticFrame,
            toolEvidence,
          }),
          messages,
          steps: step,
          toolEvidence,
          activatedSkillNames: [...activatedSkillNames],
        };
      }
      if (evaluation.deferredValidation === true) {
        const output = deferredValidationOutput(response.content, evaluation.feedback);
        const completionCaveat = { reason: "deferred_validation" as const, feedback: evaluation.feedback };
        await emit({
          type: "candidate.validation_deferred",
          data: { step, output, feedback: evaluation.feedback },
        });
        await emit({ type: "loop.completed", data: { step, output, deferredValidation: true, completionCaveat } });
        return {
          output,
          deliveryCandidate: buildRuntimeDeliveryCandidate({
            output,
            stepSemanticFrame: options.stepSemanticFrame,
            toolEvidence,
          }),
          messages,
          steps: step,
          toolEvidence,
          activatedSkillNames: [...activatedSkillNames],
          deferredValidation: true,
          completionCaveat,
        };
      }
      if (evaluation.evidenceBoundary === true) {
        const output = evidenceBoundaryOutput(response.content, evaluation.feedback);
        const completionCaveat = { reason: "evidence_boundary" as const, feedback: evaluation.feedback };
        await emit({
          type: "candidate.evidence_boundary_accepted",
          data: { step, output, feedback: evaluation.feedback },
        });
        await emit({ type: "loop.completed", data: { step, output, completionCaveat } });
        return {
          output,
          deliveryCandidate: buildRuntimeDeliveryCandidate({
            output,
            stepSemanticFrame: options.stepSemanticFrame,
            toolEvidence,
          }),
          messages,
          steps: step,
          toolEvidence,
          activatedSkillNames: [...activatedSkillNames],
          completionCaveat,
        };
      }
      await stopRepeatedAssessmentWithoutNewEvidence({
        step,
        output: response.content,
        evaluation,
      });
      rejectedCandidateAssessments += 1;
      if (rejectedCandidateAssessments > candidateRepairAssessmentLimit) {
        if (evaluation.allowRepairLimitCompletion !== true) {
          await emit({
            type: "candidate.repair_limit_blocked",
            data: {
              step,
              output: response.content,
              feedback: evaluation.feedback,
              rejectedCandidateAssessments,
              candidateRepairAssessmentLimit,
            },
          });
          throw await completionFailure(new AppError(
            "STEP_NOT_COMPLETED",
            "The latest completion candidate still fails required success criteria and cannot be accepted with a repair-limit caveat.",
            422,
            {
              feedback: evaluation.feedback,
              repairExhausted: true,
              ...(evaluation.failedBoundary === undefined ? {} : { failedBoundary: evaluation.failedBoundary }),
            },
          ), step, response.content, evaluation);
        }
        const output = repairLimitCompletionOutput(response.content, candidateRepairAssessmentLimit);
        const completionCaveat = { reason: "repair_limit" as const, feedback: evaluation.feedback };
        await emit({
          type: "candidate.completion_caveated",
          data: {
            step,
            output,
            feedback: evaluation.feedback,
            reason: completionCaveat.reason,
            rejectedCandidateAssessments,
            candidateRepairAssessmentLimit,
          },
        });
        await emit({ type: "loop.completed", data: { step, output, completionCaveat } });
        return {
          output,
          deliveryCandidate: buildRuntimeDeliveryCandidate({
            output,
            stepSemanticFrame: options.stepSemanticFrame,
            toolEvidence,
          }),
          messages,
          steps: step,
          toolEvidence,
          activatedSkillNames: [...activatedSkillNames],
          completionCaveat,
        };
      }
      requestedConvergenceReason = undefined;
      removeRejectedAssistantCandidate(messages, assistantMessage);
      await grantCandidateRepairGrace(step, evaluation.feedback);
      setCandidateRepairDirective(
        [
          candidateRepairDirective(evaluation, "Completion was rejected. Repair this step using the available evidence."),
          candidateRejectionProgressHint({
            policy: options.progressPolicy,
            evidence: toolEvidence,
            rejectedCandidateCount: rejectedCandidateAssessments,
          }),
        ].join("\n"),
      );
      continue;
    }

    pendingCandidateRepairDirective = undefined;
    contextAssembler.setRuntimeDirective(undefined);

    // Progress evaluation informs the next model turn, but does not turn a
    // predicted next action into a second authorization boundary. An already
    // authorized call can still be the model's needed state-acquisition step.
    let progressHint: string | undefined;
    if (
      !convergenceOnly
      && response.finishReason !== "length"
      && response.toolCalls.length > 0
    ) {
      const progressDecision = evaluateRuntimeToolProgress({
        policy: options.progressPolicy,
        state: toolProgressState,
        inGrace,
        calls: response.toolCalls,
        priorEvidence: toolEvidence,
      });
      toolProgressState = progressDecision.state;
      progressHint = progressDecision.progressHint;
    }

    let outcomes: ToolOutcome[];
    if (convergenceOnly) {
      outcomes = response.toolCalls.map((call) => ({
        call,
        content: "Tool call was not executed because the Runtime reserved this final step for convergence",
        invocationStatus: "rejected",
        operationStatus: "unknown",
        isError: true,
        failurePhase: "runtime",
      }));
      for (const outcome of outcomes) {
        await emit({
          type: "tool.rejected",
          data: {
            step,
            toolCallId: outcome.call.id,
            toolName: outcome.call.name,
            reason: outcome.content,
            invocationStatus: "rejected",
            operationStatus: "unknown",
            isError: true,
            failurePhase: "runtime",
          },
        });
      }
    } else if (response.finishReason === "length") {
      // A truncated response may carry syntactically valid but incomplete tool
      // arguments. Calls whose arguments completed before truncation (per-item
      // done) were already dispatched and keep their real outcome; the rest are
      // never dispatched.
      outcomes = response.toolCalls.map((call) => {
        const early = earlyOutcomes.get(call.id);
        if (early !== undefined) return early;
        return {
          call,
          content: "Tool call was not executed because the model response hit its output limit",
          invocationStatus: "rejected",
          operationStatus: "unknown",
          isError: true,
          failurePhase: "runtime",
        };
      });
      for (const outcome of outcomes) {
        if (earlyOutcomes.has(outcome.call.id)) continue;
        await emit({
          type: "tool.rejected",
          data: {
            step,
            toolCallId: outcome.call.id,
            toolName: outcome.call.name,
            reason: outcome.content,
            invocationStatus: "rejected",
            operationStatus: "unknown",
            isError: true,
            failurePhase: "runtime",
          },
        });
      }
    } else {
      // Tool calls whose arguments completed during the stream were already
      // dispatched and are present in earlyOutcomes; only dispatch the rest.
      const remainingCalls = response.toolCalls.filter((call) => !earlyOutcomes.has(call.id));
      const prepared: PreparedEntry[] = [];
      const quotaRejectedOutcomes = new Map<string, ToolOutcome>();
      const admittedToolCalls = countEarlyAdmittedToolCalls(earlyOutcomes);
      for (const call of remainingCalls) {
        const limit = toolCallLimits.get(call.name);
        const priorCalls = toolEvidence.filter((item) => item.toolName === call.name).length;
        const admittedCalls = admittedToolCalls.get(call.name) ?? 0;
        if (limit !== undefined && priorCalls + admittedCalls >= limit) {
          const message = `Tool call limit reached for ${call.name}: at most ${limit} call(s) are allowed for this Plan step`;
          await emit({
            type: "tool.rejected",
            data: {
              step,
              toolCallId: call.id,
              toolName: call.name,
              reason: message,
              invocationStatus: "rejected",
              operationStatus: "unknown",
              isError: true,
              failurePhase: "runtime",
            },
          });
          quotaRejectedOutcomes.set(call.id, {
            call,
            content: message,
            invocationStatus: "rejected",
            operationStatus: "unknown",
            isError: true,
            failurePhase: "runtime",
          });
          continue;
        }
        admittedToolCalls.set(call.name, admittedCalls + 1);
        try {
          const value = grantedMaterialized.prepare(call);
          await emit({
            type: "tool.planned",
            data: {
              step,
              toolCallId: call.id,
              toolName: call.name,
              arguments: call.arguments,
              replaySafe: value.tool.replaySafe,
            },
          });
          prepared.push({ kind: "ready", value });
        } catch (error) {
          const message = publicErrorMessage(error);
          await emit({
            type: "tool.rejected",
            data: {
              step,
              toolCallId: call.id,
              toolName: call.name,
              reason: message,
              invocationStatus: "rejected",
              operationStatus: "unknown",
              isError: true,
              failurePhase: "prepare",
            },
          });
          prepared.push({ kind: "rejected", call, message });
        }
      }

      // Adapted from DeepSeek Harness tool-calls.ts: exclusive calls are
      // barriers; contiguous parallel calls use a bounded pool, while returned
      // outcomes remain in model order.
      const lateOutcomes = await executePreparedSchedule(
        prepared,
        options.grant,
        step,
        emit,
        options.signal,
        maxToolResultCharacters,
        maxParallelToolCalls,
        options.actionTracker,
      );
      let lateIndex = 0;
      outcomes = response.toolCalls.map((call) => {
        const early = earlyOutcomes.get(call.id);
        if (early !== undefined) return early;
        const quotaRejected = quotaRejectedOutcomes.get(call.id);
        if (quotaRejected !== undefined) return quotaRejected;
        return lateOutcomes[lateIndex++];
      });
    }

    // A tool call rejected during prepare did not form a provider-valid native
    // function exchange. Replaying it (or an orphaned tool result) can make a
    // schema-valid repair request fail at the provider before the model sees
    // the Runtime's repair instruction. Preserve the rejection as neutral
    // server evidence instead, for every Tool rather than only HIL.
    const rejectedProviderToolCalls = replayableToolCalls.filter((call) =>
      outcomes.some((outcome) => outcome.call.id === call.id && outcome.failurePhase === "prepare"),
    );
    const providerReplayableToolCalls = replayableToolCalls.filter((call) =>
      !rejectedProviderToolCalls.some((rejected) => rejected.id === call.id),
    );
    const replayableToolCallIds = new Set(providerReplayableToolCalls.map((call) => call.id));
    const assistantMessage: ModelMessage = {
      role: "assistant",
      content: response.content,
      ...(providerReplayableToolCalls.length === 0 ? {} : { toolCalls: providerReplayableToolCalls }),
      ...(response.reasoningContent === undefined ? {} : { reasoningContent: response.reasoningContent }),
    };
    if (response.finishReason !== "length" || providerReplayableToolCalls.length > 0) messages.push(assistantMessage);

    // Provider protocol requires tool results in source call order even when the
    // actual effects complete out of order.
    const latestToolEvidence: AgentLoopToolEvidence[] = [];
    for (const outcome of outcomes) {
      const evidence = {
        toolCallId: outcome.call.id,
        toolName: outcome.call.name,
        result: outcome.content,
        invocationStatus: outcome.invocationStatus,
        operationStatus: outcome.operationStatus,
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        isError: outcome.isError,
        ...(outcome.failurePhase === undefined ? {} : { failurePhase: outcome.failurePhase }),
        ...(outcome.resultRef === undefined ? {} : { resultRef: outcome.resultRef }),
      };
      toolEvidence.push(evidence);
      latestToolEvidence.push(evidence);
      if (replayableToolCallIds.has(outcome.call.id)) {
        messages.push({
          role: "tool",
          toolCallId: outcome.call.id,
          name: outcome.call.name,
          content: outcome.content,
          isError: outcome.isError,
        });
      }
      if (!outcome.isError && outcome.call.name === "load_skill") {
        const name = skillNameFromArguments(outcome.call.arguments);
        const skill = name === undefined ? undefined : availableSkills.get(name);
        if (skill !== undefined) {
          activatedSkillNames.add(skill.name);
          await emit({
            type: "skill.activated",
            data: {
              step,
              skillId: skill.id,
              name: skill.name,
              contentHash: skill.contentHash,
              toolCallId: outcome.call.id,
            },
          });
        }
      }
    }
    if (rejectedProviderToolCalls.length > 0) {
      messages.push({
        role: "user",
        content: rejectedToolCallsEvidenceMessage(rejectedProviderToolCalls, outcomes),
      });
    }
    await emit({
      type: "step.completed",
      data: {
        step,
        toolResults: outcomes.map((item) => ({
          toolCallId: item.call.id,
          invocationStatus: item.invocationStatus,
          operationStatus: item.operationStatus,
          ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
          isError: item.isError,
        })),
      },
    });

    const humanLoop = humanLoopRequirementFromEvidence(latestToolEvidence);
    if (humanLoop !== undefined) {
      await emit({
        type: "human_loop.required",
        data: { step, toolCallId: humanLoop.toolCallId, requirement: humanLoop.requirement },
      });
      throw new AppError("HUMAN_LOOP_REQUIRED", "A user response is required before this Step can continue", 409, {
        requirement: humanLoop.requirement,
        sourceToolCallId: humanLoop.toolCallId,
      });
    }

    // Calling the Runtime-owned HIL Tool is an explicit assertion that this
    // Step cannot safely advance without a user response. A Provider can emit
    // malformed function arguments before the Tool executes, so allow one
    // bounded repair turn. That turn remains HIL-blocked: it cannot produce an
    // artifact or a completion candidate in place of a durable request.
    const rejectedHumanLoop = outcomes.find((outcome) =>
      outcome.call.name === HUMAN_LOOP_TOOL_NAME
      && outcome.isError
      && outcome.failurePhase === "prepare"
    );
    if (rejectedHumanLoop !== undefined) {
      invalidHumanLoopAttempts += 1;
      await emit({
        type: "human_loop.invalid",
        data: {
          step,
          toolCallId: rejectedHumanLoop.call.id,
          attempt: invalidHumanLoopAttempts,
          reason: rejectedHumanLoop.content,
        },
      });
      if (invalidHumanLoopAttempts === 1) {
        humanLoopRepairPending = true;
        contextAssembler.setRuntimeDirective(invalidHumanLoopRepairDirective(rejectedHumanLoop.content));
        continue;
      }
      throw new AppError(
        "HUMAN_LOOP_INVALID",
        "Human-in-the-Loop request must be valid before this Step can continue",
        422,
        {
          sourceToolCallId: rejectedHumanLoop.call.id,
          reason: rejectedHumanLoop.content,
          attempts: invalidHumanLoopAttempts,
        },
      );
    }

    const prepareRejectionSignature = allPrepareRejectionSignature(outcomes);
    if (prepareRejectionSignature !== undefined) {
      if (prepareRejectionSignature === previousPrepareRejectionSignature) {
        consecutivePrepareRejectionSteps += 1;
      } else {
        previousPrepareRejectionSignature = prepareRejectionSignature;
        consecutivePrepareRejectionSteps = 1;
      }
      const repeated = consecutivePrepareRejectionSteps > 1;
      if (repeated) {
        stalled = consecutivePrepareRejectionSteps >= 3;
        await emit({
          type: "loop.no_progress",
          data: {
            step,
            phase: "execution",
            toolSignature: prepareRejectionSignature,
            reason: "Tool calls repeatedly failed argument validation before execution",
            stalled,
          },
        });
        if (stalled) break;
      }
      contextAssembler.setRuntimeDirective(prepareRejectionRepairDirective({
        outcomes,
        repeated,
      }));
      continue;
    }
    previousPrepareRejectionSignature = undefined;
    consecutivePrepareRejectionSteps = 0;

    const evidenceCompletionCandidate = options.evaluateCandidate === undefined
      ? undefined
      : deriveEvidenceCompletionCandidate({
        policy: options.progressPolicy,
        evidence: toolEvidence,
        latestEvidence: latestToolEvidence,
        userInput: options.input,
      });
    // Once the requested artifact has an accepted Runtime receipt, it is the
    // delivery boundary. A prior source Tool's deliveryCandidate remains useful
    // source material, but must not replace the verified file with a Markdown
    // or prose projection at TerminalCommitter.
    if (
      evidenceCompletionCandidate !== undefined
      && evidenceCompletionCandidateHasAcceptedArtifact(options.progressPolicy, toolEvidence)
    ) {
      await emit({
        type: "candidate.evidence_completion_detected",
        data: {
          step,
          requiredEvidenceKinds: evidenceCompletionCandidate.requiredEvidenceKinds,
          satisfiedEvidenceKinds: evidenceCompletionCandidate.satisfiedEvidenceKinds,
          caveatedEvidenceKinds: evidenceCompletionCandidate.caveatedEvidenceKinds,
          sourceToolCallIds: evidenceCompletionCandidate.sourceToolCallIds,
          artifacts: evidenceCompletionCandidate.artifacts,
        },
      });
      const completion = await evaluateToolBackedCandidate({
        step,
        output: evidenceCompletionCandidate.output,
        projectedToolEvidence: toolEvidence,
        stepSemanticFrame: options.stepSemanticFrame,
        rejectionDirective: "Runtime evidence completion candidate was rejected. Repair this step using the available evidence.",
      });
      if (completion !== undefined) return completion;
      continue;
    }

    // A structured source Tool may return a concise user-facing candidate,
    // but that result is source evidence rather than a substitute for a
    // separately requested work product. Do not repeatedly assess an
    // API/catalog result while the Step still requires a file write, format
    // check, or artifact-acceptance receipt: that would consume the
    // candidate-repair budget before the progress policy can finish delivery.
    const structuredCandidates = options.evaluateCandidate === undefined
      || structuredCandidateIsBlockedByPendingArtifactEvidence(options.progressPolicy, toolEvidence)
      ? undefined
      : selectStructuredToolCandidate(toolEvidence);
    if (structuredCandidates?.directCandidate !== undefined) {
      const structuredCandidate = structuredCandidates.directCandidate;
      await emit({
        type: "candidate.structured_tool_detected",
        data: {
          step,
          toolCallId: structuredCandidate.sourceToolCallId,
          ...(structuredCandidate.schema === undefined ? {} : { schema: structuredCandidate.schema }),
        },
      });
      const completion = await evaluateToolBackedCandidate({
        step,
        output: structuredCandidate.deliveryCandidate.output,
        projectedToolEvidence: projectStructuredCandidateEvidence(toolEvidence, structuredCandidate),
        stepSemanticFrame: options.stepSemanticFrame,
        rejectionDirective: "Structured tool candidate was rejected. Repair this step using the available evidence.",
      });
      if (completion !== undefined) return completion;
      continue;
    }
    if (structuredCandidates !== undefined && structuredCandidates.observations.length > 1) {
      pendingStructuredObservationSynthesisDirective = structuredObservationSynthesisDirective(
        structuredCandidates.observations,
      );
      requestedConvergenceReason = "structured_tool_observations_require_synthesis";
      await emit({
        type: "candidate.structured_tool_synthesis_required",
        data: {
          step,
          observationCount: structuredCandidates.observations.length,
          sourceToolCallIds: structuredCandidates.observations.map((candidate) => candidate.sourceToolCallId),
          schemas: [...new Set(structuredCandidates.observations
            .map((candidate) => candidate.schema)
            .filter((schema): schema is string => schema !== undefined))],
        },
      });
      if (step === hardLimit && grantedFinalConvergenceGraceSteps === 0) {
        grantedFinalConvergenceGraceSteps = 1;
        await emit({
          type: "loop.final_convergence_grace_granted",
          data: {
            step,
            reason: requestedConvergenceReason,
            finalConvergenceGraceSteps: grantedFinalConvergenceGraceSteps,
            hardLimit: currentLimit(),
          },
        });
      }
      continue;
    }

    if (evidenceCompletionCandidate !== undefined) {
      await emit({
        type: "candidate.evidence_completion_detected",
        data: {
          step,
          requiredEvidenceKinds: evidenceCompletionCandidate.requiredEvidenceKinds,
          satisfiedEvidenceKinds: evidenceCompletionCandidate.satisfiedEvidenceKinds,
          caveatedEvidenceKinds: evidenceCompletionCandidate.caveatedEvidenceKinds,
          sourceToolCallIds: evidenceCompletionCandidate.sourceToolCallIds,
          artifacts: evidenceCompletionCandidate.artifacts,
        },
      });
      const completion = await evaluateToolBackedCandidate({
        step,
        output: evidenceCompletionCandidate.output,
        projectedToolEvidence: toolEvidence,
        stepSemanticFrame: options.stepSemanticFrame,
        rejectionDirective: "Runtime evidence completion candidate was rejected. Repair this step using the available evidence.",
      });
      if (completion !== undefined) return completion;
      continue;
    }

    const convergenceDecision = await evaluateToolStepConvergence(options.shouldConvergeAfterToolStep, {
      step,
      messages,
      toolEvidence,
      latestToolEvidence,
      activatedSkillNames: [...activatedSkillNames],
    });
    const evidenceStateAfterToolStep = deriveRuntimeStepEvidenceState({
      policy: options.progressPolicy,
      evidence: toolEvidence,
    });
    const missingToolEvidenceKindsAfterToolStep = evidenceStateAfterToolStep?.missingToolEvidenceKinds ?? [];
    const convergenceQueued = convergenceDecision.converge && missingToolEvidenceKindsAfterToolStep.length === 0;
    if (convergenceDecision.converge && !convergenceQueued) {
      await emit({
        type: "loop.convergence_deferred",
        data: {
          step,
          reason: convergenceDecision.reason ?? "tool_evidence_ready",
          missingToolEvidenceKinds: missingToolEvidenceKindsAfterToolStep,
          priorToolResultCount: toolEvidence.length,
        },
      });
    }
    if (convergenceQueued) {
      requestedConvergenceReason = convergenceDecision.reason ?? "tool_evidence_ready";
      await emit({
        type: "loop.convergence_queued",
        data: {
          step,
          reason: requestedConvergenceReason,
          priorToolResultCount: toolEvidence.length,
          sourceAcquisition: sourceAcquisitionMetrics(toolEvidence),
          latestSourceAcquisition: sourceAcquisitionMetrics(latestToolEvidence),
        },
      });
      if (step === hardLimit && grantedFinalConvergenceGraceSteps === 0) {
        grantedFinalConvergenceGraceSteps = 1;
        await emit({
          type: "loop.final_convergence_grace_granted",
          data: {
            step,
            reason: requestedConvergenceReason,
            finalConvergenceGraceSteps: grantedFinalConvergenceGraceSteps,
            hardLimit: currentLimit(),
          },
        });
      }
    }
    if (!convergenceQueued) {
      contextAssembler.setRuntimeDirective(executionFeedbackDirective({
        suppressLegacyWorkProductProjection: workProducts !== undefined,
        latestToolEvidence,
        toolEvidence,
        progressPolicy: options.progressPolicy,
        progressHint,
      }));
    }
  }

  await emit({
    type: "loop.limit_exceeded",
    data: {
      maxSteps: options.maxSteps,
      convergenceGraceSteps: graceSteps,
      candidateRepairGraceSteps,
      finalConvergenceGraceSteps: grantedFinalConvergenceGraceSteps,
      candidateRepairAssessmentLimit,
      grantedCandidateRepairGraceSteps,
      hardLimit: currentLimit(),
      convergenceRequested,
      stalled,
    },
  });
  throw new AppError(
    "RUN_LIMIT_EXCEEDED",
    stalled
      ? `Run stopped extending its budget: the model repeated identical tool calls without forward progress (${options.maxSteps} primary + ${graceSteps} convergence grace)`
      : `Run exceeded its ${currentLimit()}-step limit (${options.maxSteps} primary + ${graceSteps} convergence grace + ${grantedCandidateRepairGraceSteps} candidate repair grace + ${grantedFinalConvergenceGraceSteps} final convergence grace)`,
    409,
    {
      maxSteps: options.maxSteps,
      convergenceGraceSteps: graceSteps,
      candidateRepairGraceSteps,
      candidateRepairAssessmentLimit,
      grantedCandidateRepairGraceSteps,
      finalConvergenceGraceSteps: grantedFinalConvergenceGraceSteps,
      hardLimit: currentLimit(),
      stalled,
    },
  );
  } catch (error) {
    // A single exit boundary covers limits (including stalled/repeated work),
    // invalid/unmet candidates and model/assessment errors. Control signals,
    // cancellation, permissions and infrastructure ownership loss are not
    // invitations to spend another model turn.
    if (!(error instanceof AppError) || error instanceof CompletionFailure
      || typeof error.details?.partialOutput === "string"
      || !["RUN_LIMIT_EXCEEDED", "STEP_NOT_COMPLETED", "MODEL_ERROR", "ASSESSMENT_ERROR"].includes(error.code)) throw error;
    const draft = messages.findLast((message) => message.role === "assistant" && !message.toolCalls?.length)?.content ?? "";
    throw await completionFailure(error, lastModelStep, draft, {
      approved: false,
      feedback: error.message,
    });
  }
}

function currentHardLimit(
  maxSteps: number,
  convergenceGraceSteps: number,
  candidateRepairGraceSteps: number,
  finalConvergenceGraceSteps = 0,
): number {
  return maxSteps + convergenceGraceSteps + candidateRepairGraceSteps + finalConvergenceGraceSteps;
}

function normalizeToolCallLimits(
  limits: AgentLoopOptions["toolCallLimits"],
): ReadonlyMap<string, number> {
  if (limits === undefined) return new Map();
  const normalized = new Map<string, number>();
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isFinite(limit) || limit < 0) continue;
    normalized.set(name, Math.floor(limit));
  }
  return normalized;
}

function countToolCallsByName(evidence: readonly AgentLoopToolEvidence[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of evidence) counts.set(item.toolName, (counts.get(item.toolName) ?? 0) + 1);
  return counts;
}

function countEarlyAdmittedToolCalls(outcomes: ReadonlyMap<string, ToolOutcome>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const outcome of outcomes.values()) {
    // An early quota rejection never reserved a call slot. Prepared calls do,
    // including a later prepare/operation failure, which matches late-batch
    // admission semantics.
    if (outcome.failurePhase === "runtime") continue;
    counts.set(outcome.call.name, (counts.get(outcome.call.name) ?? 0) + 1);
  }
  return counts;
}

function validateToolRecommendations(
  availableTools: readonly { readonly name: string }[],
  decision: StepExecutionDecision,
): void {
  const availableToolNames = new Set(availableTools.map((tool) => tool.name));
  const invalidToolNames = [
    ...decision.toolCatalog.availableToolNames,
    ...decision.toolCatalog.preferredToolNames,
  ].filter((name) => !availableToolNames.has(name));
  const omittedToolNames = [...availableToolNames].filter((name) => !decision.toolCatalog.availableToolNames.includes(name));
  if (invalidToolNames.length > 0 || omittedToolNames.length > 0) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Step execution strategy recommended tools outside the current capability grant",
      500,
      {
        strategyId: decision.strategyId,
        invalidToolNames: [...new Set(invalidToolNames)],
        omittedToolNames,
      },
    );
  }
}

function orderDefinitionsByPreference<T extends { readonly name: string }>(
  definitions: readonly T[],
  preferredToolNames: readonly string[],
): T[] {
  const preferredOrder = new Map(preferredToolNames.map((name, index) => [name, index]));
  return definitions
    .map((definition, index) => ({
      definition,
      index,
      preference: preferredOrder.get(definition.name),
    }))
    .sort((left, right) => {
      if (left.preference === undefined && right.preference === undefined) return left.index - right.index;
      if (left.preference === undefined) return 1;
      if (right.preference === undefined) return -1;
      return left.preference - right.preference;
    })
    .map(({ definition }) => definition);
}

async function shouldUseFinalConvergence(
  predicate: AgentLoopOptions["shouldUseFinalConvergence"],
  context: ToolStepConvergenceContext,
): Promise<boolean> {
  if (predicate === undefined) return true;
  return await predicate(context);
}

function deferredValidationOutput(output: string, feedback: string): string {
  const trimmedOutput = output.trim();
  const trimmedFeedback = feedback.trim();
  if (trimmedFeedback.length === 0 || trimmedOutput.includes(trimmedFeedback)) return trimmedOutput;
  if (trimmedOutput.length === 0) return trimmedFeedback;
  return `${trimmedOutput}\n\nDeferred validation note: ${trimmedFeedback}`;
}

function evidenceBoundaryOutput(output: string, feedback: string): string {
  const trimmedOutput = output.trim();
  const trimmedFeedback = feedback.trim();
  if (trimmedFeedback.length === 0 || trimmedOutput.includes(trimmedFeedback)) return trimmedOutput;
  if (trimmedOutput.length === 0) return trimmedFeedback;
  return `${trimmedOutput}\n\nEvidence boundary note: ${trimmedFeedback}`;
}

function repairLimitCompletionOutput(output: string, repairLimit: number): string {
  const trimmedOutput = output.trim();
  const caveat = `Repair caveat: the candidate was assessed again after ${repairLimit} repair attempt(s), but the remaining issue did not converge. The latest deliverable is accepted with this caveat instead of continuing the repair loop.`;
  return [trimmedOutput, caveat].filter((part) => part.length > 0).join("\n\n");
}

function removeRejectedAssistantCandidate(messages: ModelMessage[], candidate: ModelMessage): void {
  const last = messages[messages.length - 1];
  if (last !== candidate || last.role !== "assistant") return;
  if ((last.toolCalls?.length ?? 0) > 0) return;
  messages.pop();
}

function rejectedToolCallsEvidenceMessage(
  rejectedCalls: readonly ModelToolCall[],
  outcomes: readonly ToolOutcome[],
): string {
  const outcomeByCallId = new Map(outcomes.map((outcome) => [outcome.call.id, outcome]));
  const payload = JSON.stringify({
    schema: "agentloop.runtimeToolRejection/v1",
    kind: "tool_rejection",
    rejections: rejectedCalls.map((call) => ({
      toolCallId: call.id,
      toolName: call.name,
      reason: outcomeByCallId.get(call.id)?.content ?? "Tool call was rejected during prepare",
    })),
  }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
  return [
    '<runtime_evidence_record source="server" kind="tool_rejection" encoding="json">',
    payload,
    "</runtime_evidence_record>",
  ].join("\n");
}

function isInternalEvidenceMarkupCandidate(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return /<runtime_evidence_record\b/i.test(trimmed)
    || /"schema"\s*:\s*"agentloop\.(?:runtimeEvidenceRecord|serverEvidence)\/v1"/i.test(trimmed)
    || /\bSERVER-PROVIDED EVIDENCE\b/i.test(trimmed)
    // Provider reasoning delimiters and the Runtime's presentation-only tool
    // placeholders are never user-facing completion content. This is a
    // protocol boundary, not HTML sanitisation: ordinary requested HTML is
    // unaffected.
    || /<\/?think\b[^>]*>/i.test(trimmed)
    || /\btoolResultsOverride\b/i.test(trimmed);
}

async function evaluateToolStepConvergence(
  predicate: AgentLoopOptions["shouldConvergeAfterToolStep"],
  context: ToolStepConvergenceContext,
): Promise<ToolStepConvergenceDecision> {
  if (predicate === undefined) return { converge: false };
  const decision = await predicate(context);
  if (typeof decision === "boolean") return { converge: decision };
  return decision;
}

function selectStructuredToolCandidate(
  evidence: readonly AgentLoopToolEvidence[],
): StructuredToolCandidateSelection | undefined {
  const observations: StructuredToolCandidate[] = [];
  for (const item of evidence) {
    if (item.isError) continue;
    for (const record of candidateRecordsFromToolResult(item.result)) {
      const candidate = structuredCandidateFromRecord(record, item.toolCallId);
      if (candidate !== undefined) {
        // Command wrappers may expose the same structured stdout both nested
        // and top-level. One Tool call still represents one observation.
        observations.push(candidate);
        break;
      }
    }
  }
  if (observations.length === 0) return undefined;
  const mergedCandidate = mergeAppendableStructuredCandidates(observations);
  return {
    ...(observations.length === 1 ? { directCandidate: observations[0] }
      : mergedCandidate === undefined ? {} : { directCandidate: mergedCandidate }),
    observations,
  };
}

const STRUCTURED_CANDIDATE_BLOCKING_ARTIFACT_EVIDENCE_KINDS = new Set([
  "artifact_path",
  "artifact_non_empty",
  "artifact_acceptance",
  "artifact_openable",
  "format_matches_request",
]);

function evidenceCompletionCandidateHasAcceptedArtifact(
  policy: RuntimeToolProgressPolicy | undefined,
  evidence: readonly AgentLoopToolEvidence[],
): boolean {
  if (policy === undefined) return false;
  const evidenceState = deriveRuntimeStepEvidenceState({ policy, evidence });
  return evidenceState?.workProduct.acceptanceRequired === true
    && evidenceState.workProduct.status === "accepted";
}

function structuredCandidateIsBlockedByPendingArtifactEvidence(
  policy: RuntimeToolProgressPolicy | undefined,
  evidence: readonly AgentLoopToolEvidence[],
): boolean {
  if (policy === undefined) return false;
  const evidenceState = deriveRuntimeStepEvidenceState({ policy, evidence });
  return evidenceState?.missingToolEvidenceKinds.some((kind) =>
    STRUCTURED_CANDIDATE_BLOCKING_ARTIFACT_EVIDENCE_KINDS.has(kind)
  ) === true;
}

function candidateRecordsFromToolResult(result: string): ReadonlyArray<Record<string, unknown>> {
  const direct = parseJsonRecord(result);
  if (direct === undefined) return [];
  const records: Record<string, unknown>[] = [direct];
  if (
    "exitCode" in direct
    && direct.exitCode !== 0
    && direct.exitCode !== null
  ) {
    return records;
  }
  if (typeof direct.stdout === "string") {
    const stdout = parseJsonRecord(direct.stdout);
    if (stdout !== undefined) records.unshift(stdout);
  }
  return records;
}

function structuredCandidateFromRecord(
  record: Record<string, unknown>,
  sourceToolCallId: string,
): StructuredToolCandidate | undefined {
  const wrapperSchema = typeof record.schema === "string" ? record.schema : undefined;
  const sourceSchema = typeof record.sourceSchema === "string" ? record.sourceSchema : undefined;
  const schema = sourceSchema ?? wrapperSchema;
  const deliveryCandidate = isPlainRecord(record.deliveryCandidate) ? record.deliveryCandidate : undefined;
  const output = typeof deliveryCandidate?.output === "string"
    ? deliveryCandidate.output
    : (typeof record.delivery_markdown === "string" ? record.delivery_markdown : undefined);
  if (output === undefined || output.trim().length === 0) return undefined;
  const aggregation = structuredCandidateAggregation(deliveryCandidate?.aggregation);
  const userVisibleOutput = appendDeliveryCandidateCaveats(normalizeDeliveryCandidate({
    output,
    evidenceKinds: {
      satisfied: evidenceReceiptKinds(record, "satisfied"),
      caveated: evidenceReceiptKinds(record, "caveated"),
      failed: evidenceReceiptKinds(record, "failed"),
    },
    caveats: evidenceReceiptCaveats(record),
    sourceToolCallIds: [sourceToolCallId],
  }));
  const projectionSource = record.assessmentProjection
    ?? record.assessment_summary
    ?? {
      schema,
      sourceToolCallId,
      deliveryCharacters: userVisibleOutput.output.length,
    };
  return {
    deliveryCandidate: userVisibleOutput,
    projection: JSON.stringify({
      structuredToolCandidate: projectionSource,
      sourceToolCallId,
      ...(schema === undefined ? {} : { schema }),
      ...(sourceSchema === undefined ? {} : { sourceSchema }),
      ...(wrapperSchema === undefined || wrapperSchema === schema ? {} : { wrapperSchema }),
      deliveryCandidate: userVisibleOutput,
    }),
    observation: JSON.stringify({
      sourceToolCallId,
      ...(schema === undefined ? {} : { schema }),
      structuredObservation: projectionSource,
      deliveryCharacters: userVisibleOutput.output.length,
    }),
    sourceToolCallId,
    sourceToolCallIds: [sourceToolCallId],
    ...(schema === undefined ? {} : { schema }),
    ...(aggregation === undefined ? {} : { aggregation }),
  };
}

function structuredCandidateAggregation(value: unknown): StructuredCandidateAggregation | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (value.mergeStrategy !== "append_markdown") return undefined;
  const groupId = typeof value.groupId === "string" ? value.groupId.trim() : "";
  const partIndex = value.partIndex;
  const partCount = value.partCount;
  if (
    groupId.length === 0
    || typeof partIndex !== "number"
    || typeof partCount !== "number"
    || !Number.isSafeInteger(partIndex)
    || !Number.isSafeInteger(partCount)
    || partIndex < 1
    || partCount < 2
    || partIndex > partCount
  ) return undefined;
  return { groupId, partIndex, partCount, mergeStrategy: "append_markdown" };
}

function mergeAppendableStructuredCandidates(
  candidates: readonly StructuredToolCandidate[],
): StructuredToolCandidate | undefined {
  const aggregation = candidates[0]?.aggregation;
  if (aggregation === undefined || candidates.length !== aggregation.partCount) return undefined;
  if (!candidates.every((candidate) =>
    candidate.aggregation?.mergeStrategy === aggregation.mergeStrategy
    && candidate.aggregation.groupId === aggregation.groupId
    && candidate.aggregation.partCount === aggregation.partCount
  )) return undefined;
  const ordered = [...candidates].sort((left, right) =>
    (left.aggregation?.partIndex ?? 0) - (right.aggregation?.partIndex ?? 0),
  );
  if (!ordered.every((candidate, index) => candidate.aggregation?.partIndex === index + 1)) return undefined;
  const sourceToolCallIds = ordered.flatMap((candidate) => candidate.sourceToolCallIds);
  const schema = ordered.every((candidate) => candidate.schema === ordered[0]?.schema)
    ? ordered[0]?.schema
    : undefined;
  const deliveryCandidate = normalizeDeliveryCandidate({
    output: ordered.map((candidate) => candidate.deliveryCandidate.output).join("\n\n"),
    evidenceKinds: {
      satisfied: ordered.flatMap((candidate) => candidate.deliveryCandidate.evidenceKinds.satisfied),
      caveated: ordered.flatMap((candidate) => candidate.deliveryCandidate.evidenceKinds.caveated),
      failed: ordered.flatMap((candidate) => candidate.deliveryCandidate.evidenceKinds.failed),
    },
    caveats: ordered.flatMap((candidate) => candidate.deliveryCandidate.caveats),
    sourceToolCallIds,
  });
  return {
    deliveryCandidate,
    projection: JSON.stringify({
      structuredToolCandidates: ordered.map((candidate) => JSON.parse(candidate.projection)),
      aggregation,
      deliveryCandidate,
    }),
    observation: JSON.stringify({ aggregation, sourceToolCallIds, deliveryCharacters: deliveryCandidate.output.length }),
    sourceToolCallId: sourceToolCallIds[0]!,
    sourceToolCallIds,
    ...(schema === undefined ? {} : { schema }),
  };
}

function structuredObservationSynthesisDirective(
  observations: readonly StructuredToolCandidate[],
): string {
  return [
    "<runtime_structured_observation_synthesis>",
    "Multiple structured tool observations were produced for this same Plan step. They are evidence, not independent final answers.",
    "Synthesize one answer for the original user goal using every observation. Do not select the last tool result merely because it completed last.",
    "A zero-result observation applies only to its own query or scope. It cannot justify a global no-result conclusion while another observation has matching results.",
    "State differing query scopes and any unresolved conflict explicitly. Use the canonical tool results for exact fields; do not invent facts or emit tool calls on this synthesis turn.",
    "Observation summaries:",
    JSON.stringify(observations.map((candidate) => JSON.parse(candidate.observation))),
    "</runtime_structured_observation_synthesis>",
  ].join("\n");
}

function evidenceReceiptKinds(record: Record<string, unknown>, kind: "satisfied" | "caveated" | "failed"): string[] {
  const receipt = isPlainRecord(record.evidenceReceipt) ? record.evidenceReceipt : undefined;
  const kinds = isPlainRecord(receipt?.evidenceKinds) ? receipt.evidenceKinds : undefined;
  return Array.isArray(kinds?.[kind]) ? kinds[kind].filter((item): item is string => typeof item === "string") : [];
}

function evidenceReceiptCaveats(record: Record<string, unknown>): string[] {
  const receipt = isPlainRecord(record.evidenceReceipt) ? record.evidenceReceipt : undefined;
  return Array.isArray(receipt?.caveats)
    ? receipt.caveats.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0)
    : [];
}

function projectStructuredCandidateEvidence(
  evidence: readonly AgentLoopToolEvidence[],
  candidate: StructuredToolCandidate,
): readonly AgentLoopToolEvidence[] {
  return evidence.map((item) => {
    if (!candidate.sourceToolCallIds.includes(item.toolCallId)) return item;
    return {
      ...item,
      result: candidate.projection,
    };
  });
}

function executionFeedbackDirective(input: {
  readonly suppressLegacyWorkProductProjection?: boolean;
  readonly latestToolEvidence: readonly AgentLoopToolEvidence[];
  readonly toolEvidence: readonly AgentLoopToolEvidence[];
  readonly progressPolicy?: RuntimeToolProgressPolicy;
  readonly progressHint?: string;
}): string | undefined {
  if (input.latestToolEvidence.length === 0) return undefined;
  const stepEvidenceState = deriveRuntimeStepEvidenceState({
    policy: input.progressPolicy,
    evidence: input.toolEvidence,
  });
  const recentFailures = (input.suppressLegacyWorkProductProjection ? input.latestToolEvidence : input.toolEvidence)
    .filter((item) => item.isError);
  const lines = [
    "<runtime_execution_feedback>",
    "The previous tool step produced canonical execution results. Consume these results before choosing the next action.",
    "Choose the next action only when its expected marginal benefit materially improves an unmet current-step success criterion; otherwise submit a concise completion candidate with explicit caveats instead of extending the loop.",
    "If any tool failed, address the concrete failure cause or change strategy before continuing.",
    "If failures span multiple phases or repeat with new error text, stop replaying the same command shape and switch subgoal or tool family.",
    "If any command created or modified files, treat fileChanges paths as artifact facts. Normally avoid rereading just-written artifact content unless a validator, build, render, or acceptance diagnostic names a concrete missing field, line range, or contract.",
    "If a just-written artifact is known incomplete, prefer the next bounded file-producing patch. If it is complete but lacks required acceptance evidence, prefer the available acceptance or verification Tool.",
    "If required evidence is still missing, call the appropriate current-step tool to produce that evidence; do not submit completion from assumptions.",
    "Recent tool results:",
  ];
  if (stepEvidenceState !== undefined && input.suppressLegacyWorkProductProjection !== true) {
    if (stepEvidenceState.recentActionableDiagnostic) {
      lines.push(
        "A recent validator, build, render, parser, or acceptance result already named a concrete artifact diagnostic. Prefer patching, running, or verifying next; read only when it is needed to resolve that diagnostic.",
      );
    }
    if (stepEvidenceState.nextAction === "verify_existing_artifact") {
      lines.push(
        "A known artifact already exists, but required artifact acceptance is still missing. Prefer verification next; avoid rereading the same artifact solely to decide whether to verify it.",
      );
    }
    lines.push(
      "<runtime_step_semantic_state>",
      JSON.stringify(stepEvidenceState),
      "</runtime_step_semantic_state>",
    );
  }
  if (input.progressHint !== undefined && input.suppressLegacyWorkProductProjection !== true) {
    lines.push("<runtime_progress_hint>", input.progressHint, "</runtime_progress_hint>");
  }
  for (const item of input.latestToolEvidence.slice(-6)) {
    lines.push(`- ${summarizeToolEvidenceForDirective(item)}`);
  }
  if (recentFailures.length > 0) {
    lines.push("Recent failures by phase:");
    for (const item of recentFailures.slice(-4)) {
      lines.push(`- ${summarizeToolFailureForDirective(item)}`);
    }
    const distinctFailurePhases = [...new Set(recentFailures.map((item) => item.failurePhase ?? "unknown"))];
    if (distinctFailurePhases.length > 1) {
      lines.push("These failures span multiple phases. Do not keep replaying the same command shape; switch subgoal or tool family.");
    }
  }
  lines.push("</runtime_execution_feedback>");
  return lines.join("\n");
}

function summarizeToolEvidenceForDirective(item: AgentLoopToolEvidence): string {
  const parsed = parseJsonRecord(item.result);
  const details: string[] = [];
  let commandFailed = false;
  if (item.failurePhase !== undefined) details.push(`phase=${item.failurePhase}`);
  if (parsed !== undefined) {
    const exitCode = parsed.exitCode;
    if (typeof exitCode === "number" || exitCode === null) {
      details.push(`exitCode=${String(exitCode)}`);
      commandFailed = typeof exitCode === "number" && exitCode !== 0;
    }
    const fileChanges = summarizeFileChanges(parsed.fileChanges);
    if (fileChanges.length > 0) details.push(`fileChanges=${fileChanges.join(",")}`);
    const stdout = shortStringField(parsed, "stdout");
    if (stdout !== undefined) details.push(`stdout="${stdout}"`);
    const stderr = shortStringField(parsed, "stderr");
    if (stderr !== undefined) details.push(`stderr="${stderr}"`);
    const path = shortStringField(parsed, "path");
    if (path !== undefined) details.push(`path=${path}`);
  } else {
    details.push(`result="${truncateForDirective(item.result, 180)}"`);
  }
  if (details.length === 0) details.push(`result="${truncateForDirective(item.result, 180)}"`);
  return [
    item.isError || commandFailed ? "failed" : "succeeded",
    `toolCallId=${item.toolCallId}`,
    `tool=${item.toolName}`,
    details.join(" "),
  ].join(" ");
}

function summarizeToolFailureForDirective(item: AgentLoopToolEvidence): string {
  const phase = item.failurePhase === undefined ? "unknown" : item.failurePhase;
  const reason = truncateForDirective(item.result.replace(/\s+/g, " "), 160);
  return `phase=${phase} tool=${item.toolName} toolCallId=${item.toolCallId} reason="${reason}"`;
}

function summarizeFileChanges(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const changes: string[] = [];
  for (const change of value.slice(0, 8)) {
    if (!isPlainRecord(change)) continue;
    const path = typeof change.path === "string" ? change.path : undefined;
    const changeType = typeof change.changeType === "string" ? change.changeType : undefined;
    if (path === undefined || changeType === undefined) continue;
    changes.push(`${changeType}:${truncateForDirective(path, 80)}`);
  }
  if (value.length > changes.length) changes.push(`and_${value.length - changes.length}_more`);
  return changes;
}

function shortStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return truncateForDirective(trimmed.replace(/\s+/g, " "), 180);
}

function truncateForDirective(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return `${value.slice(0, Math.max(0, maxCharacters - 3))}...`;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface StreamingDispatchContext {
  readonly model: ModelAdapter;
  readonly invocation: ModelInvocation;
  readonly emit: RuntimeEventSink;
  readonly step: number;
  readonly signal: AbortSignal | undefined;
  readonly grant: CapabilityGrant;
  readonly prepare: (call: ModelToolCall) => PreparedToolCall;
  readonly maxToolResultCharacters: number;
  readonly maxParallelToolCalls: number;
  readonly actionTracker: AgentLoopOptions["actionTracker"];
  readonly toolCallLimits: ReadonlyMap<string, number>;
  readonly priorToolCallCounts: ReadonlyMap<string, number>;
  readonly allowEarlyDispatch: boolean;
}

/**
 * Prefer the model adapter's streaming path. As each tool call's arguments
 * complete (`tool_call_ready`), the call is durably committed through
 * `assistant.tool_call.committed` and, when no progress policy must admit the
 * whole tool batch first, dispatched through a bounded pool while the remainder
 * of the stream is still being consumed (OpenCode-style overlap).
 * Resolves to the same aggregated ModelResponse; the caller still emits the
 * full `assistant.committed` checkpoint after this resolves.
 */
async function completeWithStreamingAndDispatch(
  context: StreamingDispatchContext,
  earlyOutcomes: Map<string, ToolOutcome>,
): Promise<ModelResponse> {
  const limiter = createConcurrencyLimiter(Math.max(1, context.maxParallelToolCalls));
  const dispatches: Array<Promise<void>> = [];
  const readyCalls = new Map<string, ModelToolCall>();
  const earlyAdmittedCalls = new Map<string, number>();

  const dispatchEarly = (call: ModelToolCall): void => {
    const limit = context.toolCallLimits.get(call.name);
    const priorCalls = context.priorToolCallCounts.get(call.name) ?? 0;
    const admittedCalls = earlyAdmittedCalls.get(call.name) ?? 0;
    if (limit !== undefined && priorCalls + admittedCalls >= limit) {
      const message = `Tool call limit reached for ${call.name}: at most ${limit} call(s) are allowed for this Plan step`;
      dispatches.push((async () => {
        await context.emit({
          type: "tool.rejected",
          data: {
            step: context.step,
            toolCallId: call.id,
            toolName: call.name,
            reason: message,
            invocationStatus: "rejected",
            operationStatus: "unknown",
            isError: true,
            failurePhase: "runtime",
          },
        });
        earlyOutcomes.set(call.id, {
          call,
          content: message,
          invocationStatus: "rejected",
          operationStatus: "unknown",
          isError: true,
          failurePhase: "runtime",
        });
      })());
      return;
    }
    earlyAdmittedCalls.set(call.name, admittedCalls + 1);
    dispatches.push((async () => {
      await limiter.acquire();
      try {
        let entry: PreparedEntry;
        try {
          const value = context.prepare(call);
          await context.emit({
            type: "tool.planned",
            data: {
              step: context.step,
              toolCallId: call.id,
              toolName: call.name,
              arguments: call.arguments,
              replaySafe: value.tool.replaySafe,
            },
          });
          entry = { kind: "ready", value };
        } catch (error) {
          const message = publicErrorMessage(error);
          await context.emit({
            type: "tool.rejected",
            data: {
              step: context.step,
              toolCallId: call.id,
              toolName: call.name,
              reason: message,
              invocationStatus: "rejected",
              operationStatus: "unknown",
              isError: true,
              failurePhase: "prepare",
            },
          });
          entry = { kind: "rejected", call, message };
        }
        const outcome = await executePrepared(
          entry,
          context.grant,
          context.step,
          context.emit,
          context.signal,
          context.maxToolResultCharacters,
          context.actionTracker,
        );
        earlyOutcomes.set(call.id, outcome);
      } finally {
        limiter.release();
      }
    })());
  };

  let response: ModelResponse;
  try {
    response = await completeWithStreaming({
      model: context.model,
      invocation: context.invocation,
      emit: context.emit,
      signal: context.signal,
      base: { phase: "execution", step: context.step },
      onToolCallReady: async (call) => {
        // When the turn was dispatched without tools (convergence) any tool call is
        // model misbehaviour and is never executed, so skip both commit and dispatch.
        if (context.invocation.tools.length === 0 || readyCalls.has(call.id)) return;
        readyCalls.set(call.id, call);
        await context.emit({
          type: "assistant.tool_call.committed",
          data: {
            step: context.step,
            toolCallId: call.id,
            name: call.name,
            arguments: call.arguments,
          },
        });
        await context.emit({
          type: "model.stream.awaiting_completion",
          data: {
            phase: "execution",
            step: context.step,
            toolCallId: call.id,
            toolName: call.name,
          },
        });
        if (!context.allowEarlyDispatch) return;
        dispatchEarly(call);
      },
    });
  } catch (error) {
    await Promise.all(dispatches);
    const recoveredCalls = [...readyCalls.values()].filter((call) => earlyOutcomes.get(call.id)?.failurePhase !== "prepare");
    if (!isRecoverableToolReadyStreamAbort(error) || recoveredCalls.length === 0) throw error;
    await context.emit({
      type: "model.stream.tool_ready_recovered",
      data: {
        phase: "execution",
        step: context.step,
        toolCallIds: recoveredCalls.map((call) => call.id),
        reason: "stream_idle_timeout",
      },
    });
    return { content: "", finishReason: "tool_calls", toolCalls: recoveredCalls };
  }

  await Promise.all(dispatches);
  return response;
}

function isRecoverableToolReadyStreamAbort(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== "MODEL_ERROR") return false;
  const reason = error.details?.abortReason;
  return reason === "stream_idle_timeout" || reason === "stream_wall_timeout";
}

async function executePreparedSchedule(
  entries: readonly PreparedEntry[],
  grant: CapabilityGrant,
  step: number,
  emit: RuntimeEventSink,
  signal: AbortSignal | undefined,
  maxCharacters: number,
  concurrency: number,
  actionTracker: AgentLoopOptions["actionTracker"],
): Promise<ToolOutcome[]> {
  const outcomes: ToolOutcome[] = [];
  let next = 0;
  while (next < entries.length) {
    const first = entries[next];
    if (first.kind === "ready" && first.value.tool.executionMode === "exclusive") {
      outcomes.push(await executePrepared(first, grant, step, emit, signal, maxCharacters, actionTracker));
      next += 1;
      continue;
    }
    const group: PreparedEntry[] = [];
    while (next < entries.length) {
      const entry = entries[next];
      if (group.length > 0 && entry.kind === "ready" && entry.value.tool.executionMode === "exclusive") break;
      if (group.length === 0 && entry.kind === "ready" && entry.value.tool.executionMode === "exclusive") break;
      group.push(entry);
      next += 1;
    }
    outcomes.push(...await mapWithConcurrencyLimit(group, concurrency, (entry) =>
      executePrepared(entry, grant, step, emit, signal, maxCharacters, actionTracker)
    ));
  }
  return outcomes;
}

async function executePrepared(
  entry: PreparedEntry,
  grant: CapabilityGrant,
  step: number,
  emit: RuntimeEventSink,
  signal: AbortSignal | undefined,
  maxCharacters: number,
  actionTracker: AgentLoopOptions["actionTracker"],
): Promise<ToolOutcome> {
  if (entry.kind === "rejected") {
    return {
      call: entry.call,
      content: entry.message,
      invocationStatus: "rejected",
      operationStatus: "unknown",
      isError: true,
      failurePhase: "prepare",
    };
  }
  const { call, tool, input } = entry.value;
  try {
    throwIfAborted(signal);
    // This is the observable side-effect boundary. The Tool still only
    // produces facts; Runtime action tracking owns dispatch and commit state.
    await emit({
      type: "tool.effect_pending",
      data: { step, toolCallId: call.id, toolName: call.name, replaySafe: tool.replaySafe },
    });
    await emit({
      type: "tool.dispatched",
      data: { step, toolCallId: call.id, toolName: call.name, replaySafe: tool.replaySafe },
    });
    const execute = async (): Promise<unknown> => entry.value.execute({ grant, signal });
    const tracked = actionTracker === undefined
      ? { value: await execute() }
      : await actionTracker.executeToolCall({
        step,
        toolCallId: call.id,
        toolName: call.name,
        replaySafe: tool.replaySafe,
        publishesRuntimeResult: tool.publishesRuntimeResult !== false,
        timeoutMs: tool.timeoutMs,
      }, execute);
    const value = tracked.value;
    const operationOutcome = classifyToolOperationOutcome(value);
    const canonicalContent = serializeToolResult(value, tool.maxResultCharacters ?? maxCharacters);
    const content = serializeToolResult(value, tool.maxResultCharacters ?? maxCharacters, tracked.resultRef);
    const operationFailed = operationOutcome.status === "failed";
    const metrics = toolEvidenceMetrics(call.name, canonicalContent);
    await emit({
      type: "tool.result_committed",
      data: {
        step,
        toolCallId: call.id,
        toolName: call.name,
        invocationStatus: "completed",
        operationStatus: operationOutcome.status,
        ...(operationOutcome.exitCode === undefined ? {} : { exitCode: operationOutcome.exitCode }),
        isError: operationFailed,
        ...(operationFailed ? { failurePhase: "operation" } : {}),
        ...toolResultCommitSummary(canonicalContent),
        ...(tracked.resultRef === undefined ? {} : { resultRef: tracked.resultRef }),
        ...metrics,
      },
    });
    await emit({
      type: "tool.completed",
      data: {
        step,
        toolCallId: call.id,
        toolName: call.name,
        result: canonicalContent,
        ...(tracked.resultRef === undefined ? {} : { resultRef: tracked.resultRef }),
        invocationStatus: "completed",
        operationStatus: operationOutcome.status,
        ...(operationOutcome.exitCode === undefined ? {} : { exitCode: operationOutcome.exitCode }),
        isError: operationFailed,
        ...(operationFailed ? { failurePhase: "operation" } : {}),
        ...metrics,
      },
    });
    return {
      call,
      content,
      invocationStatus: "completed",
      operationStatus: operationOutcome.status,
      ...(operationOutcome.exitCode === undefined ? {} : { exitCode: operationOutcome.exitCode }),
      isError: operationFailed,
      ...(operationFailed ? { failurePhase: "operation" as const } : {}),
      ...(tracked.resultRef === undefined ? {} : { resultRef: tracked.resultRef }),
    };
  } catch (error) {
    const content = publicErrorMessage(error);
    await emit({
      type: "tool.failed",
      data: {
        step,
        toolCallId: call.id,
        toolName: call.name,
        error: content,
        invocationStatus: "failed",
        operationStatus: "unknown",
        isError: true,
        failurePhase: "execute",
      },
    });
    return {
      call,
      content,
      invocationStatus: "failed",
      operationStatus: "unknown",
      isError: true,
      failurePhase: "execute",
    };
  }
}

function skillNameFromArguments(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" ? name : undefined;
}

function collectActivatedSkillNames(
  messages: readonly ModelMessage[],
  availableSkills: ReadonlyMap<string, { readonly name: string }>,
): readonly string[] {
  const calls = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (call.name !== "load_skill") continue;
      const name = skillNameFromArguments(call.arguments);
      if (name !== undefined) calls.set(call.id, name);
    }
  }
  const activated = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || message.name !== "load_skill" || message.isError) continue;
    const name = calls.get(message.toolCallId);
    const skill = name === undefined ? undefined : availableSkills.get(name);
    if (skill !== undefined) activated.add(skill.name);
  }
  return [...activated];
}

function allPrepareRejectionSignature(outcomes: readonly ToolOutcome[]): string | undefined {
  if (
    outcomes.length === 0
    || outcomes.some((outcome) => !outcome.isError || outcome.failurePhase !== "prepare")
  ) {
    return undefined;
  }
  return outcomes
    .map((outcome) => {
      const serialized = typeof outcome.call.arguments === "string"
        ? outcome.call.arguments
        : JSON.stringify(outcome.call.arguments) ?? "";
      return [
        outcome.call.name,
        createHash("sha256").update(serialized).digest("hex"),
        createHash("sha256").update(outcome.content).digest("hex"),
      ].join("#");
    })
    .sort()
    .join("|");
}

function prepareRejectionRepairDirective(input: {
  readonly outcomes: readonly ToolOutcome[];
  readonly repeated: boolean;
}): string {
  const failures = input.outcomes
    .map((outcome) => `- ${outcome.call.name}: ${outcome.content}`)
    .join("\n");
  return [
    "<runtime_tool_argument_repair>",
    input.repeated
      ? "The model repeated tool calls whose arguments failed validation before any Tool executed. Do not repeat the same arguments again."
      : "The previous tool calls failed validation before any Tool executed.",
    "Repair the tool-call arguments according to the exact Tool schema now exposed on this turn.",
    "For a message that says `mode and overwrite cannot both be set`, choose exactly one of those fields; prefer `mode` and remove the legacy `overwrite` field.",
    "If the same validation failure repeats, the Runtime will stop the step as no progress instead of spending more turns.",
    failures,
    "</runtime_tool_argument_repair>",
  ].join("\n");
}

function invalidHumanLoopRepairDirective(reason: string): string {
  return [
    "<runtime_human_loop_repair>",
    "The previous request_human_loop call was rejected before execution, so no durable user request exists.",
    "This Step remains blocked on Human-in-the-Loop input. Do not create an artifact, write files, claim completion, or replace the user choice with a default.",
    "On this turn, submit exactly one request_human_loop call with one complete JSON object, not a JSON-encoded string.",
    "For responseSchema.type=select, include type, minSelections, maxSelections, and options only. Each option needs id and label; descriptions must be ordinary JSON strings with correctly escaped quotes.",
    "Use resume.mode=continue_step unless the admitted Step explicitly requires a different mode.",
    `Previous validation failure: ${reason}`,
    "</runtime_human_loop_repair>",
  ].join("\n");
}

function candidateRepairDirective(evaluation: CandidateCompletionEvaluation, fallback: string): string {
  const feedback = evaluation.feedback || fallback;
  const lines = [
    "<runtime_candidate_repair>",
    feedback,
    "Repair only the current admitted Plan step described in runtime context.",
    "The rejected completion candidate was internal Runtime material, not a user-visible assistant answer. Return a complete standalone replacement now.",
    "Do not refer to an earlier answer, previous message, prior candidate, or already delivered result as the final answer.",
    "Do not start pending downstream Plan steps, load downstream Skills, or produce downstream artifacts unless the current step objective explicitly requires the same work.",
    "Use only the tools exposed on the current turn; if no tools are exposed, return a bounded candidate from existing canonical evidence and state any unmet evidence truthfully.",
    "Tool success, model prose, and artifact text are not completion; the assessor and Terminal Committer remain authoritative.",
  ];
  if (evaluation.assessmentReused === true) {
    lines.push(
      "The exact completion candidate was already assessed against the same evidence. Do not resubmit it; gather new evidence with current-step tools or provide a materially changed candidate.",
    );
  }
  if (evaluation.requiresEvidenceProgress === true) {
    lines.push(
      "The holistic assessment found a substantive gap. Before submitting another candidate, take one current-step tool action that can add material evidence; rewriting the answer alone will be rejected.",
    );
  }
  if (evaluation.failedBoundary !== undefined) {
    const { missingEvidenceKinds, violatedSkillRequirements, reusableEvidenceRefs, suggestedRepairShape } = evaluation.failedBoundary;
    if (missingEvidenceKinds.length > 0) {
      lines.push(`Required completion evidence still missing: ${missingEvidenceKinds.join(", ")}.`);
      if (missingEvidenceKinds.includes("source_summary") && !missingEvidenceKinds.includes("source_urls")) {
        lines.push(
          "Source discovery already produced traceable references. Advance the task by reading one or more of the highest-relevance available sources with a current source-content Tool (for example webfetch); do not resubmit another discovery-only summary.",
          "Official or first-party sources are not required unless the admitted Plan explicitly uses strict_fail_on_missing_source. Prefer the strongest accessible relevant source and preserve caveats for anything still unverified.",
        );
      }
    }
    if (violatedSkillRequirements.length > 0) {
      lines.push(`Unmet Skill requirements: ${violatedSkillRequirements.join(", ")}.`);
    }
    if (reusableEvidenceRefs.length > 0) {
      lines.push(`Reuse or inspect these canonical evidence references before repeating work: ${reusableEvidenceRefs.join(", ")}.`);
    }
    if (suggestedRepairShape === "revise_plan") {
      lines.push("The recorded evidence shape does not match this Plan boundary; do not claim completion from it. Let Runtime route the failure to Plan revision.");
    }
  }
  lines.push("</runtime_candidate_repair>");
  return lines.join("\n");
}

function lengthTruncationRepairDirective(input: {
  readonly feedback: string;
  readonly convergenceOnly: boolean;
  readonly toolAvailable: boolean;
}): string {
  if (input.convergenceOnly || !input.toolAvailable) {
    return [
      input.feedback,
      "Return a complete, shorter completion candidate using the available evidence.",
      "Do not request or emit tool calls.",
    ].join("\n");
  }
  return [
    input.feedback,
    "The previous execution turn spent its output budget before producing an accepted candidate or executable Tool call.",
    "Do not continue long reasoning, restate source material, or draft large artifacts in assistant prose.",
    "Use the current Plan step and canonical evidence to take one bounded forward action.",
    "If the requested artifact is incomplete, call a file-producing Tool with the next bounded chunk or a purpose-built materialization Tool.",
    "If the artifact appears complete but lacks acceptance evidence, call the available acceptance or verification Tool.",
    "Use read-only Tools only for one specifically missing fact that is not already available from recent evidence.",
  ].join("\n");
}

function humanLoopRequirementFromEvidence(evidence: readonly AgentLoopToolEvidence[]): { toolCallId: string; requirement: Record<string, unknown> } | undefined {
  for (const item of evidence) {
    if (item.isError) continue;
    const parsed = parseJsonRecord(item.result);
    if (parsed === undefined) continue;

    // The explicit Runtime HIL Tool publishes a top-level, schema-tagged
    // signal. Do not treat arbitrary Tool JSON as a pause request.
    const direct = parsed.schema === "agentloop.humanLoopRequirement/v1"
      ? createHumanLoopControlSignal(parsed.humanLoopRequirement)
      : undefined;
    if (direct !== undefined) return { toolCallId: item.toolCallId, requirement: direct.requirement as unknown as Record<string, unknown> };

    // Command stdout can carry a signal only after Computer has validated it
    // and projected it from an immutable, registered Skill command root. In
    // particular, never inspect computer_read_file.content: user files are
    // content, not Runtime control-plane input.
    if (item.toolName !== "computer_run_command" || typeof parsed.stdout !== "string") continue;
    const projection = parseJsonRecord(parsed.stdout);
    if (projection?.schema !== "agentloop.commandOutputProjection/v1" || projection.stream !== "stdout") continue;
    const commandSignal = firstHumanLoopControlSignal(projection.controlSignals);
    if (commandSignal !== undefined) return { toolCallId: item.toolCallId, requirement: commandSignal.requirement as unknown as Record<string, unknown> };
  }
  return undefined;
}

function toolEvidenceMetrics(toolName: string, content: string): Record<string, unknown> {
  const parsed = parseJsonRecord(content);
  if (parsed === undefined) return {};
  const receipt = isPlainRecord(parsed.evidenceReceipt) ? parsed.evidenceReceipt : undefined;
  const sourceRefs = Array.isArray(receipt?.sourceRefs) ? receipt.sourceRefs : [];
  const facts = Array.isArray(receipt?.facts) ? receipt.facts : [];
  const sourceCharactersRead = sumSourceRefCharacters(sourceRefs);
  return {
    ...(receipt === undefined ? {} : {
      evidenceReceiptSchema: typeof receipt.schema === "string" ? receipt.schema : undefined,
      evidenceReceiptId: typeof receipt.receiptId === "string" ? receipt.receiptId : undefined,
      evidenceSourceType: typeof receipt.sourceType === "string" ? receipt.sourceType : undefined,
      sourceRefCount: sourceRefs.length,
      factCount: facts.length,
    }),
    ...(isSourceContentReadToolName(toolName) ? {
      sourceReadCount: sourceReadCountFromResult(parsed, sourceRefs),
      sourceBatchReadCount: toolName === "visible_read_files" ? sourceReadCountFromResult(parsed, sourceRefs) : undefined,
      sourceCharactersRead,
    } : {}),
    ...(isSourceDiscoveryToolName(toolName) ? {
      discoveredSourceCount: discoveredSourceCountFromResult(parsed, sourceRefs),
    } : {}),
  };
}

function toolResultCommitSummary(content: string): Record<string, unknown> {
  return {
    resultCharacters: content.length,
    resultSha256: createHash("sha256").update(content).digest("hex"),
    resultPreview: content.length <= 512 ? content : content.slice(0, 512),
    resultPreviewTruncated: content.length > 512,
  };
}

function sourceAcquisitionMetrics(evidence: readonly AgentLoopToolEvidence[]): Record<string, number> {
  const seen = new Set<string>();
  let sourceReadCount = 0;
  let repeatedSourceReadCount = 0;
  let batchCount = 0;
  let sourceCharactersRead = 0;
  let discoveredSourceCount = 0;
  let sourceSummaryReceiptCount = 0;
  for (const item of evidence) {
    if (item.isError) continue;
    const parsed = parseJsonRecord(item.result);
    if (parsed === undefined) continue;
    const receipt = isPlainRecord(parsed.evidenceReceipt) ? parsed.evidenceReceipt : undefined;
    const sourceRefs = Array.isArray(receipt?.sourceRefs) ? receipt.sourceRefs : [];
    const facts = Array.isArray(receipt?.facts) ? receipt.facts : [];
    if (facts.some((fact) => isPlainRecord(fact) && fact.kind === "source_summary")) {
      sourceSummaryReceiptCount += 1;
    }
    if (isSourceDiscoveryToolName(item.toolName)) {
      discoveredSourceCount = Math.max(discoveredSourceCount, discoveredSourceCountFromResult(parsed, sourceRefs));
    }
    if (!isSourceContentReadToolName(item.toolName)) continue;
    const keys = sourceKeysFromResult(parsed, sourceRefs);
    const fallbackReadCount = sourceReadCountFromResult(parsed, sourceRefs);
    if (item.toolName === "visible_read_files" || keys.length > 1 || fallbackReadCount > 1) {
      batchCount += 1;
    }
    sourceCharactersRead += sumSourceRefCharacters(sourceRefs);
    if (keys.length === 0) {
      sourceReadCount += fallbackReadCount;
      continue;
    }
    for (const key of keys) {
      sourceReadCount += 1;
      if (seen.has(key)) {
        repeatedSourceReadCount += 1;
      } else {
        seen.add(key);
      }
    }
  }
  return {
    toolResultCount: evidence.length,
    discoveredSourceCount,
    sourceReadCount,
    uniqueSourceReadCount: seen.size === 0 ? sourceReadCount : seen.size,
    repeatedSourceReadCount,
    batchCount,
    sourceCharactersRead,
    sourceSummaryReceiptCount,
  };
}

function isSourceContentReadToolName(name: string): boolean {
  return name === "webfetch"
    || name === "visible_read_file"
    || name === "visible_read_files"
    || /(?:^|_)read_(?:file|files|source|sources)(?:_|$)/i.test(name);
}

function isSourceDiscoveryToolName(name: string): boolean {
  return name === "websearch"
    || name === "visible_find_files"
    || name === "visible_index_directory"
    || name === "visible_search_text"
    || name === "visible_list_directory"
    || /(?:^|_)(?:find|index|search|list|query)(?:_|$)/i.test(name);
}

function sourceReadCountFromResult(parsed: Record<string, unknown>, sourceRefs: readonly unknown[]): number {
  return Math.max(
    integerValue(parsed.returned) ?? 0,
    Array.isArray(parsed.files) ? parsed.files.length : 0,
    sourceRefs.length,
    1,
  );
}

function discoveredSourceCountFromResult(parsed: Record<string, unknown>, sourceRefs: readonly unknown[]): number {
  return Math.max(
    integerValue(parsed.totalMatches) ?? 0,
    integerValue(parsed.returnedMatches) ?? 0,
    integerValue(parsed.returned) ?? 0,
    sourceRefs.length,
  );
}

function sourceKeysFromResult(parsed: Record<string, unknown>, sourceRefs: readonly unknown[]): string[] {
  const keys = sourceRefs.flatMap((ref) => {
    if (!isPlainRecord(ref)) return [];
    const sourceRefId = typeof ref.sourceRefId === "string" ? ref.sourceRefId : undefined;
    const rootId = typeof ref.rootId === "string" ? ref.rootId : "";
    const path = typeof ref.path === "string" ? ref.path : undefined;
    const url = typeof ref.url === "string" ? ref.url : undefined;
    if (sourceRefId !== undefined) return [sourceRefId];
    if (path !== undefined && path.trim().length > 0) return [`${rootId}:${path}`];
    if (url !== undefined && url.trim().length > 0) return [`url:${url}`];
    return [];
  });
  if (keys.length > 0) return [...new Set(keys)];
  const path = typeof parsed.path === "string" ? parsed.path : undefined;
  return path === undefined ? [] : [path];
}

function sumSourceRefCharacters(sourceRefs: readonly unknown[]): number {
  return sourceRefs.reduce<number>((sum, ref) => {
    if (!isPlainRecord(ref)) return sum;
    return sum + (integerValue(ref.characters) ?? 0);
  }, 0);
}

function integerValue(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function serializeToolResult(value: unknown, maximum: number, resultRef?: RuntimeResultRef): string {
  const visibleValue = resultRef === undefined
    ? value
    : isPlainRecord(value)
      ? { ...value, resultRef }
      : typeof value === "string"
        ? `${value}\n\n[Runtime ResultRef ${JSON.stringify(resultRef)}]`
        : { schema: "agentloop.resultEnvelope/v1", resultRef, value };
  let serialized: string;
  try {
    serialized = typeof visibleValue === "string" ? visibleValue : JSON.stringify(visibleValue);
  } catch {
    serialized = "Tool returned a value that could not be serialized";
  }
  if (serialized === undefined) serialized = "null";
  if (serialized.length <= maximum) return serialized;
  const compact = compactOversizedStructuredToolResult(visibleValue, serialized);
  if (compact !== undefined && compact.length <= maximum) return compact;
  const omitted = serialized.length - maximum;
  const digest = createHash("sha256").update(serialized).digest("hex");
  const refMarker = resultRef === undefined ? "" : `\n[Runtime ResultRef ${JSON.stringify(resultRef)}]`;
  const headCharacters = Math.max(0, maximum - refMarker.length);
  return `${serialized.slice(0, headCharacters)}${refMarker}\n[truncated ${omitted} characters; sha256=${digest}]`;
}

function compactOversizedStructuredToolResult(value: unknown, serialized: string): string | undefined {
  if (!isPlainRecord(value)) return undefined;
  const evidenceReceipt = isPlainRecord(value.evidenceReceipt) ? value.evidenceReceipt : undefined;
  const artifactReceipt = isPlainRecord(value.artifactReceipt) ? value.artifactReceipt : undefined;
  if (evidenceReceipt === undefined && artifactReceipt === undefined) return undefined;
  const digest = createHash("sha256").update(serialized).digest("hex");
  const compact: Record<string, unknown> = {
    schema: typeof value.schema === "string" ? value.schema : undefined,
    rootId: typeof value.rootId === "string" ? value.rootId : undefined,
    path: typeof value.path === "string" ? value.path : undefined,
    requested: value.requested,
    returned: value.returned,
    totalRows: value.totalRows,
    totalRecords: value.totalRecords,
    totalCells: value.totalCells,
    truncated: value.truncated,
    sha256: value.sha256,
    artifact: isPlainRecord(value.artifact) ? value.artifact : undefined,
    caveats: Array.isArray(value.caveats) ? value.caveats : undefined,
    evidenceReceipt,
    artifactReceipt,
    contentLocation: value.contentLocation,
    contentSummary: value.contentSummary,
    stdoutRef: value.stdoutRef,
    stderrRef: value.stderrRef,
    resultRef: value.resultRef,
    omittedToolResult: {
      reason: "large_tool_result_receipt_preserved",
      originalCharacters: serialized.length,
      sha256: digest,
    },
  };
  return JSON.stringify(omitUndefinedRecord(compact));
}

function omitUndefinedRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${error.message}`;
  if (error instanceof Error && error.name === "AbortError") return "CANCELLED: Operation was cancelled";
  return "INTERNAL_ERROR: Tool execution failed";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AppError("CANCELLED", "Run was cancelled", 409);
  }
}
