import type { AgentLoopToolEvidence, ModelMessage, ModelToolCall } from "./contracts.ts";

export interface RecoveryEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface RecoveryTranscript {
  readonly messages: readonly ModelMessage[];
  readonly toolEvidence: readonly AgentLoopToolEvidence[];
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
  const toolCallCommitted = new Map<string, { name: string; arguments: unknown; seq: number }>();
  const coveredToolCallIds = new Set<string>();
  for (const event of scope) {
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
    if (event.type === "tool.completed" && typeof event.data.result === "string") {
      outcomes.set(toolCallId, { content: event.data.result, isError: false });
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

  const messages: ModelMessage[] = [{ role: "user", content: input.userInput }];
  const toolEvidence: AgentLoopToolEvidence[] = [];
  const unfinishedToolCalls: Array<{ toolCallId: string; toolName: string }> = [];
  let checkpointEventSeq: number | undefined;
  for (const assistant of assistants) {
    if (assistant.toolCalls.length === 0) continue;
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
      toolEvidence.push(toolEvidenceFromOutcome(call, outcome));
    }
    if (replayableCalls.length === 0) continue;
    const complete = replayableCalls.every((call) => outcomes.has(call.id));
    if (!complete) {
      for (const call of replayableCalls) {
        if (!outcomes.has(call.id)) unfinishedToolCalls.push({ toolCallId: call.id, toolName: call.name });
      }
      continue;
    }
    messages.push({
      role: "assistant",
      content: assistant.content,
      toolCalls: replayableCalls,
      ...(assistant.reasoningContent === undefined ? {} : { reasoningContent: assistant.reasoningContent }),
    });
      for (const call of replayableCalls) {
        const outcome = outcomes.get(call.id)!;
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: outcome.content,
        isError: outcome.isError,
      });
      toolEvidence.push(toolEvidenceFromOutcome(call, outcome));
      }
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
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: orphanCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      });
      for (const call of orphanCalls) {
        const outcome = outcomes.get(call.id)!;
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: outcome.content,
          isError: outcome.isError,
        });
        toolEvidence.push({
          toolCallId: call.id,
          toolName: call.name,
          result: outcome.content,
          isError: outcome.isError,
          ...(outcome.failurePhase === undefined ? {} : { failurePhase: outcome.failurePhase }),
        });
      }
      checkpointEventSeq = Math.max(checkpointEventSeq ?? 0, ...orphanCalls.map((call) => call.seq));
    } else {
      for (const call of orphanCalls) {
        if (!outcomes.has(call.id)) unfinishedToolCalls.push({ toolCallId: call.id, toolName: call.name });
      }
    }
  }

  return {
    messages,
    toolEvidence,
    facts: {
      stepId: input.stepId,
      ...(checkpointEventSeq === undefined ? {} : { checkpointEventSeq }),
      unfinishedToolCalls,
      candidateOutputs,
    },
  };
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
    ...(outcome.failurePhase === undefined ? {} : { failurePhase: outcome.failurePhase }),
  };
}
