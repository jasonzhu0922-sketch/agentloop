import { createHash } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import { ContextAssembler, type ContextPolicy } from "./context-assembler.ts";
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
} from "./contracts.ts";
import type { PreparedToolCall } from "./tool-registry.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { completeWithStreaming } from "./model-streaming.ts";
import { isTextToolInvocation } from "./text-tool-invocation.ts";

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
  /** Additional tool-enabled steps allowed only after an assessor rejects a completion candidate. */
  readonly candidateRepairGraceSteps?: number;
  /** Rejected assessed candidates allowed before accepting the latest non-empty output with a caveat. */
  readonly candidateRepairAssessmentLimit?: number;
  readonly maxToolResultCharacters?: number;
  readonly maxParallelToolCalls?: number;
  readonly contextPolicy?: ContextPolicy;
  readonly shouldConvergeAfterToolStep?: (
    context: ToolStepConvergenceContext,
  ) => boolean | ToolStepConvergenceDecision | Promise<boolean | ToolStepConvergenceDecision>;
  readonly signal?: AbortSignal;
  readonly emit?: RuntimeEventSink;
  readonly actionTracker?: {
    executeToolCall<T>(input: {
      step: number;
      toolCallId: string;
      toolName: string;
      replaySafe: boolean;
      timeoutMs?: number;
    }, operation: () => Promise<T>): Promise<T>;
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
  readonly isError: boolean;
}

interface StructuredToolCandidate {
  readonly output: string;
  readonly projection: string;
  readonly sourceToolCallId: string;
  readonly schema?: string;
}

// Execution turns often need more room than planning because the assistant may
// need to carry the full skill workflow plus the actual deliverable candidate.
// A single large `computer_write_file` (e.g. a render script) must fit inside
// one turn's output budget, so this matches the Provider's maxOutputTokens.
const MODEL_STEP_MAX_OUTPUT_TOKENS = 16_384;
const CONVERGENCE_MAX_OUTPUT_TOKENS = 768;
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

const DEFAULT_CANDIDATE_REPAIR_ASSESSMENT_LIMIT = 2;

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const emit = async (event: RuntimeEvent): Promise<void> => {
    await options.emit?.(event);
  };
  const maxToolResultCharacters = options.maxToolResultCharacters ?? 50_000;
  const maxParallelToolCalls = options.maxParallelToolCalls ?? 4;
  const graceSteps = Math.max(0, options.convergenceGraceSteps ?? DEFAULT_CONVERGENCE_GRACE_STEPS);
  const candidateRepairGraceSteps = Math.max(0, options.candidateRepairGraceSteps ?? 0);
  const candidateRepairAssessmentLimit = Math.max(
    0,
    options.candidateRepairAssessmentLimit ?? DEFAULT_CANDIDATE_REPAIR_ASSESSMENT_LIMIT,
  );
  let grantedCandidateRepairGraceSteps = 0;
  let rejectedCandidateAssessments = 0;
  const messages: ModelMessage[] = [
    ...(options.conversationHistory ?? []),
    ...(options.initialMessages === undefined
      ? [{ role: "user", content: options.input }]
      : options.initialMessages),
  ];
  const toolEvidence: AgentLoopToolEvidence[] = [...(options.initialToolEvidence ?? [])];
  const availableSkills = new Map((options.availableSkills ?? []).map((skill) => [skill.name, skill]));
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
  if (availableSkills.size > 0) {
    await emit({
      type: "skill.activation.available",
      data: {
        skills: [...availableSkills.values()].map((skill) => ({
          id: skill.id,
          name: skill.name,
          contentHash: skill.contentHash,
        })),
      },
    });
  }

  let convergenceRequested = false;
  let previousToolSignature: string | undefined;
  let stalled = false;
  let requestedConvergenceReason: string | undefined;
  const evaluateCandidate = async (
    step: number,
    context: CandidateCompletionContext,
  ): Promise<CandidateCompletionEvaluation> => {
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
    return evaluation;
  };
  for (let step = 1; step <= currentHardLimit(options.maxSteps, graceSteps, grantedCandidateRepairGraceSteps); step += 1) {
    throwIfAborted(options.signal);
    const inGrace = step > options.maxSteps;
    const hardLimit = currentHardLimit(options.maxSteps, graceSteps, grantedCandidateRepairGraceSteps);
    const convergenceOnly = toolEvidence.length > 0
      && (requestedConvergenceReason !== undefined || step === hardLimit);
    if (convergenceOnly) {
      convergenceRequested = true;
      contextAssembler.setRuntimeDirective(CONVERGENCE_PROMPT);
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
    const materialized = options.tools.materialize(options.grant);
    let assembly = await contextAssembler.assemble(messages, convergenceOnly ? [] : materialized.definitions, options.signal);

    let earlyOutcomes = new Map<string, ToolOutcome>();
    let response: ModelResponse | undefined;
    for (let candidateAttempt = 1; candidateAttempt <= EMPTY_CANDIDATE_REPAIR_ATTEMPTS; candidateAttempt += 1) {
      const invocation: ModelInvocation = {
        runId: options.runId,
        systemPrompt: options.systemPrompt,
        phase: "execution",
        runtimeContext: assembly.runtimeContext,
        messages: assembly.messages,
        tools: convergenceOnly ? [] : materialized.definitions,
        ...(convergenceOnly || materialized.definitions.length === 0
          ? {}
          : { toolChoice: "auto" as const }),
        maxOutputTokens: Math.min(
          convergenceOnly ? CONVERGENCE_MAX_OUTPUT_TOKENS : MODEL_STEP_MAX_OUTPUT_TOKENS,
          options.model.limits.maxOutputTokens,
        ),
      };
      earlyOutcomes = new Map<string, ToolOutcome>();
      response = await completeWithStreamingAndDispatch({
        model: options.model,
        invocation,
        emit,
        step,
        signal: options.signal,
        grant: options.grant,
        prepare: (call) => materialized.prepare(call),
        maxToolResultCharacters,
        maxParallelToolCalls,
        actionTracker: options.actionTracker,
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
          convergenceOnly ? [] : materialized.definitions,
          options.signal,
        );
        continue;
      }
      break;
    }
    if (response === undefined) throw new AppError("MODEL_ERROR", "Model did not produce a response", 502);
    const assistantMessage: ModelMessage = {
      role: "assistant",
      content: response.content,
      ...(response.toolCalls.length === 0 ? {} : { toolCalls: response.toolCalls }),
      ...(response.reasoningContent === undefined ? {} : { reasoningContent: response.reasoningContent }),
    };
    messages.push(assistantMessage);

    // This awaited event is the durable checkpoint before any external effect.
    await emit({
      type: "assistant.committed",
      data: {
        step,
        content: response.content,
        finishReason: response.finishReason,
        toolCalls: response.toolCalls,
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      },
    });

    if (response.toolCalls.length === 0) {
      if (response.finishReason !== "stop") {
        const feedback = `Completion candidate was not accepted because the model finished with ${response.finishReason}`;
        await emit({ type: "candidate.rejected", data: { step, output: response.content, feedback } });
        contextAssembler.setRuntimeDirective(feedback);
        continue;
      }
      // A converged turn has no tools, so a model that is still mid-execution
      // tends to emit its next tool call as literal text. That is not a
      // completion candidate: reject it so it never reaches the assessor (which
      // would otherwise resume the execution instead of assessing it). The
      // loop then exits and reports the budget exhaustion accurately.
      if (convergenceOnly && isTextToolInvocation(response.content)) {
        await emit({
          type: "candidate.rejected",
          data: {
            step,
            output: response.content,
            feedback: "Completion candidate was an unexecuted tool invocation; the step budget was exhausted while the model was still working",
          },
        });
        continue;
      }
      const evaluation = await evaluateCandidate(step, {
        output: response.content,
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
        return { output: response.content, messages, steps: step, toolEvidence, activatedSkillNames: [...activatedSkillNames] };
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
          messages,
          steps: step,
          toolEvidence,
          activatedSkillNames: [...activatedSkillNames],
          completionCaveat,
        };
      }
      rejectedCandidateAssessments += 1;
      if (rejectedCandidateAssessments > candidateRepairAssessmentLimit) {
        if (evaluation.allowRepairLimitCompletion === false) {
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
          throw new AppError(
            "STEP_NOT_COMPLETED",
            "The latest completion candidate still fails required success criteria and cannot be accepted with a repair-limit caveat.",
            422,
            {
              feedback: evaluation.feedback,
              ...(evaluation.failedBoundary === undefined ? {} : { failedBoundary: evaluation.failedBoundary }),
            },
          );
        }
        const output = repairLimitCompletionOutput(response.content, evaluation.feedback, candidateRepairAssessmentLimit);
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
          messages,
          steps: step,
          toolEvidence,
          activatedSkillNames: [...activatedSkillNames],
          completionCaveat,
        };
      }
      requestedConvergenceReason = undefined;
      if (candidateRepairGraceSteps > grantedCandidateRepairGraceSteps) {
        grantedCandidateRepairGraceSteps = candidateRepairGraceSteps;
        await emit({
          type: "loop.candidate_repair_grace_granted",
          data: {
            step,
            candidateRepairGraceSteps,
            hardLimit: currentHardLimit(options.maxSteps, graceSteps, grantedCandidateRepairGraceSteps),
            feedback: evaluation.feedback,
          },
        });
      }
      contextAssembler.setRuntimeDirective(
        candidateRepairDirective(evaluation, "Completion was rejected. Repair this step using the available evidence."),
      );
      continue;
    }

    contextAssembler.setRuntimeDirective(undefined);

    // Progress-aware grace: once past the primary budget, re-issuing the exact
    // same tool calls (name + arguments) as the previous step is a stall, not
    // progress. Stop granting further grace and report the budget exhaustion
    // instead of paying for a looping model.
    if (
      !convergenceOnly
      && response.finishReason !== "length"
      && response.toolCalls.length > 0
    ) {
      const signature = toolCallSignature(response.toolCalls);
      if (inGrace && previousToolSignature !== undefined && signature === previousToolSignature) {
        stalled = true;
        for (const call of response.toolCalls) {
          await emit({
            type: "tool.rejected",
            data: {
              step,
              toolCallId: call.id,
              toolName: call.name,
              reason: "Tool call was not executed because the model repeated identical tool calls without forward progress",
            },
          });
        }
        await emit({
          type: "loop.no_progress",
          data: { step, phase: "execution", toolSignature: signature },
        });
        break;
      }
      previousToolSignature = signature;
    }

    let outcomes: ToolOutcome[];
    if (convergenceOnly) {
      outcomes = response.toolCalls.map((call) => ({
        call,
        content: "Tool call was not executed because the Runtime reserved this final step for convergence",
        isError: true,
      }));
      for (const outcome of outcomes) {
        await emit({
          type: "tool.rejected",
          data: { step, toolCallId: outcome.call.id, toolName: outcome.call.name, reason: outcome.content },
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
          isError: true,
        };
      });
      for (const outcome of outcomes) {
        if (earlyOutcomes.has(outcome.call.id)) continue;
        await emit({
          type: "tool.rejected",
          data: { step, toolCallId: outcome.call.id, toolName: outcome.call.name, reason: outcome.content },
        });
      }
    } else {
      // Tool calls whose arguments completed during the stream were already
      // dispatched and are present in earlyOutcomes; only dispatch the rest.
      const remainingCalls = response.toolCalls.filter((call) => !earlyOutcomes.has(call.id));
      const prepared: PreparedEntry[] = [];
      for (const call of remainingCalls) {
        try {
          const value = materialized.prepare(call);
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
            data: { step, toolCallId: call.id, toolName: call.name, reason: message },
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
        return lateOutcomes[lateIndex++];
      });
    }

    // Provider protocol requires tool results in source call order even when the
    // actual effects complete out of order.
    const latestToolEvidence: AgentLoopToolEvidence[] = [];
    for (const outcome of outcomes) {
      const evidence = {
        toolCallId: outcome.call.id,
        toolName: outcome.call.name,
        result: outcome.content,
        isError: outcome.isError,
      };
      toolEvidence.push(evidence);
      latestToolEvidence.push(evidence);
      messages.push({
        role: "tool",
        toolCallId: outcome.call.id,
        name: outcome.call.name,
        content: outcome.content,
        isError: outcome.isError,
      });
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
    await emit({
      type: "step.completed",
      data: { step, toolResults: outcomes.map((item) => ({ toolCallId: item.call.id, isError: item.isError })) },
    });

    const structuredCandidate = options.evaluateCandidate === undefined
      ? undefined
      : extractStructuredToolCandidate(latestToolEvidence);
    if (structuredCandidate !== undefined) {
      await emit({
        type: "candidate.structured_tool_detected",
        data: {
          step,
          toolCallId: structuredCandidate.sourceToolCallId,
          ...(structuredCandidate.schema === undefined ? {} : { schema: structuredCandidate.schema }),
        },
      });
      const evaluation = await evaluateCandidate(step, {
        output: structuredCandidate.output,
        messages,
        modelSteps: step,
        toolEvidence,
        projectedToolEvidence: projectStructuredCandidateEvidence(toolEvidence, structuredCandidate),
        activatedSkillNames: [...activatedSkillNames],
        ...(contextAssembler.contextSummary === undefined
          ? {}
          : { contextSummary: contextAssembler.contextSummary }),
      });
      await emit({
        type: evaluation.approved ? "candidate.approved" : "candidate.rejected",
        data: { step, output: structuredCandidate.output, feedback: evaluation.feedback },
      });
      if (evaluation.approved) {
        await emit({ type: "loop.completed", data: { step, output: structuredCandidate.output } });
        return {
          output: structuredCandidate.output,
          messages,
          steps: step,
          toolEvidence,
          activatedSkillNames: [...activatedSkillNames],
        };
      }
      if (evaluation.deferredValidation === true) {
        const output = deferredValidationOutput(structuredCandidate.output, evaluation.feedback);
        const completionCaveat = { reason: "deferred_validation" as const, feedback: evaluation.feedback };
        await emit({
          type: "candidate.validation_deferred",
          data: { step, output, feedback: evaluation.feedback },
        });
        await emit({ type: "loop.completed", data: { step, output, deferredValidation: true, completionCaveat } });
        return {
          output,
          messages,
          steps: step,
          toolEvidence,
          activatedSkillNames: [...activatedSkillNames],
          deferredValidation: true,
          completionCaveat,
        };
      }
      if (evaluation.evidenceBoundary === true) {
        const output = evidenceBoundaryOutput(structuredCandidate.output, evaluation.feedback);
        const completionCaveat = { reason: "evidence_boundary" as const, feedback: evaluation.feedback };
        await emit({
          type: "candidate.evidence_boundary_accepted",
          data: { step, output, feedback: evaluation.feedback },
        });
        await emit({ type: "loop.completed", data: { step, output, completionCaveat } });
        return {
          output,
          messages,
          steps: step,
          toolEvidence,
          activatedSkillNames: [...activatedSkillNames],
          completionCaveat,
        };
      }
      rejectedCandidateAssessments += 1;
      if (rejectedCandidateAssessments > candidateRepairAssessmentLimit) {
        if (evaluation.allowRepairLimitCompletion === false) {
          await emit({
            type: "candidate.repair_limit_blocked",
            data: {
              step,
              output: structuredCandidate.output,
              feedback: evaluation.feedback,
              rejectedCandidateAssessments,
              candidateRepairAssessmentLimit,
            },
          });
          throw new AppError(
            "STEP_NOT_COMPLETED",
            "The latest completion candidate still fails required success criteria and cannot be accepted with a repair-limit caveat.",
            422,
            {
              feedback: evaluation.feedback,
              ...(evaluation.failedBoundary === undefined ? {} : { failedBoundary: evaluation.failedBoundary }),
            },
          );
        }
        const output = repairLimitCompletionOutput(
          structuredCandidate.output,
          evaluation.feedback,
          candidateRepairAssessmentLimit,
        );
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
          messages,
          steps: step,
          toolEvidence,
          activatedSkillNames: [...activatedSkillNames],
          completionCaveat,
        };
      }
      requestedConvergenceReason = undefined;
      contextAssembler.setRuntimeDirective(
        candidateRepairDirective(evaluation, "Structured tool candidate was rejected. Repair this step using the available evidence."),
      );
      continue;
    }

    const convergenceDecision = await evaluateToolStepConvergence(options.shouldConvergeAfterToolStep, {
      step,
      messages,
      toolEvidence,
      latestToolEvidence,
      activatedSkillNames: [...activatedSkillNames],
    });
    if (convergenceDecision.converge) {
      requestedConvergenceReason = convergenceDecision.reason ?? "tool_evidence_ready";
      await emit({
        type: "loop.convergence_queued",
        data: { step, reason: requestedConvergenceReason, priorToolResultCount: toolEvidence.length },
      });
    }
  }

  await emit({
    type: "loop.limit_exceeded",
    data: {
      maxSteps: options.maxSteps,
      convergenceGraceSteps: graceSteps,
      candidateRepairGraceSteps,
      candidateRepairAssessmentLimit,
      grantedCandidateRepairGraceSteps,
      hardLimit: currentHardLimit(options.maxSteps, graceSteps, grantedCandidateRepairGraceSteps),
      convergenceRequested,
      stalled,
    },
  });
  throw new AppError(
    "RUN_LIMIT_EXCEEDED",
    stalled
      ? `Run stopped extending its budget: the model repeated identical tool calls without forward progress (${options.maxSteps} primary + ${graceSteps} convergence grace)`
      : `Run exceeded its ${currentHardLimit(options.maxSteps, graceSteps, grantedCandidateRepairGraceSteps)}-step limit (${options.maxSteps} primary + ${graceSteps} convergence grace + ${grantedCandidateRepairGraceSteps} candidate repair grace)`,
    409,
    {
      maxSteps: options.maxSteps,
      convergenceGraceSteps: graceSteps,
      candidateRepairGraceSteps,
      candidateRepairAssessmentLimit,
      grantedCandidateRepairGraceSteps,
      hardLimit: currentHardLimit(options.maxSteps, graceSteps, grantedCandidateRepairGraceSteps),
      stalled,
    },
  );
}

function currentHardLimit(
  maxSteps: number,
  convergenceGraceSteps: number,
  candidateRepairGraceSteps: number,
): number {
  return maxSteps + convergenceGraceSteps + candidateRepairGraceSteps;
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

function repairLimitCompletionOutput(output: string, feedback: string, repairLimit: number): string {
  const trimmedOutput = output.trim();
  const trimmedFeedback = feedback.trim();
  const caveat = `Repair caveat: the candidate was assessed again after ${repairLimit} repair attempt(s), but the remaining issue did not converge. The latest deliverable is accepted with this caveat instead of continuing the repair loop.`;
  return [trimmedOutput, caveat, trimmedFeedback].filter((part) => part.length > 0).join("\n\n");
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

function extractStructuredToolCandidate(
  evidence: readonly AgentLoopToolEvidence[],
): StructuredToolCandidate | undefined {
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const item = evidence[index];
    if (item.isError) continue;
    for (const record of candidateRecordsFromToolResult(item.result)) {
      const candidate = structuredCandidateFromRecord(record, item.toolCallId);
      if (candidate !== undefined) return candidate;
    }
  }
  return undefined;
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
  const schema = typeof record.schema === "string" ? record.schema : undefined;
  const deliveryCandidate = isPlainRecord(record.deliveryCandidate) ? record.deliveryCandidate : undefined;
  const output = typeof deliveryCandidate?.output === "string"
    ? deliveryCandidate.output
    : (typeof record.delivery_markdown === "string" ? record.delivery_markdown : undefined);
  if (output === undefined || output.trim().length === 0) return undefined;
  const projectionSource = record.assessmentProjection
    ?? record.assessment_summary
    ?? {
      schema,
      sourceToolCallId,
      deliveryCharacters: output.length,
    };
  return {
    output,
    projection: JSON.stringify({
      structuredToolCandidate: projectionSource,
      sourceToolCallId,
      ...(schema === undefined ? {} : { schema }),
    }),
    sourceToolCallId,
    ...(schema === undefined ? {} : { schema }),
  };
}

function projectStructuredCandidateEvidence(
  evidence: readonly AgentLoopToolEvidence[],
  candidate: StructuredToolCandidate,
): readonly AgentLoopToolEvidence[] {
  return evidence.map((item) => {
    if (item.toolCallId !== candidate.sourceToolCallId) return item;
    return {
      ...item,
      result: candidate.projection,
    };
  });
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
}

/**
 * Prefer the model adapter's streaming path. As each tool call's arguments
 * complete (`tool_call_ready`), the call is durably committed through
 * `assistant.tool_call.committed` and dispatched through a bounded pool while
 * the remainder of the stream is still being consumed (OpenCode-style overlap).
 * Resolves to the same aggregated ModelResponse; the caller still emits the
 * full `assistant.committed` checkpoint after this resolves.
 */
async function completeWithStreamingAndDispatch(
  context: StreamingDispatchContext,
  earlyOutcomes: Map<string, ToolOutcome>,
): Promise<ModelResponse> {
  if (context.model.streamComplete === undefined) {
    return context.model.complete(context.invocation, context.signal);
  }
  const limiter = createConcurrencyLimiter(Math.max(1, context.maxParallelToolCalls));
  const dispatches: Array<Promise<void>> = [];

  const dispatchEarly = (call: ModelToolCall): void => {
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
            data: { step: context.step, toolCallId: call.id, toolName: call.name, reason: message },
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

  const response = await completeWithStreaming({
    model: context.model,
    invocation: context.invocation,
    emit: context.emit,
    signal: context.signal,
    base: { phase: "execution", step: context.step },
    onToolCallReady: async (call) => {
      // When the turn was dispatched without tools (convergence) any tool call is
      // model misbehaviour and is never executed, so skip both commit and dispatch.
      if (context.invocation.tools.length === 0) return;
      await context.emit({
        type: "assistant.tool_call.committed",
        data: {
          step: context.step,
          toolCallId: call.id,
          name: call.name,
          arguments: call.arguments,
        },
      });
      dispatchEarly(call);
    },
  });

  await Promise.all(dispatches);
  return response;
}

function createConcurrencyLimiter(limit: number): {
  acquire: () => Promise<void>;
  release: () => void;
} {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  };
  const release = (): void => {
    active -= 1;
    const next = waiters.shift();
    if (next !== undefined) next();
  };
  return { acquire, release };
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

// Algorithm adapted from PI's subagent extension. Preallocated result slots
// preserve source order without serializing independent work.
async function mapWithConcurrencyLimit<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  operation: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
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
    return { call: entry.call, content: entry.message, isError: true };
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
    const execute = async (): Promise<unknown> => {
      return tool.execute({ grant, signal }, input);
    };
    const value = actionTracker === undefined
      ? await execute()
      : await actionTracker.executeToolCall({
        step,
        toolCallId: call.id,
        toolName: call.name,
        replaySafe: tool.replaySafe,
        timeoutMs: tool.timeoutMs,
      }, execute);
    const content = serializeToolResult(value, tool.maxResultCharacters ?? maxCharacters);
    await emit({
      type: "tool.result_committed",
      data: { step, toolCallId: call.id, toolName: call.name, result: content },
    });
    await emit({
      type: "tool.completed",
      data: { step, toolCallId: call.id, toolName: call.name, result: content },
    });
    return { call, content, isError: false };
  } catch (error) {
    const content = publicErrorMessage(error);
    await emit({
      type: "tool.failed",
      data: { step, toolCallId: call.id, toolName: call.name, error: content },
    });
    return { call, content, isError: true };
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

/**
 * Fingerprint one step's requested tool calls (name + argument digest) so the
 * Runtime can tell a productive step from a repeat of the previous step.
 */
function toolCallSignature(calls: readonly ModelToolCall[]): string {
  return calls
    .map((call) => {
      const serialized = typeof call.arguments === "string"
        ? call.arguments
        : JSON.stringify(call.arguments) ?? "";
      return `${call.name}#${createHash("sha256").update(serialized).digest("hex")}`;
    })
    .sort()
    .join("|");
}

function candidateRepairDirective(evaluation: CandidateCompletionEvaluation, fallback: string): string {
  const feedback = evaluation.feedback || fallback;
  if (evaluation.assessmentReused !== true) return feedback;
  return [
    feedback,
    "The exact completion candidate was already assessed against the same evidence. Do not resubmit it; gather new evidence or provide a materially changed candidate.",
  ].join("\n");
}



function serializeToolResult(value: unknown, maximum: number): string {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    serialized = "Tool returned a value that could not be serialized";
  }
  if (serialized === undefined) serialized = "null";
  if (serialized.length <= maximum) return serialized;
  const omitted = serialized.length - maximum;
  const digest = createHash("sha256").update(serialized).digest("hex");
  return `${serialized.slice(0, maximum)}\n[truncated ${omitted} characters; sha256=${digest}]`;
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
