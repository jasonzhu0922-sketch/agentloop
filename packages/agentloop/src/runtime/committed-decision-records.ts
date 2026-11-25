import type { AgentLoopToolEvidence, ModelToolCall, RuntimeEvent } from "./contracts.ts";
import type { ExecutionHistoryBasis } from "./execution-history-projection.ts";
import { parseRuntimeResultRef, type RuntimeResultRef } from "./runtime-result.ts";
import { classifyToolOperationOutcome } from "./tool-operation-outcome.ts";

/** Disposable projection of the existing leaf event ledger. Not Provider messages. */
export interface CommittedDecisionRecords {
  readonly ambiguousToolCallIds?: readonly string[];
  readonly checkpoints: readonly {
    readonly position: number;
    readonly content: string;
    readonly toolCalls: readonly ModelToolCall[];
    readonly basis?: ExecutionHistoryBasis;
  }[];
  readonly observations: readonly {
    readonly position: number;
    readonly toolCallId: string;
    readonly name: string;
    readonly content: string;
    readonly isError: boolean;
    readonly resultRef?: RuntimeResultRef;
    readonly executionOutcome?: Pick<AgentLoopToolEvidence, "invocationStatus" | "operationStatus" | "failurePhase" | "exitCode">;
  }[];
}

export const isDecisionRecordEvent = (event: RuntimeEvent): boolean =>
  ["assistant.committed", "tool.result_committed", "tool.completed", "tool.failed", "tool.rejected"].includes(event.type);

/** Only callers holding acknowledged commits may supply events here. Resolved arguments, not previews, are required. */
export function committedDecisionRecords(events: readonly RuntimeEvent[]): CommittedDecisionRecords {
  const checkpoints: CommittedDecisionRecords["checkpoints"][number][] = [];
  const observations = new Map<string, CommittedDecisionRecords["observations"][number]>();
  const resultRefs = new Map<string, RuntimeResultRef>();
  const ambiguousToolCallIds = new Set<string>();
  // Result commit can precede the final assistant checkpoint during streaming.
  for (const { type, data } of events) {
    const ref = parseRuntimeResultRef(data.resultRef);
    if (type === "tool.result_committed" && typeof data.toolCallId === "string" && ref) resultRefs.set(data.toolCallId, ref);
  }
  events.forEach(({ type, data }, position) => {
    if (type === "assistant.committed") {
      // A truncated proposal is not a complete semantic declaration. Per-call
      // commits still protect effects, but cannot authorize half a state update.
      if (data.finishReason === "length" || !Array.isArray(data.toolCalls)) return;
      const toolCalls = data.toolCalls.filter((call): call is ModelToolCall => record(call)
        && typeof call.id === "string" && typeof call.name === "string");
      if (!toolCalls.length || toolCalls.length !== data.toolCalls.length) return;
      const basis = record(data.executionHistoryBasis) && record(data.executionHistoryBasis.identity)
        && record(data.executionHistoryBasis.toolEffects) ? data.executionHistoryBasis as unknown as ExecutionHistoryBasis : undefined;
      checkpoints.push({ position, content: typeof data.content === "string" ? data.content : "", toolCalls, basis });
      return;
    }
    if (!["tool.completed", "tool.failed", "tool.rejected"].includes(type)
      || typeof data.toolCallId !== "string" || typeof data.toolName !== "string") return;
    const content = typeof data.result === "string" ? data.result : String(data.error ?? data.reason ?? "");
    const classified = classifyToolOperationOutcome(content);
    const completed = type === "tool.completed";
    const operationStatus = ["succeeded", "failed", "unknown"].includes(String(data.operationStatus))
      ? data.operationStatus as "succeeded" | "failed" | "unknown"
      : completed && classified.exitCode !== undefined ? classified.status : "unknown";
    const resultRef = resultRefs.get(data.toolCallId) ?? parseRuntimeResultRef(data.resultRef);
    const observation: CommittedDecisionRecords["observations"][number] = {
      position, toolCallId: data.toolCallId, name: data.toolName, content,
      isError: !completed || data.isError === true || operationStatus === "failed",
      ...(resultRef ? { resultRef } : {}),
      executionOutcome: {
        invocationStatus: completed ? data.invocationStatus === "completed" ? "completed" : undefined : type === "tool.rejected" ? "rejected" : "failed",
        operationStatus,
        ...(typeof data.exitCode === "number" || data.exitCode === null ? { exitCode: data.exitCode } : {}),
        ...(!completed ? { failurePhase: type === "tool.rejected" ? "prepare" as const : "execute" as const }
          : operationStatus === "failed" ? { failurePhase: "operation" as const } : {}),
      },
    };
    // prepare may report failed + rejected. Prefer the explicit rejection.
    // Ambiguous repeated call identities are rejected by the semantic reducer.
    const previous = observations.get(data.toolCallId);
    if (previous && type === "tool.completed") ambiguousToolCallIds.add(data.toolCallId);
    if (!previous || type === "tool.rejected") observations.set(data.toolCallId, observation);
  });
  return { checkpoints, observations: [...observations.values()], ambiguousToolCallIds: [...ambiguousToolCallIds] };
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
