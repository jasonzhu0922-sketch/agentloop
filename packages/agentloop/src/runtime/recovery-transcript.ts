import { createHash } from "node:crypto";
import type { AgentLoopToolEvidence, ModelMessage, ModelToolCall } from "./contracts.ts";
import type { ContextProjectionCheckpoint } from "./context-assembler.ts";
import { AppError } from "../shared/errors.ts";

export interface RecoveryEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface RecoveryTranscript {
  readonly messages: readonly ModelMessage[];
  readonly toolEvidence: readonly AgentLoopToolEvidence[];
  readonly contextProjection?: ContextProjectionCheckpoint;
  readonly facts: Readonly<{
    stepId: string;
    checkpointEventSeq?: number;
    unfinishedToolCalls: readonly Readonly<{ toolCallId: string; toolName: string }>[];
    candidateOutputs: readonly string[];
  }>;
}

interface AssistantCheckpoint {
  readonly event: RecoveryEvent;
  readonly content: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly reasoningContent?: string;
  readonly finishReason?: string;
  readonly providerReplayableToolCallIds?: readonly string[];
}

interface ToolOutcome {
  readonly content: string;
  readonly isError: boolean;
  readonly failurePhase?: "prepare" | "execute" | "runtime";
  readonly resultRef?: Readonly<{
    locator: string;
    sha256: string;
    characters: number;
  }>;
}

interface HumanLoopResponseEvent {
  readonly seq: number;
  readonly requestId?: string;
  readonly value: unknown;
}

interface RecoveryTimelineEntry {
  readonly seq: number;
  readonly messages: readonly ModelMessage[];
  readonly evidence: readonly AgentLoopToolEvidence[];
}

interface HumanLoopRequestSnapshot {
  readonly kind: string;
  readonly title: string;
  readonly prompt: string;
  readonly responseSchema: Record<string, unknown>;
}

/** Rebuild only provider-valid exchanges from persisted Runtime events. */
export function reconstructRecoveryTranscript(input: {
  userInput: string;
  stepId: string;
  events: readonly RecoveryEvent[];
}): RecoveryTranscript {
  const start = lastStepStart(input.events, input.stepId);
  const scope = start === -1 ? [] : input.events.slice(start + 1);
  const outcomes = new Map<string, ToolOutcome>();
  const assistants: AssistantCheckpoint[] = [];
  const candidateOutputs: string[] = [];
  const humanResponses: HumanLoopResponseEvent[] = [];
  const humanLoopRequests = new Map<string, HumanLoopRequestSnapshot>();
  const toolCallCommitted = new Map<string, { name: string; arguments: unknown; seq: number }>();
  const coveredToolCallIds = new Set<string>();
  let contextProjection: ContextProjectionCheckpoint | undefined;
  let previousProjectionRevision = 0;
  let previousSeq = 0;
  for (const event of scope) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= previousSeq) {
      throw invalidRecovery("Recovery events are not in strict sequence order");
    }
    previousSeq = event.seq;
    if (event.type === "context.projection.committed") {
      const checkpoint = requireContextProjectionCheckpoint(event.data.checkpoint, event.seq);
      if (checkpoint.revision <= previousProjectionRevision) {
        throw invalidRecovery("Context Projection revisions are not strictly increasing");
      }
      previousProjectionRevision = checkpoint.revision;
      contextProjection = checkpoint;
      continue;
    }
    if (event.type === "human_loop.answered") {
      humanResponses.push({
        seq: event.seq,
        ...(typeof event.data.requestId === "string" ? { requestId: event.data.requestId } : {}),
        value: event.data.value,
      });
      continue;
    }
    if (event.type === "run.waiting_user") {
      const requestId = typeof event.data.requestId === "string" ? event.data.requestId : undefined;
      const request = humanLoopRequestSnapshot(event.data.request);
      if (requestId !== undefined && request !== undefined) humanLoopRequests.set(requestId, request);
      continue;
    }
    if (event.type === "assistant.committed") {
      const content = typeof event.data.content === "string" ? event.data.content : "";
      const toolCalls = asToolCalls(event.data.toolCalls);
      const reasoningContent = typeof event.data.reasoningContent === "string" && event.data.reasoningContent.length > 0
        ? event.data.reasoningContent
        : undefined;
      const finishReason = typeof event.data.finishReason === "string" ? event.data.finishReason : undefined;
      const providerReplayableToolCallIds = Array.isArray(event.data.providerReplayableToolCallIds)
        ? event.data.providerReplayableToolCallIds.filter((value): value is string => typeof value === "string")
        : undefined;
      assistants.push({
        event,
        content,
        toolCalls,
        ...(reasoningContent === undefined ? {} : { reasoningContent }),
        ...(finishReason === undefined ? {} : { finishReason }),
        ...(providerReplayableToolCallIds === undefined ? {} : { providerReplayableToolCallIds }),
      });
      for (const call of toolCalls) coveredToolCallIds.add(call.id);
      if (toolCalls.length === 0 && content.length > 0) candidateOutputs.push(content);
      continue;
    }
    if (event.type === "assistant.tool_call.committed") {
      const committedId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
      const committedName = typeof event.data.name === "string" ? event.data.name : undefined;
      if (committedId !== undefined && committedName !== undefined) {
        toolCallCommitted.set(committedId, {
          name: committedName,
          arguments: event.data.arguments,
          seq: event.seq,
        });
      }
      continue;
    }
    const toolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
    if (toolCallId === undefined) continue;
    if (event.type === "tool.outcome.committed" && typeof event.data.content === "string") {
      const resultRef = asToolResultRef(event.data.resultRef);
      outcomes.set(toolCallId, {
        content: recoveryToolResultContent(event.data.content, resultRef),
        isError: event.data.isError === true,
        ...(resultRef === undefined ? {} : { resultRef }),
      });
    } else if (event.type === "tool.completed" && typeof event.data.result === "string") {
      const resultRef = asToolResultRef(event.data.resultRef);
      outcomes.set(toolCallId, {
        content: recoveryToolResultContent(event.data.result, resultRef),
        isError: false,
        ...(resultRef === undefined ? {} : { resultRef }),
      });
    } else if (event.type === "tool.failed" && typeof event.data.error === "string") {
      outcomes.set(toolCallId, {
        content: event.data.error,
        isError: true,
        failurePhase: "execute",
      });
    } else if (event.type === "tool.rejected" && typeof event.data.reason === "string") {
      outcomes.set(toolCallId, {
        content: event.data.reason,
        isError: true,
        failurePhase: typeof event.data.failurePhase === "string"
          ? event.data.failurePhase as "prepare" | "execute" | "runtime"
          : "prepare",
      });
    }
  }

  const removedNoToolAssistantSeqs = rejectedNoToolAssistantSeqs(scope, assistants);
  const timeline: RecoveryTimelineEntry[] = [];
  const unfinishedToolCalls: Array<{ toolCallId: string; toolName: string }> = [];
  let checkpointEventSeq: number | undefined;
  for (const assistant of assistants) {
    if (assistant.toolCalls.length === 0) {
      if (assistant.finishReason !== "length" && !removedNoToolAssistantSeqs.has(assistant.event.seq)) {
        timeline.push({
          seq: assistant.event.seq,
          messages: [{
            role: "assistant",
            content: assistant.content,
            ...(assistant.reasoningContent === undefined ? {} : { reasoningContent: assistant.reasoningContent }),
          }],
          evidence: [],
        });
        checkpointEventSeq = assistant.event.seq;
      }
      continue;
    }
    const replayableToolCallIds = assistant.providerReplayableToolCallIds === undefined
      ? assistant.finishReason === "length"
        ? new Set<string>()
        : new Set(assistant.toolCalls.filter((call) => isToolArgumentsObject(call.arguments)).map((call) => call.id))
      : new Set(assistant.providerReplayableToolCallIds);
    const replayableCalls = assistant.toolCalls.filter((call) =>
      replayableToolCallIds.has(call.id) && isToolArgumentsObject(call.arguments),
    );
    const suppressedCalls = assistant.toolCalls.filter((call) => !replayableToolCallIds.has(call.id) || !isToolArgumentsObject(call.arguments));
    for (const call of suppressedCalls) {
      const outcome = outcomes.get(call.id);
      if (outcome === undefined) {
        unfinishedToolCalls.push({ toolCallId: call.id, toolName: call.name });
        continue;
      }
      timeline.push({
        seq: assistant.event.seq,
        messages: [],
        evidence: [toolEvidenceFromOutcome(call, outcome)],
      });
    }
    if (replayableCalls.length === 0) continue;
    const complete = replayableCalls.every((call) => outcomes.has(call.id));
    if (!complete) {
      for (const call of replayableCalls) {
        if (!outcomes.has(call.id)) unfinishedToolCalls.push({ toolCallId: call.id, toolName: call.name });
      }
      continue;
    }
    const exchangeMessages: ModelMessage[] = [{
      role: "assistant",
      content: assistant.content,
      toolCalls: replayableCalls,
      ...(assistant.reasoningContent === undefined ? {} : { reasoningContent: assistant.reasoningContent }),
    }];
    const exchangeEvidence: AgentLoopToolEvidence[] = [];
    for (const call of replayableCalls) {
      const outcome = outcomes.get(call.id)!;
      exchangeMessages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: outcome.content,
        isError: outcome.isError,
        ...(outcome.resultRef === undefined ? {} : { resultRef: outcome.resultRef }),
      });
      exchangeEvidence.push(toolEvidenceFromOutcome(call, outcome));
    }
    timeline.push({ seq: assistant.event.seq, messages: exchangeMessages, evidence: exchangeEvidence });
    checkpointEventSeq = assistant.event.seq;
  }

  // Early-dispatched tool calls whose turn never reached assistant.committed
  // (the process died mid-stream). Their per-call checkpoint is still durable,
  // so reconstruct a provider-valid tail so recovery can resume.
  const orphanCalls: Array<{ id: string; name: string; arguments: unknown; seq: number }> = [];
  for (const [id, committed] of toolCallCommitted) {
    if (coveredToolCallIds.has(id)) continue;
    orphanCalls.push({ id, name: committed.name, arguments: committed.arguments, seq: committed.seq });
  }
  if (orphanCalls.length > 0) {
    const complete = orphanCalls.every((call) => outcomes.has(call.id));
    if (complete) {
      const exchangeMessages: ModelMessage[] = [{
        role: "assistant",
        content: "",
        toolCalls: orphanCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      }];
      const exchangeEvidence: AgentLoopToolEvidence[] = [];
      for (const call of orphanCalls) {
        const outcome = outcomes.get(call.id)!;
        exchangeMessages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: outcome.content,
          isError: outcome.isError,
          ...(outcome.resultRef === undefined ? {} : { resultRef: outcome.resultRef }),
        });
        exchangeEvidence.push({
          toolCallId: call.id,
          toolName: call.name,
          result: outcome.content,
          isError: outcome.isError,
          ...(outcome.resultRef === undefined ? {} : { resultRef: outcome.resultRef }),
          ...(outcome.failurePhase === undefined ? {} : { failurePhase: outcome.failurePhase }),
        });
      }
      timeline.push({
        seq: Math.min(...orphanCalls.map((call) => call.seq)),
        messages: exchangeMessages,
        evidence: exchangeEvidence,
      });
      checkpointEventSeq = Math.max(checkpointEventSeq ?? 0, ...orphanCalls.map((call) => call.seq));
    } else {
      for (const call of orphanCalls) {
        if (!outcomes.has(call.id)) unfinishedToolCalls.push({ toolCallId: call.id, toolName: call.name });
      }
    }
  }
  for (const response of humanResponses) {
    const request = response.requestId === undefined ? undefined : humanLoopRequests.get(response.requestId);
    timeline.push({
      seq: response.seq,
      messages: [{
        role: "user",
        content: request === undefined
          ? `Human-in-the-Loop response: ${JSON.stringify(response.value)}`
          : `Human-in-the-Loop resolution: ${JSON.stringify(humanLoopResolution(request, response.value))}`,
      }],
      evidence: [],
    });
  }

  timeline.sort((left, right) => left.seq - right.seq);
  const messages: ModelMessage[] = [{ role: "user", content: input.userInput }];
  const toolEvidence: AgentLoopToolEvidence[] = [];
  for (const entry of timeline) {
    messages.push(...entry.messages);
    toolEvidence.push(...entry.evidence);
  }

  return {
    messages,
    toolEvidence,
    ...(contextProjection === undefined ? {} : { contextProjection }),
    facts: {
      stepId: input.stepId,
      ...(checkpointEventSeq === undefined ? {} : { checkpointEventSeq }),
      unfinishedToolCalls,
      candidateOutputs,
    },
  };
}

function requireContextProjectionCheckpoint(value: unknown, sourceEventSeq: number): ContextProjectionCheckpoint {
  if (!isRecord(value) || value.schema !== "agentloop.contextProjection/v1") {
    throw invalidRecovery("Context Projection checkpoint schema is missing or unsupported");
  }
  const integerFields = ["revision", "contextEpoch", "firstKeptMessageIndex", "canonicalMessageCount", "estimatedInputTokens"] as const;
  for (const field of integerFields) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < (field === "revision" ? 1 : 0)) {
      throw invalidRecovery(`Context Projection ${field} is invalid`);
    }
  }
  if ((value.firstKeptMessageIndex as number) > (value.canonicalMessageCount as number)) {
    throw invalidRecovery("Context Projection retained-message boundary is invalid");
  }
  if (typeof value.runId !== "string" || value.runId.length === 0) {
    throw invalidRecovery("Context Projection runId is invalid");
  }
  for (const field of ["canonicalPrefixSha256", "projectionSha256", "systemPromptSha256", "runtimeContextSha256", "toolCatalogSha256"] as const) {
    if (!isSha256(value[field])) throw invalidRecovery(`Context Projection ${field} is invalid`);
  }
  if ((value.summary === undefined) !== (value.summarySha256 === undefined)) {
    throw invalidRecovery("Context Projection summary and hash must be present together");
  }
  if (value.summary !== undefined && (typeof value.summary !== "string" || !isSha256(value.summarySha256))) {
    throw invalidRecovery("Context Projection summary is invalid");
  }
  if (typeof value.summary === "string" && digest(value.summary) !== value.summarySha256) {
    throw invalidRecovery("Context Projection summary failed its integrity check");
  }
  if (!Array.isArray(value.projectedToolResults) || !value.projectedToolResults.every(isProjectedToolResult)) {
    throw invalidRecovery("Context Projection projected Tool results are invalid");
  }
  const projectedIds = value.projectedToolResults.map((item) => (item as Record<string, unknown>).toolCallId);
  if (new Set(projectedIds).size !== projectedIds.length) {
    throw invalidRecovery("Context Projection contains duplicate projected Tool results");
  }
  if (!isUniqueStringArray(value.activeSkillNames) || !isUniqueStringArray(value.expiredSkillNames)) {
    throw invalidRecovery("Context Projection Skill name arrays are invalid");
  }
  if (value.sourceEventSeq !== sourceEventSeq) {
    throw invalidRecovery("Context Projection source event sequence does not match its event");
  }
  return value as unknown as ContextProjectionCheckpoint;
}

function rejectedNoToolAssistantSeqs(
  events: readonly RecoveryEvent[],
  assistants: readonly AssistantCheckpoint[],
): ReadonlySet<number> {
  const available = assistants.filter((assistant) => assistant.toolCalls.length === 0);
  const removed = new Set<number>();
  for (const event of events) {
    if (event.type !== "candidate.rejected" || typeof event.data.output !== "string") continue;
    for (let index = available.length - 1; index >= 0; index -= 1) {
      const assistant = available[index];
      if (assistant.event.seq >= event.seq || removed.has(assistant.event.seq)) continue;
      if (assistant.content !== event.data.output) continue;
      removed.add(assistant.event.seq);
      break;
    }
  }
  return removed;
}

function isProjectedToolResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.toolCallId !== "string" || value.toolCallId.length === 0
    || typeof value.toolName !== "string" || value.toolName.length === 0
    || !Number.isSafeInteger(value.originalCharacters) || (value.originalCharacters as number) < 0
    || !isSha256(value.modelViewSha256)
    || !["budget", "large_tool_result", "structured_evidence", "structured_tool_result"].includes(String(value.reason))
  ) return false;
  for (const field of ["previewCharacters", "previewHeadCharacters", "previewTailCharacters"] as const) {
    if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0)) return false;
  }
  if (value.preview !== undefined && typeof value.preview !== "string") return false;
  if (value.structuredEvidence !== undefined && typeof value.structuredEvidence !== "string") return false;
  if (value.fullResultRef !== undefined && asToolResultRef(value.fullResultRef) === undefined) return false;
  return true;
}

function isUniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" && item.length > 0)
    && new Set(value).size === value.length;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalidRecovery(message: string): AppError {
  return new AppError("CONFLICT", message, 409);
}

/**
 * The waiting event carries a durable HIL request snapshot.  Preserve its
 * neutral response semantics for recovery without teaching Runtime about any
 * Skill's domain fields.
 */
function humanLoopRequestSnapshot(value: unknown): HumanLoopRequestSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.kind !== "string" || typeof value.title !== "string" || typeof value.prompt !== "string") return undefined;
  if (!isRecord(value.responseSchema) || typeof value.responseSchema.type !== "string") return undefined;
  return {
    kind: value.kind,
    title: value.title,
    prompt: value.prompt,
    responseSchema: value.responseSchema,
  };
}

function humanLoopResolution(request: HumanLoopRequestSnapshot, value: unknown): Record<string, unknown> {
  const resolution: Record<string, unknown> = {
    schema: "agentloop.humanLoopResolution/v1",
    request: {
      kind: request.kind,
      title: request.title,
      prompt: request.prompt,
      responseSchema: { type: request.responseSchema.type },
    },
    value,
  };
  if (request.responseSchema.type === "select" && Array.isArray(value)) {
    const options = Array.isArray(request.responseSchema.options) ? request.responseSchema.options : [];
    const byId = new Map(options.flatMap((option) => {
      if (!isRecord(option) || typeof option.id !== "string" || typeof option.label !== "string") return [];
      return [[option.id, option] as const];
    }));
    resolution.selectedOptions = value.flatMap((id) => {
      if (typeof id !== "string") return [];
      const option = byId.get(id);
      if (option === undefined) return [];
      return [{
        id: option.id,
        label: option.label,
        ...(typeof option.description === "string" ? { description: option.description } : {}),
        ...(Array.isArray(option.evidenceRefs)
          ? { evidenceRefs: option.evidenceRefs.filter((reference): reference is string => typeof reference === "string") }
          : {}),
      }];
    });
  }
  return resolution;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lastStepStart(events: readonly RecoveryEvent[], stepId: string): number {
  let index = -1;
  for (let current = 0; current < events.length; current += 1) {
    const event = events[current];
    if (event.type === "plan.step.started" && event.data.stepId === stepId) index = current;
  }
  return index;
}

function asToolCalls(value: unknown): ModelToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
    const call = item as Record<string, unknown>;
    if (typeof call.id !== "string" || typeof call.name !== "string") return [];
    return [{ id: call.id, name: call.name, arguments: call.arguments }];
  });
}

function isToolArgumentsObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolEvidenceFromOutcome(call: ModelToolCall, outcome: ToolOutcome): AgentLoopToolEvidence {
  return {
    toolCallId: call.id,
    toolName: call.name,
    result: outcome.content,
    isError: outcome.isError,
    ...(outcome.resultRef === undefined ? {} : { resultRef: outcome.resultRef }),
    ...(outcome.failurePhase === undefined ? {} : { failurePhase: outcome.failurePhase }),
  };
}

function asToolResultRef(value: unknown): ToolOutcome["resultRef"] {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.locator !== "string"
    || !/^tool-result:\/\/[0-9a-f-]+$/.test(value.locator)
    || typeof value.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.sha256)
    || typeof value.characters !== "number"
    || !Number.isSafeInteger(value.characters)
    || value.characters < 0
  ) return undefined;
  return {
    locator: value.locator,
    sha256: value.sha256,
    characters: value.characters,
  };
}

function recoveryToolResultContent(
  content: string,
  _resultRef: ToolOutcome["resultRef"],
): string {
  return content;
}
