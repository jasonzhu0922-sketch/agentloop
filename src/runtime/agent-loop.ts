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

export interface AgentLoopOptions {
  readonly runId: string;
  readonly systemPrompt: string;
  readonly runtimeContext?: Omit<RuntimeContextSnapshot, "id" | "supersedesId">;
  readonly input: string;
  /** Complete, persisted exchanges from a prior interrupted execution. */
  readonly initialMessages?: readonly ModelMessage[];
  readonly initialToolEvidence?: readonly AgentLoopToolEvidence[];
  readonly model: ModelAdapter;
  readonly tools: ToolRegistry;
  readonly grant: CapabilityGrant;
  readonly requiredSkills?: readonly {
    readonly id: string;
    readonly name: string;
    readonly contentHash: string;
  }[];
  readonly maxSteps: number;
  readonly maxToolResultCharacters?: number;
  readonly maxParallelToolCalls?: number;
  readonly contextPolicy?: ContextPolicy;
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

type PreparedEntry =
  | { readonly kind: "ready"; readonly value: PreparedToolCall }
  | { readonly kind: "rejected"; readonly call: ModelToolCall; readonly message: string };

interface ToolOutcome {
  readonly call: ModelToolCall;
  readonly content: string;
  readonly isError: boolean;
}

const CONVERGENCE_PROMPT = [
  "<runtime_convergence>",
  "This is the final model step allowed by the current step budget.",
  "No execution tools are available on this turn.",
  "Use the canonical tool results already present in the conversation to submit one concise completion candidate.",
  "Address the current Plan step and its success criteria, cite the concrete evidence you relied on, and state any unmet criterion truthfully.",
  "This response is only a candidate: the independent assessor and Terminal Committer remain authoritative.",
  "Do not request or emit tool calls.",
  "</runtime_convergence>",
].join("\n");

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const emit = async (event: RuntimeEvent): Promise<void> => {
    await options.emit?.(event);
  };
  const maxToolResultCharacters = options.maxToolResultCharacters ?? 50_000;
  const maxParallelToolCalls = options.maxParallelToolCalls ?? 4;
  const messages: ModelMessage[] = options.initialMessages === undefined
    ? [{ role: "user", content: options.input }]
    : [...options.initialMessages];
  const toolEvidence: AgentLoopToolEvidence[] = [...(options.initialToolEvidence ?? [])];
  const requiredSkills = new Map((options.requiredSkills ?? []).map((skill) => [skill.name, skill]));
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
    data: { runId: options.runId, agentId: options.grant.agentId, depth: options.grant.depth },
  });
  if (requiredSkills.size > 0) {
    await emit({
      type: "skill.activation.required",
      data: {
        skills: [...requiredSkills.values()].map((skill) => ({
          id: skill.id,
          name: skill.name,
          contentHash: skill.contentHash,
        })),
      },
    });
  }

  let convergenceRequested = false;
  for (let step = 1; step <= options.maxSteps; step += 1) {
    throwIfAborted(options.signal);
    const convergenceOnly = step === options.maxSteps && toolEvidence.length > 0;
    if (convergenceOnly) {
      convergenceRequested = true;
      contextAssembler.setRuntimeDirective(CONVERGENCE_PROMPT);
      await emit({
        type: "loop.convergence_requested",
        data: {
          step,
          maxSteps: options.maxSteps,
          priorToolResultCount: toolEvidence.length,
        },
      });
    }
    await emit({ type: "step.started", data: { step, phase: convergenceOnly ? "convergence" : "execution" } });

    // Ported from OpenCode's materialization boundary: each model step gets a
    // fresh authorized snapshot, and preparation remains tied to that snapshot.
    let activeSkillNames = contextAssembler.activeSkillNames(messages);
    let pendingSkillNames = [...requiredSkills.keys()].filter((name) => !activeSkillNames.has(name));
    let activeGrant = pendingSkillNames.length === 0
      ? options.grant
      : {
          ...options.grant,
          allowedToolNames: new Set(
            options.grant.allowedToolNames.has("load_skill") ? ["load_skill"] : [],
          ),
        };
    let materialized = options.tools.materialize(activeGrant);
    let assembly = await contextAssembler.assemble(messages, convergenceOnly ? [] : materialized.definitions, options.signal);
    const activeAfterAssembly = contextAssembler.activeSkillNames(messages);
    if (!sameStringSet(activeSkillNames, activeAfterAssembly)) {
      activeSkillNames = activeAfterAssembly;
      pendingSkillNames = [...requiredSkills.keys()].filter((name) => !activeSkillNames.has(name));
      activeGrant = pendingSkillNames.length === 0
        ? options.grant
        : {
            ...options.grant,
            allowedToolNames: new Set(
              options.grant.allowedToolNames.has("load_skill") ? ["load_skill"] : [],
            ),
          };
      materialized = options.tools.materialize(activeGrant);
      assembly = await contextAssembler.assemble(
        messages,
        convergenceOnly ? [] : materialized.definitions,
        options.signal,
      );
    }

    const invocation: ModelInvocation = {
      runId: options.runId,
      systemPrompt: options.systemPrompt,
      phase: "execution",
      runtimeContext: assembly.runtimeContext,
      messages: assembly.messages,
      tools: convergenceOnly ? [] : materialized.definitions,
      ...(convergenceOnly || materialized.definitions.length === 0
        ? {}
        : { toolChoice: pendingSkillNames.length === 0 ? "auto" as const : "required" as const }),
    };
    const earlyOutcomes = new Map<string, ToolOutcome>();
    const response = await completeWithStreamingAndDispatch({
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
    const assistantMessage: ModelMessage = {
      role: "assistant",
      content: response.content,
      ...(response.toolCalls.length === 0 ? {} : { toolCalls: response.toolCalls }),
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
      if (pendingSkillNames.length > 0) {
        const feedback = `Load every Skill bound to this Plan step before working or submitting completion: ${pendingSkillNames.join(", ")}`;
        await emit({ type: "candidate.rejected", data: { step, output: response.content, feedback } });
        contextAssembler.setRuntimeDirective(feedback);
        continue;
      }
      if (response.finishReason !== "stop") {
        const feedback = `Completion candidate was not accepted because the model finished with ${response.finishReason}`;
        await emit({ type: "candidate.rejected", data: { step, output: response.content, feedback } });
        contextAssembler.setRuntimeDirective(feedback);
        continue;
      }
      const evaluation = await options.evaluateCandidate?.({
        output: response.content,
        messages,
        modelSteps: step,
        toolEvidence,
        projectedToolEvidence: contextAssembler.projectToolEvidence(messages, toolEvidence),
        ...(contextAssembler.contextSummary === undefined
          ? {}
          : { contextSummary: contextAssembler.contextSummary }),
      }) ?? { approved: true, feedback: "" };
      await emit({
        type: evaluation.approved ? "candidate.approved" : "candidate.rejected",
        data: { step, output: response.content, feedback: evaluation.feedback },
      });
      if (evaluation.approved) {
        await emit({ type: "loop.completed", data: { step, output: response.content } });
        return { output: response.content, messages, steps: step, toolEvidence };
      }
      contextAssembler.setRuntimeDirective(
        evaluation.feedback || "Completion was rejected. Repair this step using the available evidence.",
      );
      continue;
    }

    contextAssembler.setRuntimeDirective(undefined);

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
    for (const outcome of outcomes) {
      toolEvidence.push({
        toolCallId: outcome.call.id,
        toolName: outcome.call.name,
        result: outcome.content,
        isError: outcome.isError,
      });
      messages.push({
        role: "tool",
        toolCallId: outcome.call.id,
        name: outcome.call.name,
        content: outcome.content,
        isError: outcome.isError,
      });
      if (!outcome.isError && outcome.call.name === "load_skill") {
        const name = skillNameFromArguments(outcome.call.arguments);
        const skill = name === undefined ? undefined : requiredSkills.get(name);
        if (skill !== undefined) {
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
  }

  await emit({
    type: "loop.limit_exceeded",
    data: { maxSteps: options.maxSteps, convergenceRequested },
  });
  throw new AppError(
    "RUN_LIMIT_EXCEEDED",
    `Run exceeded its ${options.maxSteps}-step limit`,
    409,
    { maxSteps: options.maxSteps },
  );
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
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
    const execute = async (): Promise<unknown> => {
      // For a replay-unsafe tool this is the persisted point from which recovery
      // must synthesize an interrupted result instead of executing it again.
      await emit({
        type: "tool.effect_pending",
        data: { step, toolCallId: call.id, toolName: call.name, replaySafe: tool.replaySafe },
      });
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
