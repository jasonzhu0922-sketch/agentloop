import { createHash } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import type {
  AgentLoopToolEvidence,
  ModelAdapter,
  ModelInvocation,
  ModelMessage,
  ModelToolDefinition,
  RuntimeContextSnapshot,
  RuntimeEvent,
  RuntimeEventSink,
} from "./contracts.ts";

export interface ContextPolicy {
  readonly outputReserveTokens?: number;
  readonly safetyMarginTokens?: number;
  readonly preserveRecentTokens?: number;
  readonly pruneProtectTokens?: number;
  readonly summaryMaxOutputTokens?: number;
  readonly summaryToolResultCharacters?: number;
}

export interface ContextAssembly {
  readonly messages: readonly ModelMessage[];
  readonly runtimeContext: RuntimeContextSnapshot;
  readonly estimatedInputTokens: number;
  readonly usableInputTokens: number;
  readonly contextEpoch: number;
}

interface ResolvedContextPolicy {
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly safetyMarginTokens: number;
  readonly preserveRecentTokens: number;
  readonly pruneProtectTokens: number;
  readonly summaryMaxOutputTokens: number;
  readonly persistedSummaryMaxTokens: number;
  readonly summaryToolResultCharacters: number;
}

interface PrunedToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly originalCharacters: number;
  readonly sha256: string;
}

const SUMMARY_SYSTEM_PROMPT = [
  "You are a context summarization component inside an agent runtime.",
  "Do not continue the task and do not answer questions from the conversation.",
  "Return only the requested structured summary.",
].join("\n");

const SUMMARY_FORMAT = `Use this exact structure:

## Goal
[The current user goal and admitted step]

## Constraints & Preferences
- [Preserve explicit user and runtime constraints]

## Progress
### Done
- [Completed work and durable outputs]

### In Progress
- [Current work]

### Blocked
- [Current blockers, or none]

## Key Decisions
- **[Decision]**: [Rationale]

## Evidence
- [ToolCall IDs, files, hashes, receipts, and observations needed to continue]

## Next Steps
1. [Concrete next action]

## Critical Context
- [Exact identifiers, paths, error messages, and facts that must survive]

Rules:
- Preserve every fact already present in a previous summary unless later evidence supersedes it.
- Update progress instead of duplicating it.
- Never invent success, evidence, files, commands, or completion.
- A Skill body omitted from the transcript is not summarized authority; it must be loaded again.
- Keep exact paths, IDs, hashes, error messages, and user constraints.`;

export class ContextAssembler {
  private readonly runId: string;
  private readonly systemPrompt: string;
  private readonly runtimeContextBase: Omit<RuntimeContextSnapshot, "id" | "supersedesId">;
  private readonly model: ModelAdapter;
  private readonly emit?: RuntimeEventSink;
  private readonly policy: ResolvedContextPolicy;
  private readonly prunedToolResults = new Map<string, PrunedToolResult>();
  private firstKeptMessageIndex = 0;
  private contextEpoch = 0;
  private contextRevision = 0;
  private runtimeDirective?: string;
  private snapshot?: RuntimeContextSnapshot;
  private previousSnapshotId?: string;
  private summary?: string;

  constructor(options: {
    runId: string;
    systemPrompt: string;
    runtimeContext: Omit<RuntimeContextSnapshot, "id" | "supersedesId">;
    model: ModelAdapter;
    policy?: ContextPolicy;
    emit?: RuntimeEventSink;
  }) {
    this.runId = options.runId;
    this.systemPrompt = options.systemPrompt;
    this.runtimeContextBase = options.runtimeContext;
    this.model = options.model;
    this.emit = options.emit;
    this.policy = resolvePolicy(options.model, options.policy);
  }

  get contextSummary(): string | undefined {
    return this.summary;
  }

  /**
   * Runtime repair/convergence instructions are not user turns. Updating this
   * server-authored directive creates a new Context snapshot for the next
   * model invocation while leaving the canonical transcript untouched.
   */
  setRuntimeDirective(value: string | undefined): void {
    const normalized = value?.trim() || undefined;
    if (this.runtimeDirective === normalized) return;
    this.runtimeDirective = normalized;
    this.contextRevision += 1;
    this.invalidateSnapshot();
  }

  activeSkillNames(messages: readonly ModelMessage[]): ReadonlySet<string> {
    const calls = new Map<string, string>();
    for (let index = this.firstKeptMessageIndex; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      for (const call of message.toolCalls ?? []) {
        if (call.name !== "load_skill") continue;
        const name = skillNameFromArguments(call.arguments);
        if (name !== undefined) calls.set(call.id, name);
      }
    }
    const active = new Set<string>();
    for (let index = this.firstKeptMessageIndex; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role !== "tool" || message.name !== "load_skill" || message.isError) continue;
      const name = calls.get(message.toolCallId);
      if (name !== undefined) active.add(name);
    }
    return active;
  }

  async assemble(
    canonicalMessages: readonly ModelMessage[],
    tools: readonly ModelToolDefinition[],
    signal?: AbortSignal,
  ): Promise<ContextAssembly> {
    assertClosedToolProtocol(canonicalMessages);
    const usableInputTokens = this.policy.contextWindowTokens
      - this.policy.outputReserveTokens
      - this.policy.safetyMarginTokens;
    let runtimeContext = this.currentRuntimeContext();
    let fixedTokens = this.estimateInvocationTokens(tools, runtimeContext, []);
    if (fixedTokens >= usableInputTokens) {
      throw contextBudgetError("System prompt and Tool schemas leave no message budget", {
        fixedTokens,
        usableInputTokens,
      });
    }

    let projection = this.buildProjection(canonicalMessages);
    let estimatedInputTokens = this.estimateInvocationTokens(tools, runtimeContext, projection);
    if (estimatedInputTokens > usableInputTokens) {
      const beforePrune = estimatedInputTokens;
      const newlyPruned = this.pruneOldToolOutputs(
        canonicalMessages,
        tools,
        runtimeContext,
        usableInputTokens,
      );
      if (newlyPruned.length > 0) {
        projection = this.buildProjection(canonicalMessages);
        estimatedInputTokens = this.estimateInvocationTokens(tools, runtimeContext, projection);
        await this.emitEvent({
          type: "context.tool_outputs_pruned",
          data: {
            contextEpoch: this.contextEpoch,
            estimatedTokensBefore: beforePrune,
            estimatedTokensAfter: estimatedInputTokens,
            toolResults: newlyPruned,
          },
        });
      }
    }

    let compactions = 0;
    while (estimatedInputTokens > usableInputTokens && compactions < 3) {
      const compacted = await this.compact(canonicalMessages, tools, runtimeContext, estimatedInputTokens, signal);
      if (!compacted) break;
      compactions += 1;
      projection = this.buildProjection(canonicalMessages);
      runtimeContext = this.currentRuntimeContext();
      fixedTokens = this.estimateInvocationTokens(tools, runtimeContext, []);
      estimatedInputTokens = this.estimateInvocationTokens(tools, runtimeContext, projection);
    }

    if (estimatedInputTokens > usableInputTokens) {
      throw contextBudgetError("Context remains over budget after pruning and structured compaction", {
        estimatedInputTokens,
        usableInputTokens,
        contextEpoch: this.contextEpoch,
        runtimeContextId: runtimeContext.id,
        ...(runtimeContext.supersedesId === undefined ? {} : { supersedesRuntimeContextId: runtimeContext.supersedesId }),
        runtimeContextSha256: digest(runtimeContext.content),
        phase: runtimeContext.phase,
        firstKeptMessageIndex: this.firstKeptMessageIndex,
      });
    }

    await this.emitEvent({
      type: "context.assembled",
      data: {
        contextEpoch: this.contextEpoch,
        canonicalMessageCount: canonicalMessages.length,
        projectedMessageCount: projection.length,
        estimatedInputTokens,
        usableInputTokens,
        prunedToolResultCount: this.prunedToolResults.size,
        hasSummary: this.summary !== undefined,
      },
    });
    return {
      messages: projection,
      runtimeContext,
      estimatedInputTokens,
      usableInputTokens,
      contextEpoch: this.contextEpoch,
    };
  }

  projectToolEvidence(
    canonicalMessages: readonly ModelMessage[],
    evidence: readonly AgentLoopToolEvidence[],
  ): readonly AgentLoopToolEvidence[] {
    const resultIndex = new Map<string, number>();
    for (let index = 0; index < canonicalMessages.length; index += 1) {
      const message = canonicalMessages[index];
      if (message.role === "tool") resultIndex.set(message.toolCallId, index);
    }
    return evidence.map((item) => {
      const compacted = (resultIndex.get(item.toolCallId) ?? Number.POSITIVE_INFINITY) < this.firstKeptMessageIndex;
      const pruned = this.prunedToolResults.get(item.toolCallId);
      if (!compacted && pruned === undefined) return item;
      const sha256 = pruned?.sha256 ?? digest(item.result);
      const originalCharacters = pruned?.originalCharacters ?? item.result.length;
      return {
        ...item,
        result: [
          `[Tool result omitted from assessment projection; toolCallId=${item.toolCallId};`,
          `sha256=${sha256}; originalCharacters=${originalCharacters};`,
          `canonical evidence remains persisted${compacted ? `; contextEpoch=${this.contextEpoch}` : ""}]`,
        ].join(" "),
      };
    });
  }

  private buildProjection(canonicalMessages: readonly ModelMessage[]): ModelMessage[] {
    const tail = canonicalMessages.slice(this.firstKeptMessageIndex).map((message) => {
      if (message.role !== "tool") return message;
      const pruned = this.prunedToolResults.get(message.toolCallId);
      if (pruned === undefined) return message;
      return { ...message, content: prunedToolMarker(pruned) };
    });
    return tail;
  }

  private pruneOldToolOutputs(
    canonicalMessages: readonly ModelMessage[],
    tools: readonly ModelToolDefinition[],
    runtimeContext: RuntimeContextSnapshot,
    usableInputTokens: number,
  ): PrunedToolResult[] {
    const protectedStart = recentProtectionStart(
      canonicalMessages,
      this.firstKeptMessageIndex,
      this.policy.pruneProtectTokens,
    );
    let current = this.estimateInvocationTokens(tools, runtimeContext, this.buildProjection(canonicalMessages));
    const newlyPruned: PrunedToolResult[] = [];
    for (
      let index = this.firstKeptMessageIndex;
      index < protectedStart && current > usableInputTokens;
      index += 1
    ) {
      const message = canonicalMessages[index];
      if (
        message.role !== "tool"
        || message.name === "load_skill"
        || message.isError
        || this.prunedToolResults.has(message.toolCallId)
      ) continue;
      const record: PrunedToolResult = {
        toolCallId: message.toolCallId,
        toolName: message.name,
        originalCharacters: message.content.length,
        sha256: digest(message.content),
      };
      this.prunedToolResults.set(message.toolCallId, record);
      newlyPruned.push(record);
      const next = this.estimateInvocationTokens(tools, runtimeContext, this.buildProjection(canonicalMessages));
      if (next >= current) {
        this.prunedToolResults.delete(message.toolCallId);
        newlyPruned.pop();
        continue;
      }
      current = next;
    }
    return newlyPruned;
  }

  private async compact(
    canonicalMessages: readonly ModelMessage[],
    tools: readonly ModelToolDefinition[],
    runtimeContext: RuntimeContextSnapshot,
    estimatedTokensBefore: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const tailStart = this.selectTailStart(canonicalMessages, tools, runtimeContext);
    if (tailStart === undefined || tailStart <= this.firstKeptMessageIndex) return false;
    const oldFirstKept = this.firstKeptMessageIndex;
    const activeBefore = this.activeSkillNames(canonicalMessages);
    const messagesToSummarize = canonicalMessages.slice(oldFirstKept, tailStart);
    await this.emitEvent({
      type: "context.compaction.started",
      data: {
        contextEpoch: this.contextEpoch + 1,
        estimatedTokensBefore,
        summarizeFromMessageIndex: oldFirstKept,
        summarizeToMessageIndexExclusive: tailStart,
        firstKeptMessageIndex: tailStart,
      },
    });
    const summaryResult = await this.generateSummary(messagesToSummarize, signal);
    this.firstKeptMessageIndex = tailStart;
    this.contextEpoch += 1;
    this.summary = summaryResult.summary;
    this.invalidateSnapshot();
    const activeAfter = this.activeSkillNames(canonicalMessages);
    const expiredSkillNames = [...activeBefore].filter((name) => !activeAfter.has(name));
    for (const name of expiredSkillNames) {
      await this.emitEvent({
        type: "skill.activation.expired",
        data: { name, contextEpoch: this.contextEpoch, reason: "load_skill_result_compacted" },
      });
    }
    const compactedToolCallIds = messagesToSummarize
      .filter((message): message is Extract<ModelMessage, { role: "tool" }> => message.role === "tool")
      .map((message) => message.toolCallId);
    const projected = this.buildProjection(canonicalMessages);
    const estimatedTokensAfter = this.estimateInvocationTokens(tools, this.currentRuntimeContext(), projected);
    await this.emitEvent({
      type: "context.compacted",
      data: {
        contextEpoch: this.contextEpoch,
        estimatedTokensBefore,
        estimatedTokensAfter,
        firstKeptMessageIndex: this.firstKeptMessageIndex,
        summary: this.summary,
        summarySha256: digest(this.summary),
        compactedToolCallIds,
        expiredSkillNames,
        usage: summaryResult.usage,
      },
    });
    return true;
  }

  private selectTailStart(
    canonicalMessages: readonly ModelMessage[],
    tools: readonly ModelToolDefinition[],
    runtimeContext: RuntimeContextSnapshot,
  ): number | undefined {
    const usable = this.policy.contextWindowTokens
      - this.policy.outputReserveTokens
      - this.policy.safetyMarginTokens;
    const baseInputTokens = this.estimateInvocationTokens(tools, runtimeContext, []);
    const anchorTokens = baseInputTokens
      + this.policy.summaryMaxOutputTokens
      + 256;
    const tailBudget = Math.max(
      1_000,
      Math.min(this.policy.preserveRecentTokens, Math.floor((usable - anchorTokens) * 0.8)),
    );
    if (tailBudget <= 0) return undefined;
    const candidates: number[] = [];
    for (let index = this.firstKeptMessageIndex + 1; index < canonicalMessages.length; index += 1) {
      if (canonicalMessages[index].role !== "tool") candidates.push(index);
    }
    // A completion candidate can itself be larger than the entire retained
    // tail budget. It is still a completed exchange, so the structured
    // summary is the correct projection rather than failing the next turn or
    // retaining an over-budget synthetic tail. The canonical transcript and
    // assessment evidence retain the original candidate; this only selects an
    // empty provider-transcript tail after it has been summarized.
    candidates.push(canonicalMessages.length);
    for (const index of candidates) {
      const tail = canonicalMessages.slice(index).map((message) => {
        if (message.role !== "tool") return message;
        const pruned = this.prunedToolResults.get(message.toolCallId);
        return pruned === undefined ? message : { ...message, content: prunedToolMarker(pruned) };
      });
      const tailTokens = this.estimateInvocationTokens(tools, runtimeContext, tail) - baseInputTokens;
      if (tailTokens <= tailBudget) return index;
    }
    return candidates.at(-1);
  }

  private async generateSummary(
    messages: readonly ModelMessage[],
    signal?: AbortSignal,
  ): Promise<{
    summary: string;
    usage: Readonly<{ inputTokens?: number; outputTokens?: number }>;
  }> {
    const serializedGroups = serializeCompactionGroups(messages, this.policy.summaryToolResultCharacters);
    const inputBudget = this.policy.contextWindowTokens
      - this.policy.outputReserveTokens
      - this.policy.safetyMarginTokens
      - this.policy.summaryMaxOutputTokens
      - estimateTextTokens(SUMMARY_SYSTEM_PROMPT)
      - estimateTextTokens(SUMMARY_FORMAT)
      - 512;
    const chunks = chunkSerializedGroups(serializedGroups, Math.max(2_000, inputBudget));
    let summary = this.summary;
    let inputTokens = 0;
    let outputTokens = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const prompt = [
        summary === undefined ? "" : `<previous_summary>\n${summary}\n</previous_summary>`,
        `<conversation>\n${chunks[index]}\n</conversation>`,
        SUMMARY_FORMAT,
      ].filter(Boolean).join("\n\n");
      const response = await this.model.complete({
        runId: `${this.runId}:context-compaction:${this.contextEpoch + 1}:${index + 1}`,
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        phase: "compaction",
        runtimeContext: {
          id: `${this.runId}:compaction:${this.contextEpoch + 1}:${index + 1}`,
          phase: "compaction",
          content: "Summarize only the supplied canonical conversation for the Runtime context projection.",
        },
        messages: [{ role: "user", content: prompt }],
        tools: [],
        maxOutputTokens: this.policy.summaryMaxOutputTokens,
      }, signal);
      if (response.finishReason !== "stop" || response.toolCalls.length > 0 || response.content.trim().length === 0) {
        throw contextBudgetError("Context summarizer did not return a complete structured summary", {
          finishReason: response.finishReason,
          toolCallCount: response.toolCalls.length,
          chunk: index + 1,
          chunkCount: chunks.length,
        });
      }
      summary = response.content.trim();
      inputTokens += response.usage?.inputTokens ?? 0;
      outputTokens += response.usage?.outputTokens ?? 0;
    }
    if (summary === undefined) throw contextBudgetError("Context compaction had no summarizable messages");
    const compactedSummary = await this.reducePersistedSummary(summary, signal);
    inputTokens += compactedSummary.usage.inputTokens;
    outputTokens += compactedSummary.usage.outputTokens;
    return { summary: compactedSummary.summary, usage: { inputTokens, outputTokens } };
  }

  private async reducePersistedSummary(
    initialSummary: string,
    signal?: AbortSignal,
  ): Promise<{
    summary: string;
    usage: Readonly<{ inputTokens: number; outputTokens: number }>;
  }> {
    let summary = initialSummary;
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 0; estimateTextTokens(summary) > this.policy.persistedSummaryMaxTokens && attempt < 2; attempt += 1) {
      const response = await this.model.complete({
        runId: `${this.runId}:context-summary-reduction:${this.contextEpoch + 1}:${attempt + 1}`,
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        phase: "compaction",
        runtimeContext: {
          id: `${this.runId}:context-summary-reduction:${this.contextEpoch + 1}:${attempt + 1}`,
          phase: "compaction",
          content: "Reduce only the supplied Runtime context summary without adding facts.",
        },
        messages: [{
          role: "user",
          content: [
            "Rewrite this existing structured summary without adding any facts.",
            `The entire replacement must be at most ${this.policy.persistedSummaryMaxTokens} estimated tokens.`,
            "Keep the exact structure, exact identifiers, paths, hashes, errors, constraints, and next action; remove repetition and explanatory prose first.",
            `<summary_to_reduce>\n${summary}\n</summary_to_reduce>`,
            SUMMARY_FORMAT,
          ].join("\n\n"),
        }],
        tools: [],
        maxOutputTokens: this.policy.summaryMaxOutputTokens,
      }, signal);
      if (response.finishReason !== "stop" || response.toolCalls.length > 0 || response.content.trim().length === 0) {
        throw contextBudgetError("Context summary reduction did not return a complete structured summary", {
          finishReason: response.finishReason,
          toolCallCount: response.toolCalls.length,
          attempt: attempt + 1,
        });
      }
      summary = response.content.trim();
      inputTokens += response.usage?.inputTokens ?? 0;
      outputTokens += response.usage?.outputTokens ?? 0;
    }
    if (estimateTextTokens(summary) > this.policy.persistedSummaryMaxTokens) {
      throw contextBudgetError("Context summary exceeds the persisted summary budget", {
        estimatedSummaryTokens: estimateTextTokens(summary),
        persistedSummaryMaxTokens: this.policy.persistedSummaryMaxTokens,
      });
    }
    return { summary, usage: { inputTokens, outputTokens } };
  }

  private async emitEvent(event: RuntimeEvent): Promise<void> {
    await this.emit?.(event);
  }

  private estimateInvocationTokens(
    tools: readonly ModelToolDefinition[],
    runtimeContext: RuntimeContextSnapshot,
    messages: readonly ModelMessage[],
  ): number {
    const invocation: ModelInvocation = {
      runId: this.runId,
      systemPrompt: this.systemPrompt,
      phase: runtimeContext.phase,
      runtimeContext,
      messages,
      tools,
    };
    const providerEstimate = this.model.estimateInputTokens?.(invocation);
    if (providerEstimate !== undefined) {
      if (!Number.isSafeInteger(providerEstimate) || providerEstimate < 1) {
        throw new TypeError("Model adapter returned an invalid input-token estimate");
      }
      return providerEstimate;
    }
    return estimateTextTokens(this.systemPrompt)
      + estimateTextTokens(runtimeContext.content)
      + estimateToolDefinitions(tools)
      + estimateMessages(messages);
  }

  private currentRuntimeContext(): RuntimeContextSnapshot {
    if (this.snapshot !== undefined) return this.snapshot;
    const id = `${this.runId}:${this.runtimeContextBase.phase}:context:${this.contextEpoch}:${this.contextRevision}`;
    const content = [
      this.runtimeContextBase.content,
      ...(this.summary === undefined ? [] : [
        "<structured_summary>",
        this.summary,
        "</structured_summary>",
        "<skill_disclosure_rule>",
        "The summary never substitutes for exact Skill instructions. Reload every required Skill whose load_skill result is absent from the recent transcript tail.",
        "</skill_disclosure_rule>",
      ]),
      ...(this.runtimeDirective === undefined ? [] : [
        "<runtime_directive>",
        this.runtimeDirective,
        "</runtime_directive>",
      ]),
    ].join("\n");
    this.snapshot = {
      id,
      phase: this.runtimeContextBase.phase,
      content,
      ...(this.previousSnapshotId === undefined ? {} : { supersedesId: this.previousSnapshotId }),
    };
    this.previousSnapshotId = id;
    return this.snapshot;
  }

  private invalidateSnapshot(): void {
    this.snapshot = undefined;
  }
}

export function estimateTextTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii));
}

function resolvePolicy(model: ModelAdapter, input: ContextPolicy | undefined): ResolvedContextPolicy {
  const contextWindowTokens = model.limits.contextWindowTokens;
  const requestedReserve = input?.outputReserveTokens ?? Math.max(16_384, model.limits.maxOutputTokens);
  const outputReserveTokens = Math.min(requestedReserve, Math.floor(contextWindowTokens * 0.5));
  const safetyMarginTokens = input?.safetyMarginTokens ?? Math.min(4_096, Math.floor(contextWindowTokens * 0.1));
  const usable = contextWindowTokens - outputReserveTokens - safetyMarginTokens;
  if (usable < 2_000) throw new TypeError("Model limits leave fewer than 2000 usable input tokens");
  const preserveRecentTokens = input?.preserveRecentTokens
    ?? Math.min(20_000, Math.max(2_000, Math.floor(usable * 0.25)));
  const pruneProtectTokens = input?.pruneProtectTokens ?? preserveRecentTokens;
  const summaryMaxOutputTokens = input?.summaryMaxOutputTokens
    ?? Math.min(8_192, model.limits.maxOutputTokens);
  const persistedSummaryMaxTokens = Math.max(1_000, Math.min(2_000, Math.floor(usable * 0.2)));
  const summaryToolResultCharacters = input?.summaryToolResultCharacters ?? 2_000;
  for (const [name, value] of Object.entries({
    outputReserveTokens,
    safetyMarginTokens,
    preserveRecentTokens,
    pruneProtectTokens,
    summaryMaxOutputTokens,
    persistedSummaryMaxTokens,
    summaryToolResultCharacters,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  }
  return {
    contextWindowTokens,
    outputReserveTokens,
    safetyMarginTokens,
    preserveRecentTokens,
    pruneProtectTokens,
    summaryMaxOutputTokens,
    persistedSummaryMaxTokens,
    summaryToolResultCharacters,
  };
}

function estimateToolDefinitions(tools: readonly ModelToolDefinition[]): number {
  return estimateTextTokens(JSON.stringify(tools)) + tools.length * 8;
}

function estimateMessages(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessage(message), 0);
}

function estimateMessage(message: ModelMessage): number {
  if (message.role === "assistant") {
    return 8 + estimateTextTokens(message.content) + estimateTextTokens(JSON.stringify(message.toolCalls ?? []));
  }
  return 8 + estimateTextTokens(message.content);
}

function recentProtectionStart(
  messages: readonly ModelMessage[],
  firstKeptMessageIndex: number,
  protectedTokens: number,
): number {
  let total = 0;
  for (let index = messages.length - 1; index >= firstKeptMessageIndex; index -= 1) {
    total += estimateMessage(messages[index]);
    if (total >= protectedTokens) return index;
  }
  return firstKeptMessageIndex;
}

function serializeCompactionGroups(messages: readonly ModelMessage[], toolResultLimit: number): string[] {
  const groups: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === "tool" && groups.length > 0) groups[groups.length - 1].push(message);
    else groups.push([message]);
  }
  return groups.map((group) => group.map((message) => serializeForSummary(message, toolResultLimit)).join("\n"));
}

function serializeForSummary(message: ModelMessage, toolResultLimit: number): string {
  if (message.role === "user") return `[User]: ${truncateForSummary(message.content, 8_000)}`;
  if (message.role === "assistant") {
    const calls = (message.toolCalls ?? []).map((call) =>
      `${call.name}(${truncateForSummary(JSON.stringify(call.arguments), 2_000)}) [id=${call.id}]`
    );
    return [
      message.content ? `[Assistant]: ${truncateForSummary(message.content, 8_000)}` : "",
      calls.length === 0 ? "" : `[Assistant tool calls]: ${calls.join("; ")}`,
    ].filter(Boolean).join("\n");
  }
  if (message.name === "load_skill") {
    return `[Tool result load_skill id=${message.toolCallId}]: Exact Skill body omitted from compaction input; reload after compaction; sha256=${digest(message.content)}; characters=${message.content.length}`;
  }
  return `[Tool ${message.isError ? "error" : "result"} ${message.name} id=${message.toolCallId}]: ${truncateForSummary(message.content, toolResultLimit)}`;
}

function chunkSerializedGroups(groups: readonly string[], maxTokens: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const originalGroup of groups) {
    const originalTokens = estimateTextTokens(originalGroup);
    const group = originalTokens <= maxTokens
      ? originalGroup
      : truncateForSummary(originalGroup, Math.max(1_000, maxTokens * 3));
    const tokens = estimateTextTokens(group);
    if (current.length > 0 && currentTokens + tokens > maxTokens) {
      chunks.push(current.join("\n\n"));
      current = [];
      currentTokens = 0;
    }
    current.push(group);
    currentTokens += tokens;
  }
  if (current.length > 0) chunks.push(current.join("\n\n"));
  return chunks.length === 0 ? ["[No conversation messages]"] : chunks;
}

function truncateForSummary(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n[truncated ${value.length - maximum} characters; sha256=${digest(value)}]`;
}

function prunedToolMarker(record: PrunedToolResult): string {
  return `[Old tool result removed from model projection; tool=${record.toolName}; toolCallId=${record.toolCallId}; originalCharacters=${record.originalCharacters}; sha256=${record.sha256}; canonical event retained]`;
}

function skillNameFromArguments(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" ? name : undefined;
}

function assertClosedToolProtocol(messages: readonly ModelMessage[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        if (pending.has(call.id)) throw contextBudgetError(`Duplicate ToolCall ID in context: ${call.id}`);
        pending.add(call.id);
      }
      continue;
    }
    if (message.role !== "tool") continue;
    if (!pending.delete(message.toolCallId)) {
      throw contextBudgetError(`ToolResult has no matching ToolCall: ${message.toolCallId}`);
    }
  }
  if (pending.size > 0) {
    throw contextBudgetError("Model context contains ToolCalls without results", {
      pendingToolCallIds: [...pending],
    });
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function contextBudgetError(message: string, details?: Readonly<Record<string, unknown>>): AppError {
  return new AppError("MODEL_ERROR", message, 502, details);
}
