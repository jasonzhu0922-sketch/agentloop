import { createHash } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import { ARTIFACT_RECEIPT_SCHEMA, CONTEXT_ARTIFACT_PROJECTION_SCHEMA } from "./artifact-receipt.ts";
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
  readonly proactiveCompactionTokens?: number;
  readonly deferProactiveCompactionForArtifactEvidence?: boolean;
  readonly preserveRecentTokens?: number;
  readonly pruneProtectTokens?: number;
  readonly summaryMaxOutputTokens?: number;
  readonly summaryToolResultCharacters?: number;
  readonly largeToolResultProjectionCharacters?: number;
  readonly largeToolResultPreviewCharacters?: number;
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
  readonly proactiveCompactionTokens: number;
  readonly deferProactiveCompactionForArtifactEvidence: boolean;
  readonly preserveRecentTokens: number;
  readonly pruneProtectTokens: number;
  readonly summaryMaxOutputTokens: number;
  readonly persistedSummaryMaxTokens: number;
  readonly summaryToolResultCharacters: number;
  readonly largeToolResultProjectionCharacters: number;
  readonly largeToolResultPreviewCharacters: number;
}

interface PrunedToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly originalCharacters: number;
  readonly sha256: string;
  readonly reason: "budget" | "large_tool_result" | "structured_evidence" | "structured_tool_result";
  readonly preview?: string;
  readonly previewCharacters?: number;
  readonly structuredEvidence?: string;
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

function summaryInstructions(maxEstimatedTokens: number): string {
  return [
    `The complete replacement summary must be at most ${maxEstimatedTokens} estimated tokens.`,
    "Prefer short bullets. Preserve durable facts, exact identifiers, paths, hashes, errors, constraints, and next actions; omit repetitive raw rows after listing their canonical ToolCall IDs and hashes.",
    SUMMARY_FORMAT,
  ].join("\n\n");
}

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
      if (this.prunedToolResults.has(message.toolCallId)) continue;
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

    const newlyStructured = this.projectStructuredEvidenceToolResults(canonicalMessages);
    if (newlyStructured.length > 0) {
      await this.emitEvent({
        type: "context.tool_outputs_projected",
        data: {
          contextEpoch: this.contextEpoch,
          reason: "structured_evidence",
          toolResults: newlyStructured,
        },
      });
    }

    const newlyStructuredResults = this.projectStructuredToolResults(canonicalMessages);
    if (newlyStructuredResults.length > 0) {
      await this.emitEvent({
        type: "context.tool_outputs_projected",
        data: {
          contextEpoch: this.contextEpoch,
          reason: "structured_tool_result",
          toolResults: newlyStructuredResults,
        },
      });
    }

    const newlyProjected = this.projectLargeToolResults(canonicalMessages);
    if (newlyProjected.length > 0) {
      await this.emitEvent({
        type: "context.tool_outputs_projected",
        data: {
          contextEpoch: this.contextEpoch,
          thresholdCharacters: this.policy.largeToolResultProjectionCharacters,
          previewCharacters: this.policy.largeToolResultPreviewCharacters,
          toolResults: newlyProjected,
        },
      });
    }

    let projection = this.buildProjection(canonicalMessages);
    let estimatedInputTokens = this.estimateInvocationTokens(tools, runtimeContext, projection);
    if (estimatedInputTokens > this.policy.proactiveCompactionTokens) {
      const beforePrune = estimatedInputTokens;
      const newlyPruned = this.pruneOldToolOutputs(
        canonicalMessages,
        tools,
        runtimeContext,
        Math.min(usableInputTokens, this.policy.proactiveCompactionTokens),
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
    const targetInputTokens = Math.min(usableInputTokens, this.policy.proactiveCompactionTokens);
    const artifactEvidenceWithinWindow = hasArtifactEvidenceBoundary(canonicalMessages, this.firstKeptMessageIndex);
    const loadedSkillWithinWindow = hasUnprunedLoadedSkillResult(
      canonicalMessages,
      this.firstKeptMessageIndex,
      this.prunedToolResults,
    );
    const deferProactiveCompaction = estimatedInputTokens > targetInputTokens
      && estimatedInputTokens <= usableInputTokens
      && this.policy.deferProactiveCompactionForArtifactEvidence
      && (artifactEvidenceWithinWindow || loadedSkillWithinWindow);
    if (deferProactiveCompaction) {
      await this.emitEvent({
        type: "context.compaction.skipped",
        data: {
          contextEpoch: this.contextEpoch,
          estimatedInputTokens,
          usableInputTokens,
          targetInputTokens,
          reason: artifactEvidenceWithinWindow
            ? "artifact_evidence_within_usable_window"
            : "loaded_skill_within_usable_window",
        },
      });
    }
    while (!deferProactiveCompaction && estimatedInputTokens > targetInputTokens && compactions < 3) {
      let compacted = false;
      try {
        compacted = await this.compact(canonicalMessages, tools, runtimeContext, estimatedInputTokens, signal);
      } catch (error) {
        if (estimatedInputTokens > usableInputTokens) throw error;
        await this.emitEvent({
          type: "context.compaction.skipped",
          data: {
            contextEpoch: this.contextEpoch,
            estimatedInputTokens,
            usableInputTokens,
            targetInputTokens,
            reason: "nonessential_compaction_failed",
            ...errorEventDetails(error),
          },
        });
        break;
      }
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
      if (pruned?.structuredEvidence !== undefined) {
        return {
          ...item,
          result: prunedToolMarker(pruned),
        };
      }
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
    return this.buildProjectionFrom(canonicalMessages, this.firstKeptMessageIndex);
  }

  private buildProjectionFrom(canonicalMessages: readonly ModelMessage[], startIndex: number): ModelMessage[] {
    const artifactArgumentProjections = artifactToolCallArgumentProjections(canonicalMessages, startIndex);
    const tail = canonicalMessages.slice(startIndex).map((message) => {
      if (message.role === "assistant") {
        return projectAssistantToolCallArguments(message, artifactArgumentProjections);
      }
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
        reason: "budget",
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

  private projectLargeToolResults(canonicalMessages: readonly ModelMessage[]): PrunedToolResult[] {
    const newlyProjected: PrunedToolResult[] = [];
    for (let index = this.firstKeptMessageIndex; index < canonicalMessages.length; index += 1) {
      const message = canonicalMessages[index];
      if (
        message.role !== "tool"
        || message.name === "load_skill"
        || message.isError
        || message.content.length <= this.policy.largeToolResultProjectionCharacters
        || this.prunedToolResults.has(message.toolCallId)
      ) continue;
      const structuredEvidence = structuredToolResultProjection(message.name, message.content);
      if (structuredEvidence !== undefined) {
        const record: PrunedToolResult = {
          toolCallId: message.toolCallId,
          toolName: message.name,
          originalCharacters: message.content.length,
          sha256: digest(message.content),
          reason: "structured_tool_result",
          structuredEvidence,
        };
        this.prunedToolResults.set(message.toolCallId, record);
        newlyProjected.push(record);
        continue;
      }
      const preview = message.content.slice(0, this.policy.largeToolResultPreviewCharacters);
      const record: PrunedToolResult = {
        toolCallId: message.toolCallId,
        toolName: message.name,
        originalCharacters: message.content.length,
        sha256: digest(message.content),
        reason: "large_tool_result",
        preview,
        previewCharacters: preview.length,
      };
      this.prunedToolResults.set(message.toolCallId, record);
      newlyProjected.push(record);
    }
    return newlyProjected;
  }

  private projectStructuredToolResults(canonicalMessages: readonly ModelMessage[]): PrunedToolResult[] {
    const newlyProjected: PrunedToolResult[] = [];
    for (let index = this.firstKeptMessageIndex; index < canonicalMessages.length; index += 1) {
      const message = canonicalMessages[index];
      if (
        message.role !== "tool"
        || message.name === "load_skill"
        || message.isError
        || this.prunedToolResults.has(message.toolCallId)
      ) continue;
      const structuredEvidence = structuredToolResultProjection(message.name, message.content);
      if (structuredEvidence === undefined) continue;
      const record: PrunedToolResult = {
        toolCallId: message.toolCallId,
        toolName: message.name,
        originalCharacters: message.content.length,
        sha256: digest(message.content),
        reason: "structured_tool_result",
        structuredEvidence,
      };
      this.prunedToolResults.set(message.toolCallId, record);
      newlyProjected.push(record);
    }
    return newlyProjected;
  }

  private projectStructuredEvidenceToolResults(canonicalMessages: readonly ModelMessage[]): PrunedToolResult[] {
    const newlyProjected: PrunedToolResult[] = [];
    for (let index = this.firstKeptMessageIndex; index < canonicalMessages.length; index += 1) {
      const message = canonicalMessages[index];
      if (
        message.role !== "tool"
        || message.name === "load_skill"
        || message.isError
        || this.prunedToolResults.has(message.toolCallId)
      ) continue;
      const structuredEvidence = structuredToolEvidenceProjection(message.content);
      if (structuredEvidence === undefined) continue;
      const record: PrunedToolResult = {
        toolCallId: message.toolCallId,
        toolName: message.name,
        originalCharacters: message.content.length,
        sha256: digest(message.content),
        reason: "structured_evidence",
        structuredEvidence,
      };
      this.prunedToolResults.set(message.toolCallId, record);
      newlyProjected.push(record);
    }
    return newlyProjected;
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
      const tail = this.buildProjectionFrom(canonicalMessages, index);
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
    const instructions = summaryInstructions(this.policy.persistedSummaryMaxTokens);
    const inputBudget = this.policy.contextWindowTokens
      - this.policy.outputReserveTokens
      - this.policy.safetyMarginTokens
      - this.policy.summaryMaxOutputTokens
      - estimateTextTokens(SUMMARY_SYSTEM_PROMPT)
      - estimateTextTokens(instructions)
      - 512;
    const chunks = chunkSerializedGroups(serializedGroups, Math.max(2_000, inputBudget));
    let summary = this.summary;
    let inputTokens = 0;
    let outputTokens = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      let accepted = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const prompt = [
          attempt === 0 ? "" : [
            "The previous summarization attempt exceeded the output limit and was discarded.",
            "Return a complete, shorter replacement summary within the stated budget.",
            "Do not continue the task, do not mention this retry, and do not copy repetitive raw rows.",
          ].join(" "),
          summary === undefined ? "" : `<previous_summary>\n${summary}\n</previous_summary>`,
          `<conversation>\n${chunks[index]}\n</conversation>`,
          instructions,
        ].filter(Boolean).join("\n\n");
        const response = await this.model.complete({
          runId: `${this.runId}:context-compaction:${this.contextEpoch + 1}:${index + 1}:${attempt + 1}`,
          systemPrompt: SUMMARY_SYSTEM_PROMPT,
          phase: "compaction",
          runtimeContext: {
            id: `${this.runId}:compaction:${this.contextEpoch + 1}:${index + 1}:${attempt + 1}`,
            phase: "compaction",
            content: "Summarize only the supplied canonical conversation for the Runtime context projection.",
          },
          messages: [{ role: "user", content: prompt }],
          tools: [],
          maxOutputTokens: this.policy.summaryMaxOutputTokens,
        }, signal);
        inputTokens += response.usage?.inputTokens ?? 0;
        outputTokens += response.usage?.outputTokens ?? 0;
        if (response.finishReason === "stop" && response.toolCalls.length === 0 && response.content.trim().length > 0) {
          summary = response.content.trim();
          accepted = true;
          break;
        }
        if (response.finishReason !== "length" || attempt === 1) {
          throw contextBudgetError("Context summarizer did not return a complete structured summary", {
            finishReason: response.finishReason,
            toolCallCount: response.toolCalls.length,
            chunk: index + 1,
            chunkCount: chunks.length,
            attempt: attempt + 1,
          });
        }
      }
      if (!accepted) throw contextBudgetError("Context compaction had no accepted summary", {
        chunk: index + 1,
        chunkCount: chunks.length,
      });
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
    const instructions = summaryInstructions(this.policy.persistedSummaryMaxTokens);
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
            instructions,
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
        "The summary never substitutes for exact Skill instructions. Reload any Skill you intend to continue applying when its load_skill result is absent from the recent transcript tail.",
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
  const proactiveCompactionTokens = Math.min(input?.proactiveCompactionTokens ?? usable, usable);
  const deferProactiveCompactionForArtifactEvidence = input?.deferProactiveCompactionForArtifactEvidence ?? true;
  const preserveRecentTokens = input?.preserveRecentTokens
    ?? Math.min(20_000, Math.max(2_000, Math.floor(usable * 0.25)));
  const pruneProtectTokens = input?.pruneProtectTokens ?? preserveRecentTokens;
  const summaryMaxOutputTokens = input?.summaryMaxOutputTokens
    ?? Math.min(8_192, model.limits.maxOutputTokens);
  const persistedSummaryMaxTokens = Math.max(1_000, Math.min(2_000, Math.floor(usable * 0.2)));
  const summaryToolResultCharacters = input?.summaryToolResultCharacters ?? 2_000;
  const largeToolResultProjectionCharacters = input?.largeToolResultProjectionCharacters ?? 16_000;
  const largeToolResultPreviewCharacters = input?.largeToolResultPreviewCharacters ?? 2_000;
  for (const [name, value] of Object.entries({
    outputReserveTokens,
    safetyMarginTokens,
    proactiveCompactionTokens,
    preserveRecentTokens,
    pruneProtectTokens,
    summaryMaxOutputTokens,
    persistedSummaryMaxTokens,
    summaryToolResultCharacters,
    largeToolResultProjectionCharacters,
    largeToolResultPreviewCharacters,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  }
  if (largeToolResultPreviewCharacters > largeToolResultProjectionCharacters) {
    throw new TypeError("largeToolResultPreviewCharacters must not exceed largeToolResultProjectionCharacters");
  }
  return {
    contextWindowTokens,
    outputReserveTokens,
    safetyMarginTokens,
    proactiveCompactionTokens,
    deferProactiveCompactionForArtifactEvidence,
    preserveRecentTokens,
    pruneProtectTokens,
    summaryMaxOutputTokens,
    persistedSummaryMaxTokens,
    summaryToolResultCharacters,
    largeToolResultProjectionCharacters,
    largeToolResultPreviewCharacters,
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
  const structuredEvidence = structuredToolEvidenceProjection(message.content);
  if (structuredEvidence !== undefined) {
    return `[Tool evidence receipt ${message.name} id=${message.toolCallId}]: ${structuredToolEvidenceLedger(message.content) ?? structuredEvidence}`;
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
  if (record.structuredEvidence !== undefined) {
    const label = record.reason === "structured_tool_result"
      ? "structured projection"
      : "structured evidence";
    return [
      record.structuredEvidence,
      `[Tool result projected as ${label}; tool=${record.toolName}; toolCallId=${record.toolCallId}; originalCharacters=${record.originalCharacters}; sha256=${record.sha256}; canonical event retained]`,
    ].join("\n\n");
  }
  const marker = record.reason === "large_tool_result"
    ? `[Large tool result projected for model context; tool=${record.toolName}; toolCallId=${record.toolCallId}; originalCharacters=${record.originalCharacters}; previewCharacters=${record.previewCharacters ?? 0}; sha256=${record.sha256}; canonical event retained]`
    : `[Old tool result removed from model projection; tool=${record.toolName}; toolCallId=${record.toolCallId}; originalCharacters=${record.originalCharacters}; sha256=${record.sha256}; canonical event retained]`;
  return record.preview === undefined ? marker : `${record.preview}\n\n${marker}`;
}

function structuredToolEvidenceProjection(content: string): string | undefined {
  const value = parseJsonRecord(content);
  if (value === undefined) return undefined;
  const receipt = recordValue(value.evidenceReceipt);
  if (receipt === undefined) return undefined;
  const sourceRefs = Array.isArray(receipt.sourceRefs) ? receipt.sourceRefs : [];
  const facts = Array.isArray(receipt.facts) ? receipt.facts : [];
  const sourceType = stringValue(receipt.sourceType);
  const sourceSchema = stringValue(value.sourceSchema) ?? stringValue(value.schema);
  const sourceRefLimit = sourceRefProjectionLimit(sourceType, sourceSchema);
  const uploadedSource = sourceType === "uploaded_source" ? uploadedSourceProjection(value) : undefined;
  const contentLocation = commandOutputContentLocationProjection(value);
  const projection = {
    schema: "agentloop.contextEvidenceProjection/v1",
    sourceSchema,
    requested: numberValue(value.requested),
    returned: numberValue(value.returned),
    truncated: booleanValue(value.truncated),
    maxTotalCharacters: numberValue(value.maxTotalCharacters),
    uploadedSource,
    contentLocation,
    evidenceReceipt: {
      schema: stringValue(receipt.schema),
      sourceType,
      receiptId: stringValue(receipt.receiptId),
      sourceRefCount: sourceRefs.length,
      factCount: facts.length,
      sourceRefs: sourceRefLimit <= 0 ? undefined : sourceRefs.slice(0, sourceRefLimit).map(compactEvidenceSourceRef),
      facts: facts.slice(0, 24).map(compactEvidenceFactForProjection),
      caveats: compactArray(receipt.caveats, 20),
      evidenceKinds: recordValue(receipt.evidenceKinds),
    },
    instruction: contentLocation !== undefined
      ? "Use the structured evidence first. If exact omitted command output is required, read only the contentLocation path and verify its sha256; do not rerun the same command solely to recover prior output."
      : sourceType === "uploaded_source"
      ? "Use read_source with sourceId, chunkIndex, and maxChunks for uploaded source content; chunkIndex plus maxChunks reads a consecutive window starting at chunkIndex. Uploaded sources are not filesystem paths; do not search upload storage roots or other conversation directories to recover them."
      : "Use these structured facts and sourceRefs. Reread explicit paths/ranges only when exact omitted text is required.",
  };
  return JSON.stringify(omitUndefinedDeep(projection));
}

function commandOutputContentLocationProjection(value: Record<string, unknown>): unknown {
  const location = recordValue(value.contentLocation);
  const stdoutRef = recordValue(value.stdoutRef);
  const stderrRef = recordValue(value.stderrRef);
  const source = location ?? stdoutRef ?? stderrRef;
  if (source === undefined) return undefined;
  const path = stringValue(source.path);
  const sha256 = stringValue(source.sha256);
  if (path === undefined || sha256 === undefined) return undefined;
  return omitUndefinedDeep({
    kind: stringValue(source.kind) ?? "content_addressed",
    stream: stringValue(source.stream),
    path,
    sha256,
    bytes: numberValue(source.bytes),
    characters: numberValue(source.characters),
    previewCharacters: numberValue(source.previewCharacters),
  });
}

const UPLOADED_SOURCE_CONTENT_PROJECTION_LIMIT = 12_000;
const SOURCE_FACT_TEXT_PREVIEW_PROJECTION_LIMIT = 1_200;

function uploadedSourceProjection(value: Record<string, unknown>): unknown {
  const chunks = Array.isArray(value.chunks) ? value.chunks : [];
  let remainingCharacters = UPLOADED_SOURCE_CONTENT_PROJECTION_LIMIT;
  let omittedContentCount = 0;
  const projectedChunks = chunks.slice(0, 12).map((item) => {
    const chunk = recordValue(item);
    if (chunk === undefined) return item;
    const content = stringValue(chunk.content);
    const includeContent = content !== undefined && content.length <= remainingCharacters;
    if (includeContent) remainingCharacters -= content.length;
    else if (content !== undefined) omittedContentCount += 1;
    return omitUndefinedDeep({
      chunkIndex: numberValue(chunk.chunkIndex),
      kind: stringValue(chunk.kind),
      locator: stringValue(chunk.locator),
      sha256: stringValue(chunk.sha256),
      contentCharacters: content?.length,
      contentSha256: content === undefined ? undefined : digest(content),
      content: includeContent ? content : undefined,
      contentOmitted: content === undefined ? undefined : !includeContent,
    });
  });
  return omitUndefinedDeep({
    sourceId: stringValue(value.sourceId),
    originalName: stringValue(value.originalName),
    totalChunks: numberValue(value.totalChunks),
    selectedChunks: numberValue(value.selectedChunks),
    returnedChunks: numberValue(value.returnedChunks),
    truncated: booleanValue(value.truncated),
    chunks: projectedChunks,
    omittedContentCount: omittedContentCount === 0 ? undefined : omittedContentCount,
    contentProjectionLimit: UPLOADED_SOURCE_CONTENT_PROJECTION_LIMIT,
  });
}

function structuredToolResultProjection(toolName: string, content: string): string | undefined {
  const value = parseJsonRecord(content);
  if (value === undefined) return undefined;
  const artifactReceipt = recordValue(value.artifactReceipt);
  if (artifactReceipt !== undefined) {
    return artifactReceiptProjection(artifactReceipt, stringValue(value.schema));
  }
  if (recordValue(value.evidenceReceipt) !== undefined) return undefined;
  const schema = stringValue(value.schema);
  if (schema === "agentloop.paginatedHtmlMaterialization/v1") {
    return paginatedHtmlMaterializationProjection(value);
  }
  if (schema === "agentloop.artifactAcceptance/v1") {
    return artifactAcceptanceProjection(value);
  }
  if (toolName === "computer_write_file") {
    return writtenArtifactProjection(value, toolName);
  }
  if (toolName === "visible_list_directory") return visibleListDirectoryProjection(value);
  return undefined;
}

function artifactToolCallArgumentProjections(
  canonicalMessages: readonly ModelMessage[],
  startIndex: number,
): ReadonlyMap<string, Record<string, unknown>> {
  const projections = new Map<string, Record<string, unknown>>();
  for (let index = startIndex; index < canonicalMessages.length; index += 1) {
    const message = canonicalMessages[index];
    if (message.role !== "tool" || message.isError) continue;
    const projection = artifactToolCallArgumentProjection(message.name, message.content);
    if (projection !== undefined) projections.set(message.toolCallId, projection);
  }
  return projections;
}

function projectAssistantToolCallArguments(
  message: Extract<ModelMessage, { role: "assistant" }>,
  projections: ReadonlyMap<string, Record<string, unknown>>,
): ModelMessage {
  if (message.toolCalls === undefined || message.toolCalls.length === 0) return message;
  let changed = false;
  const toolCalls = message.toolCalls.map((call) => {
    const projection = projections.get(call.id);
    if (projection === undefined) return call;
    changed = true;
    return {
      ...call,
      arguments: artifactToolCallArgumentsProjection(call.name, projection, call.arguments),
    };
  });
  return changed ? { ...message, toolCalls } : message;
}

function artifactToolCallArgumentProjection(toolName: string, content: string): Record<string, unknown> | undefined {
  const value = parseJsonRecord(content);
  if (value === undefined) return undefined;
  const receipt = recordValue(value.artifactReceipt);
  if (receipt === undefined || stringValue(receipt.schema) !== ARTIFACT_RECEIPT_SCHEMA) return undefined;
  const artifact = recordValue(receipt.artifact);
  if (artifact === undefined) return undefined;
  const inspection = recordValue(receipt.inspection);
  const projection = omitUndefinedDeep({
    schema: "agentloop.contextArtifactToolCallArguments/v1",
    sourceSchema: stringValue(value.schema),
    successfulArtifactWrite: true,
    receiptId: stringValue(receipt.receiptId),
    sourceTool: stringValue(receipt.sourceTool) ?? toolName,
    artifact: compactArtifactReceiptArtifact(artifact),
    inspection: inspection === undefined ? undefined : compactArtifactReceiptInspection(inspection),
    evidenceKinds: recordValue(receipt.evidenceKinds),
    instruction: "Original artifact content arguments are omitted from this model-context projection after a successful write. Use artifact receipt fields; if artifact acceptance is still missing, verify the artifact instead of rereading the same path.",
  });
  return recordValue(projection);
}

function artifactToolCallArgumentsProjection(
  toolName: string,
  projection: Record<string, unknown>,
  originalArguments: unknown,
): Record<string, unknown> {
  const serializedArguments = JSON.stringify(originalArguments ?? null);
  const originalRecord = recordValue(originalArguments);
  const originalContent = stringValue(originalRecord?.content);
  const projectedMetadata = omitUndefinedDeep({
    ...projection,
    originalArguments: {
      sha256: digest(serializedArguments),
      characters: serializedArguments.length,
      contentCharacters: originalContent?.length,
      contentSha256: originalContent === undefined ? undefined : digest(originalContent),
      omittedFields: originalContent === undefined ? undefined : ["content"],
      canonicalArgumentsPersisted: true,
    },
  }) as Record<string, unknown>;
  if (toolName !== "computer_write_file") return projectedMetadata;
  const artifact = recordValue(projection.artifact);
  return omitUndefinedDeep({
    path: stringValue(originalRecord?.path) ?? stringValue(artifact?.path),
    mode: stringValue(originalRecord?.mode),
    content: "[Historical successful artifact write content omitted from model context. Use the following tool result artifact receipt as evidence; do not reuse this historical tool call as new input.]",
  }) as Record<string, unknown>;
}

function hasArtifactEvidenceBoundary(
  canonicalMessages: readonly ModelMessage[],
  firstKeptMessageIndex: number,
): boolean {
  for (let index = canonicalMessages.length - 1; index >= firstKeptMessageIndex; index -= 1) {
    const message = canonicalMessages[index];
    if (message.role !== "tool" || message.isError) continue;
    const value = parseJsonRecord(message.content);
    if (value === undefined) continue;
    if (recordValue(value.artifactReceipt) !== undefined) return true;
    const schema = stringValue(value.schema);
    if (schema === "agentloop.artifactAcceptance/v1" || schema === "agentloop.paginatedHtmlMaterialization/v1") {
      return true;
    }
    if (
      message.name === "computer_write_file"
      && stringValue(value.path) !== undefined
      && stringValue(value.sha256) !== undefined
    ) {
      return true;
    }
  }
  return false;
}

function hasUnprunedLoadedSkillResult(
  canonicalMessages: readonly ModelMessage[],
  firstKeptMessageIndex: number,
  prunedToolResults: ReadonlyMap<string, PrunedToolResult>,
): boolean {
  for (let index = canonicalMessages.length - 1; index >= firstKeptMessageIndex; index -= 1) {
    const message = canonicalMessages[index];
    if (message.role !== "tool" || message.name !== "load_skill" || message.isError) continue;
    if (prunedToolResults.has(message.toolCallId)) continue;
    return true;
  }
  return false;
}

function artifactReceiptProjection(receipt: Record<string, unknown>, sourceSchema: string | undefined): string | undefined {
  if (stringValue(receipt.schema) !== ARTIFACT_RECEIPT_SCHEMA) return undefined;
  const artifact = recordValue(receipt.artifact);
  if (artifact === undefined) return undefined;
  const inspection = recordValue(receipt.inspection);
  const projection = {
    schema: CONTEXT_ARTIFACT_PROJECTION_SCHEMA,
    sourceSchema,
    artifactReceipt: {
      schema: stringValue(receipt.schema),
      receiptId: stringValue(receipt.receiptId),
      sourceTool: stringValue(receipt.sourceTool),
      artifact: compactArtifactReceiptArtifact(artifact),
      inspection: inspection === undefined ? undefined : compactArtifactReceiptInspection(inspection),
      evidenceKinds: recordValue(receipt.evidenceKinds),
      canonicalEvidence: recordValue(receipt.canonicalEvidence),
    },
    instruction: "Use this artifact receipt for generated file facts. Treat the path as evidence, not as permission to reread the same artifact; if acceptance is still missing, verify the artifact instead.",
  };
  return JSON.stringify(omitUndefinedDeep(projection));
}

function compactArtifactReceiptArtifact(artifact: Record<string, unknown>): unknown {
  return omitUndefinedDeep({
    path: stringValue(artifact.path),
    artifactKind: stringValue(artifact.artifactKind),
    renderMode: stringValue(artifact.renderMode),
    acceptanceProfile: stringValue(artifact.acceptanceProfile),
    pageCount: numberValue(artifact.pageCount),
    bytes: numberValue(artifact.bytes),
    characters: numberValue(artifact.characters),
    totalLines: numberValue(artifact.totalLines),
    sha256: stringValue(artifact.sha256),
    specSha256: stringValue(artifact.specSha256),
  });
}

function compactArtifactReceiptInspection(inspection: Record<string, unknown>): unknown {
  return omitUndefinedDeep({
    sha256: stringValue(inspection.sha256),
    characters: numberValue(inspection.characters),
    totalLines: numberValue(inspection.totalLines),
    outline: compactArray(inspection.outline, 12),
    outlineTruncated: booleanValue(inspection.outlineTruncated),
    sampleRangeCount: numberValue(inspection.sampleRangeCount),
  });
}

function paginatedHtmlMaterializationProjection(value: Record<string, unknown>): string | undefined {
  const path = stringValue(value.path);
  if (path === undefined) return undefined;
  const inspection = recordValue(value.inspection);
  const projection = {
    schema: CONTEXT_ARTIFACT_PROJECTION_SCHEMA,
    sourceSchema: stringValue(value.schema),
    artifact: {
      path,
      artifactKind: stringValue(value.artifactKind),
      renderMode: stringValue(value.renderMode),
      acceptanceProfile: stringValue(value.acceptanceProfile),
      pageCount: numberValue(value.pageCount),
      bytes: numberValue(value.bytes),
      characters: numberValue(value.characters),
      totalLines: numberValue(value.totalLines),
      sha256: stringValue(value.sha256),
      specSha256: stringValue(value.specSha256),
    },
    inspection: inspection === undefined ? undefined : {
      sha256: stringValue(inspection.sha256),
      characters: numberValue(inspection.characters),
      totalLines: numberValue(inspection.totalLines),
      outline: compactArray(inspection.outline, 12),
      outlineTruncated: booleanValue(inspection.outlineTruncated),
      sampleRangeCount: Array.isArray(inspection.sampleRanges) ? inspection.sampleRanges.length : undefined,
    },
    instruction: "Use this artifact receipt for generated file facts. Treat the path as evidence, not as permission to reread the same artifact; if acceptance is still missing, verify the artifact instead.",
  };
  return JSON.stringify(omitUndefinedDeep(projection));
}

function writtenArtifactProjection(value: Record<string, unknown>, toolName: string): string | undefined {
  const path = stringValue(value.path);
  const sha256 = stringValue(value.sha256);
  if (path === undefined || sha256 === undefined) return undefined;
  const inspection = recordValue(value.inspection);
  const projection = {
    schema: CONTEXT_ARTIFACT_PROJECTION_SCHEMA,
    sourceTool: toolName,
    artifact: {
      path,
      bytes: numberValue(value.bytes),
      characters: numberValue(value.characters),
      totalLines: numberValue(value.totalLines),
      sha256,
    },
    inspection: inspection === undefined ? undefined : {
      sha256: stringValue(inspection.sha256),
      characters: numberValue(inspection.characters),
      totalLines: numberValue(inspection.totalLines),
      outline: compactArray(inspection.outline, 12),
      outlineTruncated: booleanValue(inspection.outlineTruncated),
      sampleRangeCount: Array.isArray(inspection.sampleRanges) ? inspection.sampleRanges.length : undefined,
    },
    instruction: "Use this artifact receipt for written file facts. Treat the path as evidence, not as permission to reread the same artifact; if acceptance is still missing, verify the artifact instead.",
  };
  return JSON.stringify(omitUndefinedDeep(projection));
}

function artifactAcceptanceProjection(value: Record<string, unknown>): string | undefined {
  const artifact = recordValue(value.artifact);
  if (artifact === undefined) return undefined;
  const checks = Array.isArray(value.checks) ? value.checks : [];
  const projection = {
    schema: "agentloop.contextArtifactAcceptanceProjection/v1",
    sourceSchema: stringValue(value.schema),
    artifact: {
      path: stringValue(artifact.path),
      requestedPath: stringValue(artifact.requestedPath),
      resolvedPath: stringValue(artifact.resolvedPath),
      bytes: numberValue(artifact.bytes),
      sha256: stringValue(artifact.sha256),
      kind: stringValue(artifact.kind),
      profileId: stringValue(artifact.profileId),
      inspectionTruncated: booleanValue(artifact.inspectionTruncated),
    },
    verdict: stringValue(value.verdict),
    evidenceKinds: recordValue(value.evidenceKinds),
    checks: checks.slice(0, 24).map(compactArtifactAcceptanceCheck),
    caveats: compactArray(value.caveats, 12),
    requestedChecks: compactArray(value.requestedChecks, 12),
    instruction: "Use this acceptance receipt for artifact status and caveats. When required artifact evidence is satisfied, do not reread files only to restate receipt facts. Do not infer skipped checks as passed; request the missing capability only when strict validation is required.",
  };
  return JSON.stringify(omitUndefinedDeep(projection));
}

function compactArtifactAcceptanceCheck(value: unknown): unknown {
  const record = recordValue(value);
  if (record === undefined) return value;
  return omitUndefinedDeep({
    id: stringValue(record.id),
    status: stringValue(record.status),
    evidence: compactArtifactAcceptanceEvidence(record.evidence),
    diagnostics: compactDiagnostic(record.diagnostics),
  });
}

function compactArtifactAcceptanceEvidence(value: unknown): unknown {
  const record = recordValue(value);
  if (record === undefined) return undefined;
  return omitUndefinedDeep({
    requestedPath: stringValue(record.requestedPath),
    path: stringValue(record.path),
    resolvedPath: stringValue(record.resolvedPath),
    bytes: numberValue(record.bytes),
    sha256: stringValue(record.sha256),
    expected: stringValue(record.expected),
    mode: stringValue(record.mode),
    extensionMatches: booleanValue(record.extensionMatches),
    hasHtmlShape: booleanValue(record.hasHtmlShape),
    contentTruncated: booleanValue(record.contentTruncated),
    slideCount: numberValue(record.slideCount),
    signals: compactArray(record.signals, 12),
    staticSignals: compactArray(record.staticSignals, 12),
    requiredCapability: stringValue(record.requiredCapability),
    reason: compactDiagnostic(record.reason),
    providerId: stringValue(record.providerId),
  });
}

function compactDiagnostic(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 240) return normalized;
  return `${normalized.slice(0, 240)}...`;
}

function visibleListDirectoryProjection(value: Record<string, unknown>): string | undefined {
  const entries = Array.isArray(value.entries) ? value.entries : undefined;
  if (entries === undefined) return undefined;
  const typeCounts: Record<string, number> = {};
  const nameSamples: string[] = [];
  for (const entry of entries) {
    const record = recordValue(entry);
    const type = stringValue(record?.type) ?? "unknown";
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    const name = stringValue(record?.name);
    if (name !== undefined && nameSamples.length < 8) nameSamples.push(name);
  }
  const projection = {
    schema: "agentloop.contextDirectoryListingProjection/v1",
    rootId: stringValue(value.rootId),
    entryCount: entries.length,
    typeCounts,
    nameSamples,
    sha256: digest(JSON.stringify(entries)),
    instruction: "Use this directory listing summary for navigation. Call find/index/read tools for exact paths or file contents.",
  };
  return JSON.stringify(omitUndefinedDeep(projection));
}

function sourceRefProjectionLimit(sourceType: string | undefined, sourceSchema: string | undefined): number {
  if (sourceType === "visible_search_text") return 4;
  if (sourceType === "visible_file_discovery") return 5;
  if (sourceType === "visible_directory") return 5;
  if (sourceSchema === "agentloop.visibleSearchSummary/v1" || sourceSchema === "agentloop.visibleSearchText/v1") return 4;
  if (sourceSchema === "agentloop.visibleFindFiles/v1") return 5;
  return 12;
}

function sourceRefLedgerLimit(sourceType: string | undefined, sourceSchema: string | undefined): number {
  if (sourceType === "visible_search_text") return 3;
  if (sourceType === "visible_file_discovery") return 3;
  if (sourceType === "visible_directory") return 3;
  if (sourceSchema === "agentloop.visibleSearchSummary/v1" || sourceSchema === "agentloop.visibleSearchText/v1") return 3;
  if (sourceSchema === "agentloop.visibleFindFiles/v1") return 3;
  return 8;
}

function compactEvidenceSourceRef(value: unknown): unknown {
  const record = recordValue(value);
  if (record === undefined) return value;
  const matchedBy = recordValue(record.matchedBy);
  return omitUndefinedDeep({
    sourceRefId: stringValue(record.sourceRefId),
    path: stringValue(record.path),
    rootId: stringValue(record.rootId),
    sha256: stringValue(record.sha256),
    bytes: numberValue(record.bytes),
    characters: numberValue(record.characters),
    truncated: booleanValue(record.truncated),
    requestedPath: stringValue(record.requestedPath),
    resolvedPath: stringValue(record.resolvedPath),
    offset: numberValue(record.offset),
    limit: numberValue(record.limit),
    totalLines: numberValue(record.totalLines),
    nextOffset: numberValue(record.nextOffset),
    sheets: compactSheetRefs(record.sheets, 8),
    matchedBy: matchedBy === undefined ? undefined : omitUndefinedDeep({
      path: stringValue(matchedBy.path),
      pattern: stringValue(matchedBy.pattern),
    }),
    lines: Array.isArray(record.lines) ? record.lines.slice(0, 12) : undefined,
  });
}

function compactEvidenceFactForProjection(value: unknown): unknown {
  const record = recordValue(value);
  if (record === undefined) return value;
  const base = compactEvidenceFactForLedger(record);
  const baseRecord = recordValue(base);
  if (baseRecord === undefined) return base;
  const textPreview = stringValue(record.textPreview);
  return omitUndefinedDeep({
    ...baseRecord,
    fields: compactNameValueArray(record.fields, 12, 300),
    sections: compactNameValueArray(record.sections, 8, 700),
    textPreview: textPreview === undefined
      ? undefined
      : truncateForSummary(textPreview, SOURCE_FACT_TEXT_PREVIEW_PROJECTION_LIMIT),
    textPreviewCharacters: textPreview?.length,
    textPreviewSha256: textPreview === undefined ? undefined : digest(textPreview),
  });
}

function structuredToolEvidenceLedger(content: string): string | undefined {
  const value = parseJsonRecord(content);
  if (value === undefined) return undefined;
  const receipt = recordValue(value.evidenceReceipt);
  if (receipt === undefined) return undefined;
  const sourceRefs = Array.isArray(receipt.sourceRefs) ? receipt.sourceRefs : [];
  const facts = Array.isArray(receipt.facts) ? receipt.facts : [];
  const caveats = Array.isArray(receipt.caveats) ? receipt.caveats : [];
  const sourceType = stringValue(receipt.sourceType);
  const sourceRefLimit = sourceRefLedgerLimit(sourceType, stringValue(value.schema));
  const ledger = {
    schema: "agentloop.contextEvidenceLedger/v1",
    sourceSchema: stringValue(value.schema),
    requested: numberValue(value.requested),
    returned: numberValue(value.returned),
    truncated: booleanValue(value.truncated),
    evidenceReceipt: {
      schema: stringValue(receipt.schema),
      sourceType,
      receiptId: stringValue(receipt.receiptId),
      sourceRefCount: sourceRefs.length,
      factCount: facts.length,
      sourceRefSamples: sourceRefLimit <= 0 ? undefined : sourceRefs.slice(0, sourceRefLimit).map(compactEvidenceSourceRef),
      factSummaries: facts.slice(0, 12).map(compactEvidenceFactForLedger),
      caveats: caveats.slice(0, 12),
      evidenceKinds: recordValue(receipt.evidenceKinds),
    },
    instruction: "Carry this receipt ledger forward without rewriting raw source facts. Use receiptId/sourceRefs to request exact rereads only when needed.",
  };
  return JSON.stringify(omitUndefinedDeep(ledger));
}

function compactEvidenceFactForLedger(value: unknown): unknown {
  const record = recordValue(value);
  if (record === undefined) return value;
  const hasTextGroups = Array.isArray(record.textGroups) && record.textGroups.length > 0;
  const samplePaths = Array.isArray(record.samplePaths) ? record.samplePaths.slice(0, 12) : undefined;
  const sampleMatches = Array.isArray(record.sampleMatches)
    ? record.sampleMatches.slice(0, hasTextGroups ? 3 : 8).map((item) => {
      const match = recordValue(item);
      if (match === undefined) return item;
      return omitUndefinedDeep({
        path: stringValue(match.path),
        line: numberValue(match.line),
        text: hasTextGroups ? undefined : typeof match.text === "string" ? match.text.slice(0, 240) : undefined,
        readRange: match.readRange,
      });
    })
    : undefined;
  const outline = Array.isArray(record.outline) ? record.outline.slice(0, 8) : undefined;
  const fields = compactNameValueArray(record.fields, 8, 180);
  const sections = compactNameValueArray(record.sections, 6, 240);
  return omitUndefinedDeep({
    kind: stringValue(record.kind),
    rootId: stringValue(record.rootId),
    path: stringValue(record.path),
    url: stringValue(record.url),
    title: stringValue(record.title),
    query: stringValue(record.query),
    pattern: stringValue(record.pattern),
    limit: numberValue(record.limit),
    maxMatches: numberValue(record.maxMatches),
    returned: numberValue(record.returned),
    returnedMatches: numberValue(record.returnedMatches),
    totalMatches: numberValue(record.totalMatches),
    totalFiles: numberValue(record.totalFiles),
    scannedFiles: numberValue(record.scannedFiles),
    totalBytes: numberValue(record.totalBytes),
    totalRows: numberValue(record.totalRows),
    totalRecords: numberValue(record.totalRecords),
    totalCells: numberValue(record.totalCells),
    bytes: numberValue(record.bytes),
    characters: numberValue(record.characters),
    indexRef: stringValue(record.indexRef),
    matchesRef: stringValue(record.matchesRef),
    sha256: stringValue(record.sha256),
    truncated: booleanValue(record.truncated),
    compacted: booleanValue(record.compacted),
    extensions: recordValue(record.extensions),
    groups: compactCountGroups(record.groups, 20),
    fieldProfiles: compactFieldProfiles(record.fieldProfiles, 8, 8),
    spreadsheetProfile: compactSpreadsheetProfile(record.spreadsheetProfile),
    artifact: compactArtifactPointer(record.artifact),
    extractionSha256: stringValue(record.extractionSha256),
    textGroups: compactTextGroups(record.textGroups, 12, 240, 2),
    pathGroups: compactPathGroups(record.pathGroups, 12),
    samplePaths,
    sampleMatches,
    outline,
    fields,
    sections,
    excerptCharacters: typeof record.excerpt === "string" ? record.excerpt.length : undefined,
    excerptSha256: typeof record.excerpt === "string" ? digest(record.excerpt) : undefined,
  });
}

function compactSpreadsheetProfile(value: unknown): unknown {
  const record = recordValue(value);
  if (record === undefined) return undefined;
  return omitUndefinedDeep({
    schema: stringValue(record.schema),
    workbookCount: numberValue(record.workbookCount),
    profiledWorkbookCount: numberValue(record.profiledWorkbookCount),
    truncated: booleanValue(record.truncated),
    signatures: Array.isArray(record.signatures) ? record.signatures.slice(0, 8).map((item) => {
      const signature = recordValue(item);
      if (signature === undefined) return item;
      return omitUndefinedDeep({
        signature: stringValue(signature.signature),
        count: numberValue(signature.count),
        samplePaths: Array.isArray(signature.samplePaths) ? signature.samplePaths.slice(0, 4) : undefined,
        sheetNames: Array.isArray(signature.sheetNames) ? signature.sheetNames.slice(0, 8) : undefined,
        sheetShapes: Array.isArray(signature.sheetShapes) ? signature.sheetShapes.slice(0, 8) : undefined,
      });
    }) : undefined,
    files: Array.isArray(record.files) ? record.files.slice(0, 8).map(compactSpreadsheetFileProfile) : undefined,
    caveats: compactArray(record.caveats, 8),
  });
}

function compactSpreadsheetFileProfile(value: unknown): unknown {
  const record = recordValue(value);
  if (record === undefined) return value;
  return omitUndefinedDeep({
    path: stringValue(record.path),
    extension: stringValue(record.extension),
    bytes: numberValue(record.bytes),
    workbookType: stringValue(record.workbookType),
    sheetCount: numberValue(record.sheetCount),
    signature: stringValue(record.signature),
    truncated: booleanValue(record.truncated),
    error: stringValue(record.error),
    sheets: Array.isArray(record.sheets) ? record.sheets.slice(0, 8).map(compactSpreadsheetSheetProfile) : undefined,
  });
}

function compactSpreadsheetSheetProfile(value: unknown): unknown {
  const record = recordValue(value);
  if (record === undefined) return value;
  return omitUndefinedDeep({
    name: stringValue(record.name),
    index: numberValue(record.index),
    declaredRange: stringValue(record.declaredRange),
    observedRange: stringValue(record.observedRange),
    rowCount: numberValue(record.rowCount),
    columnCount: numberValue(record.columnCount),
    nonEmptyCellCount: numberValue(record.nonEmptyCellCount),
    mergedCellCount: numberValue(record.mergedCellCount),
    formulaCellCount: numberValue(record.formulaCellCount),
    valueKinds: recordValue(record.valueKinds),
    candidateHeaders: Array.isArray(record.candidateHeaders) ? record.candidateHeaders.slice(0, 3).map((item) => {
      const header = recordValue(item);
      if (header === undefined) return item;
      return omitUndefinedDeep({
        row: numberValue(header.row),
        range: stringValue(header.range),
        nonEmptyCellCount: numberValue(header.nonEmptyCellCount),
        values: Array.isArray(header.values) ? header.values.slice(0, 12) : undefined,
      });
    }) : undefined,
  });
}

function compactSheetRefs(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, maximum).map((item) => {
    const record = recordValue(item);
    if (record === undefined) return item;
    return omitUndefinedDeep({
      name: stringValue(record.name),
      sourceRange: stringValue(record.sourceRange),
      rowCount: numberValue(record.rowCount),
      cellCount: numberValue(record.cellCount),
      truncated: booleanValue(record.truncated),
    });
  });
}

function compactArtifactPointer(value: unknown): unknown {
  const record = recordValue(value);
  if (record === undefined) return undefined;
  return omitUndefinedDeep({
    schema: stringValue(record.schema),
    path: stringValue(record.path),
    bytes: numberValue(record.bytes),
    sha256: stringValue(record.sha256),
  });
}

function compactTextGroups(value: unknown, maximum: number, textCharacters: number, maxSamplePaths: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, maximum).map((item) => {
    const record = recordValue(item);
    if (record === undefined) return item;
    return omitUndefinedDeep({
      text: typeof record.text === "string" ? truncateSingleLine(record.text, textCharacters) : undefined,
      textCharacters: typeof record.text === "string" ? record.text.length : undefined,
      textSha256: typeof record.text === "string" && record.text.length > textCharacters ? digest(record.text) : undefined,
      count: numberValue(record.count),
      samplePaths: Array.isArray(record.samplePaths) ? record.samplePaths.slice(0, maxSamplePaths) : undefined,
    });
  });
}

function compactPathGroups(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, maximum).map((item) => {
    const record = recordValue(item);
    if (record === undefined) return item;
    return omitUndefinedDeep({
      prefix: stringValue(record.prefix),
      count: numberValue(record.count),
    });
  });
}

function compactCountGroups(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, maximum).map((item) => {
    const record = recordValue(item);
    if (record === undefined) return item;
    return omitUndefinedDeep({
      key: stringValue(record.key),
      prefix: stringValue(record.prefix),
      value: stringValue(record.value),
      count: numberValue(record.count),
    });
  });
}

function compactFieldProfiles(value: unknown, maximum: number, maxTopValues: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, maximum).map((item) => {
    const record = recordValue(item);
    if (record === undefined) return item;
    return omitUndefinedDeep({
      field: stringValue(record.field),
      observed: numberValue(record.observed),
      uniqueValues: numberValue(record.uniqueValues),
      topValues: compactFieldProfileTopValues(record.topValues, maxTopValues),
      hierarchy: compactFieldProfileHierarchy(record.hierarchy, 12),
    });
  });
}

function compactFieldProfileTopValues(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, maximum).map((item) => {
    const record = recordValue(item);
    if (record === undefined) return item;
    return omitUndefinedDeep({
      value: typeof record.value === "string" ? truncateSingleLine(record.value, 180) : undefined,
      valueCharacters: typeof record.value === "string" ? record.value.length : undefined,
      count: numberValue(record.count),
      samplePaths: Array.isArray(record.samplePaths) ? record.samplePaths.slice(0, 2) : undefined,
    });
  });
}

function compactFieldProfileHierarchy(value: unknown, maximumNodes: number): unknown {
  const record = recordValue(value);
  if (record === undefined) return undefined;
  const nodes = Array.isArray(record.nodes)
    ? record.nodes.slice(0, maximumNodes).map((item) => {
      const node = recordValue(item);
      if (node === undefined) return item;
      return omitUndefinedDeep({
        path: Array.isArray(node.path) ? node.path.slice(0, 6) : undefined,
        count: numberValue(node.count),
      });
    })
    : undefined;
  return omitUndefinedDeep({
    delimiter: stringValue(record.delimiter),
    nodes,
  });
}

function compactNameValueArray(value: unknown, maximum: number, valueCharacters: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, maximum).map((item) => {
    const record = recordValue(item);
    if (record === undefined) return item;
    const value = typeof record.value === "string" ? record.value : undefined;
    return omitUndefinedDeep({
      name: stringValue(record.name),
      value: value === undefined ? undefined : truncateSingleLine(value, valueCharacters),
      valueCharacters: value === undefined ? undefined : value.length,
      valueSha256: value === undefined || value.length <= valueCharacters ? undefined : digest(value),
    });
  });
}

function truncateSingleLine(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum)}...`;
}

function parseJsonRecord(content: string): Record<string, unknown> | undefined {
  try {
    return recordValue(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function compactArray(value: unknown, maximum: number): unknown[] | undefined {
  return Array.isArray(value) ? value.slice(0, maximum) : undefined;
}

function omitUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUndefinedDeep);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, omitUndefinedDeep(item)]),
  );
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

function errorEventDetails(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: String(error) };
}
