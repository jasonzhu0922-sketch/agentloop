import { createHash } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import { buildSkillReferenceMap } from "../skills/skill-identity.ts";
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
import type { PreparedToolCall } from "../tools/tool-registry.ts";
import { ToolRegistry } from "../tools/tool-registry.ts";
import { completeWithStreaming } from "./model-streaming.ts";
import { isTextToolInvocation } from "./text-tool-invocation.ts";
import {
  evaluateRuntimeToolProgress,
  initialRuntimeToolProgressState,
  type RuntimeToolProgressPolicy,
} from "./tool-progress-policy.ts";

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
  readonly convergencePrompt?: string;
  readonly convergenceMaxOutputTokens?: number;
  readonly shouldConvergeAfterToolStep?: (
    context: ToolStepConvergenceContext,
  ) => boolean | ToolStepConvergenceDecision | Promise<boolean | ToolStepConvergenceDecision>;
  readonly shouldUseFinalConvergence?: (
    context: ToolStepConvergenceContext,
  ) => boolean | Promise<boolean>;
  readonly progressPolicy?: RuntimeToolProgressPolicy;
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

const TEXT_TOOL_INVOCATION_REPAIR_PROMPT = [
  "<runtime_candidate_repair>",
  "The previous completion candidate was an unexecuted text tool invocation, so it cannot be assessed.",
  "Execution tools are not available on this convergence turn.",
  "Return a real completion candidate in 1-3 short sentences using only the canonical evidence already present.",
  "Do not request, describe, or emit tool calls or provider tool-call protocol markup.",
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
  const convergenceMaxOutputTokens = Math.max(1, options.convergenceMaxOutputTokens ?? CONVERGENCE_MAX_OUTPUT_TOKENS);
  const convergencePrompt = options.convergencePrompt ?? CONVERGENCE_PROMPT;
  const candidateRepairAssessmentLimit = Math.max(
    0,
    options.candidateRepairAssessmentLimit ?? DEFAULT_CANDIDATE_REPAIR_ASSESSMENT_LIMIT,
  );
  let grantedCandidateRepairGraceSteps = 0;
  let grantedFinalConvergenceGraceSteps = 0;
  let rejectedCandidateAssessments = 0;
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
  let previousToolSignature: string | undefined;
  let toolProgressState = initialRuntimeToolProgressState();
  let stalled = false;
  let requestedConvergenceReason: string | undefined;
  const currentLimit = (): number =>
    currentHardLimit(options.maxSteps, graceSteps, grantedCandidateRepairGraceSteps, grantedFinalConvergenceGraceSteps);
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
  for (let step = 1; step <= currentLimit(); step += 1) {
    throwIfAborted(options.signal);
    const inGrace = step > options.maxSteps;
    const hardLimit = currentLimit();
    const finalConvergenceAllowed = requestedConvergenceReason !== undefined
      || step !== hardLimit
      || await shouldUseFinalConvergence(options.shouldUseFinalConvergence, {
        step,
        messages,
        toolEvidence,
        latestToolEvidence: toolEvidence,
        activatedSkillNames: [...activatedSkillNames],
      });
    const convergenceOnly = toolEvidence.length > 0
      && (requestedConvergenceReason !== undefined || (step === hardLimit && finalConvergenceAllowed));
    if (convergenceOnly) {
      convergenceRequested = true;
      contextAssembler.setRuntimeDirective(convergencePrompt);
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
          convergenceOnly ? convergenceMaxOutputTokens : MODEL_STEP_MAX_OUTPUT_TOKENS,
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
      if (
        convergenceOnly
        && response.toolCalls.length === 0
        && response.finishReason === "stop"
        && isTextToolInvocation(response.content)
        && candidateAttempt < EMPTY_CANDIDATE_REPAIR_ATTEMPTS
      ) {
        await emit({
          type: "candidate.rejected",
          data: {
            step,
            output: response.content,
            feedback: "Completion candidate was an unexecuted tool invocation",
          },
        });
        contextAssembler.setRuntimeDirective(TEXT_TOOL_INVOCATION_REPAIR_PROMPT);
        assembly = await contextAssembler.assemble(messages, [], options.signal);
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
        ...(response.reasoningContent === undefined ? {} : { reasoningContent: response.reasoningContent }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      },
    });

    if (response.toolCalls.length === 0) {
      if (response.finishReason !== "stop") {
        const feedback = `Completion candidate was not accepted because the model finished with ${response.finishReason}`;
        await emit({ type: "candidate.rejected", data: { step, output: response.content, feedback } });
        removeRejectedAssistantCandidate(messages, assistantMessage);
        if (candidateRepairGraceSteps > grantedCandidateRepairGraceSteps) {
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
        }
        contextAssembler.setRuntimeDirective([
          feedback,
          "Return a complete, shorter completion candidate using the available evidence.",
          "Do not request or emit tool calls.",
        ].join("\n"));
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
          messages,
          steps: step,
          toolEvidence,
          activatedSkillNames: [...activatedSkillNames],
          completionCaveat,
        };
      }
      requestedConvergenceReason = undefined;
      removeRejectedAssistantCandidate(messages, assistantMessage);
      if (candidateRepairGraceSteps > grantedCandidateRepairGraceSteps) {
        grantedCandidateRepairGraceSteps = candidateRepairGraceSteps;
        await emit({
          type: "loop.candidate_repair_grace_granted",
          data: {
            step,
            candidateRepairGraceSteps,
            hardLimit: currentLimit(),
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
      const progressDecision = evaluateRuntimeToolProgress({
        policy: options.progressPolicy,
        state: toolProgressState,
        inGrace,
        calls: response.toolCalls,
        priorEvidence: toolEvidence,
      });
      toolProgressState = progressDecision.state;
      if (!progressDecision.allow) {
        stalled = progressDecision.stalled === true || step === hardLimit;
        const reason = progressDecision.reason ?? "Tool call was not executed because it did not make forward progress";
        for (const call of response.toolCalls) {
          await emit({
            type: "tool.rejected",
            data: {
              step,
              toolCallId: call.id,
              toolName: call.name,
              reason,
            },
          });
          const evidence = {
            toolCallId: call.id,
            toolName: call.name,
            result: reason,
            isError: true,
          };
          toolEvidence.push(evidence);
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: reason,
            isError: true,
          });
        }
        await emit({
          type: "step.completed",
          data: { step, toolResults: response.toolCalls.map((call) => ({ toolCallId: call.id, isError: true })) },
        });
        await emit({
          type: "loop.no_progress",
          data: {
            step,
            phase: "execution",
            toolSignature: signature,
            reason,
            stalled,
          },
        });
        if (stalled) break;
        contextAssembler.setRuntimeDirective(progressDecision.directive ?? reason);
        continue;
      }
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
        const output = repairLimitCompletionOutput(structuredCandidate.output, candidateRepairAssessmentLimit);
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
    if (!convergenceDecision.converge) {
      contextAssembler.setRuntimeDirective(executionFeedbackDirective(latestToolEvidence));
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
}

function currentHardLimit(
  maxSteps: number,
  convergenceGraceSteps: number,
  candidateRepairGraceSteps: number,
  finalConvergenceGraceSteps = 0,
): number {
  return maxSteps + convergenceGraceSteps + candidateRepairGraceSteps + finalConvergenceGraceSteps;
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
  const wrapperSchema = typeof record.schema === "string" ? record.schema : undefined;
  const sourceSchema = typeof record.sourceSchema === "string" ? record.sourceSchema : undefined;
  const schema = sourceSchema ?? wrapperSchema;
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
      ...(sourceSchema === undefined ? {} : { sourceSchema }),
      ...(wrapperSchema === undefined || wrapperSchema === schema ? {} : { wrapperSchema }),
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

function executionFeedbackDirective(
  latestToolEvidence: readonly AgentLoopToolEvidence[],
): string | undefined {
  if (latestToolEvidence.length === 0) return undefined;
  const lines = [
    "<runtime_execution_feedback>",
    "The previous tool step produced canonical execution results. Consume these results before choosing the next action.",
    "If any tool failed, address the concrete failure cause or change strategy before continuing.",
    "If any command created or modified files, treat fileChanges paths as artifact facts to inspect or verify next.",
    "If required evidence is still missing, call the appropriate current-step tool to produce that evidence; do not submit completion from assumptions.",
    "Recent tool results:",
  ];
  for (const item of latestToolEvidence.slice(-6)) {
    lines.push(`- ${summarizeToolEvidenceForDirective(item)}`);
  }
  const skillPackageMutation = latestToolEvidence.find((item) =>
    item.isError && /SKILL_PACKAGE_MUTATED/.test(item.result)
  );
  if (skillPackageMutation !== undefined) {
    lines.push(
      "SKILL_PACKAGE_MUTATED means a command wrote under a read-only Skill command root. Rerun from the Skill cwd only for package scripts, but make writable --workspace/--output/--outdir arguments resolve under the writable workspace root; do not inspect package internals solely to diagnose this already-known boundary.",
    );
  }
  lines.push("</runtime_execution_feedback>");
  return lines.join("\n");
}

function summarizeToolEvidenceForDirective(item: AgentLoopToolEvidence): string {
  const parsed = parseJsonRecord(item.result);
  const details: string[] = [];
  let commandFailed = false;
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
    const metrics = toolEvidenceMetrics(call.name, content);
    await emit({
      type: "tool.result_committed",
      data: { step, toolCallId: call.id, toolName: call.name, result: content, ...metrics },
    });
    await emit({
      type: "tool.completed",
      data: { step, toolCallId: call.id, toolName: call.name, result: content, ...metrics },
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
  lines.push("</runtime_candidate_repair>");
  return lines.join("\n");
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
