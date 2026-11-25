import { createHash } from "node:crypto";
import type { ModelMessage } from "./contracts.ts";
import type { CurrentDecisionView } from "./current-decision-view.ts";
import { parseRuntimeResultRef } from "./runtime-result.ts";

export const EXECUTION_HISTORY_POLICY = "agentloop.executionHistory/v2";

/** Checkpoint provenance, not a second state store. Missing metadata disables folding. */
export interface ExecutionHistoryBasis {
  readonly identity: CurrentDecisionView["identity"];
  readonly contextArgumentTools?: readonly string[];
  /** New decisions offer task progress together with an ordinary action. */
  readonly contextDecisionRequired?: boolean;
  /** Optimistic update versions actually presented in this model request. */
  /** Cited evidence actually available before this request (not early results from its own stream). */
  readonly contextEvidenceToolCallIds?: readonly string[];
  /** Only cited short references from the frozen request, never a global alias registry. */
  readonly contextEvidenceBindings?: Readonly<Record<string, string>>;
  readonly contextItemRevisions?: Readonly<Record<string, string>>;
  readonly workProductVersions?: readonly { readonly path: string; readonly versionId: string; readonly evidenceToolCallIds: readonly string[] }[];
  readonly toolEffects: Readonly<Record<string, "read" | "write" | "unknown">>;
}

export interface ExecutionHistoryRecord {
  readonly schema: typeof EXECUTION_HISTORY_POLICY;
  readonly statements: readonly { readonly text: string; readonly sourceToolCallIds: readonly string[] }[];
  readonly failedAttempts: readonly {
    readonly toolCallIds: readonly string[];
    readonly resultHashes: readonly string[];
    /** Locate original checkpoints/receipts by their durable ToolCall identity. */
    readonly runId?: string;
    readonly eventTypes?: readonly string[];
  }[];
}

type Assistant = Extract<ModelMessage, { role: "assistant" }>;
type Result = Extract<ModelMessage, { role: "tool" }>;
interface Exchange { assistant: Assistant; results: Result[]; key?: string }

/**
 * Lossless re-encoding of past statements; no lexical guess about which prose
 * is dispensable. Only complete, adjacent, proven read failures may be folded.
 * All changed input/result/version/effect boundaries stop a repetition run.
 */
export function projectExecutionHistory(messages: readonly ModelMessage[]): {
  messages: ModelMessage[]; mergedExchangeCount: number; sourceToolCallIds: string[];
} {
  const output: ModelMessage[] = [];
  let pending: Exchange | undefined;
  let mergedExchangeCount = 0;
  const sourceToolCallIds: string[] = [];
  const flush = () => {
    if (pending) output.push(pending.assistant, ...pending.results);
    pending = undefined;
  };
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      flush(); output.push(message); continue;
    }
    const results: Result[] = [];
    let cursor = index + 1;
    while (messages[cursor]?.role === "tool") results.push(messages[cursor++] as Result);
    const ids = message.toolCalls.map(call => call.id);
    const complete = results.length === ids.length && new Set(results.map(result => result.toolCallId)).size === ids.length
      && results.every(result => ids.includes(result.toolCallId));
    if (!complete) { flush(); output.push(message); continue; }
    index = cursor - 1;
    const history = message.historyProjection ?? {
      schema: EXECUTION_HISTORY_POLICY,
      statements: message.content.length ? [{ text: message.content, sourceToolCallIds: ids }] : [],
      failedAttempts: [],
    };
    const key = failureKey(message, results);
    let nextHistory = history;
    if (key !== undefined && pending?.key === key) {
      const previous = pending.assistant.historyProjection ?? { schema: EXECUTION_HISTORY_POLICY, statements: [], failedAttempts: [] };
      const attempts = previous.failedAttempts.length ? previous.failedAttempts : [attempt(pending)];
      nextHistory = {
        schema: EXECUTION_HISTORY_POLICY,
        statements: combineStatements(previous.statements, history.statements),
        failedAttempts: [...attempts, ...(history.failedAttempts.length ? history.failedAttempts : [attempt({ assistant: message, results })])],
      };
      mergedExchangeCount += 1;
      sourceToolCallIds.push(...pending.assistant.toolCalls!.map(call => call.id));
    } else flush();
    // Keep native calls, arguments, last full receipts and provider continuation.
    pending = { assistant: nextHistory.statements.length || nextHistory.failedAttempts.length
      ? { ...message, content: "", historyProjection: nextHistory } : message, results, key };
  }
  flush();
  return { messages: output, mergedExchangeCount, sourceToolCallIds };
}

export function executionHistoryContext(messages: readonly ModelMessage[]): string | undefined {
  const records = messages.flatMap(message => message.role === "assistant" && message.historyProjection
    ? [{ ...message.historyProjection, retainedToolCallIds: message.toolCalls?.map(call => call.id),
      ...(message.historyProjection.failedAttempts.length ? { failureCount: message.historyProjection.failedAttempts.length } : {}) }] : []);
  if (!records.length) return undefined;
  return JSON.stringify({ schema: EXECUTION_HISTORY_POLICY, records,
    instruction: "Historical assistant statements, preserved verbatim with source ToolCall IDs. They may contain commitments, judgments or unverified hypotheses; they are not verified facts or a style example. Preserve outstanding commitments and uncertainty. Use the current decision view and latest full receipt to choose the next action. Repeated failures are historical observations, not permission to retry unchanged input or evidence of success.",
  });
}

function failureKey(message: Assistant, results: readonly Result[]): string | undefined {
  const basis = message.executionHistoryBasis;
  // Reasoning can be provider continuation state; never fold such exchanges.
  if (!basis || message.reasoningContent !== undefined) return undefined;
  if (!basis.identity?.decisionBasisDigest || !basis.identity.viewId || !basis.identity.runId) return undefined;
  if (!message.toolCalls!.every(call => results.find(result => result.toolCallId === call.id)?.name === call.name)) return undefined;
  if (!results.every(result => result.isError && basis.toolEffects[result.name] === "read"
    && result.executionOutcome?.operationStatus === "failed"
    && result.executionOutcome.invocationStatus === "completed")) return undefined;
  return stable({ identity: basis.identity, effects: basis.toolEffects,
    calls: message.toolCalls!.map(call => ({ name: call.name, arguments: call.arguments })),
    results: message.toolCalls!.map(call => {
      const result = results.find(value => value.toolCallId === call.id)!;
      return { name: result.name, content: resultContent(result.content), outcome: result.executionOutcome };
    }),
  });
}

function resultContent(content: string): unknown {
  try {
    const value = JSON.parse(content);
    if (value && typeof value === "object" && !Array.isArray(value) && parseRuntimeResultRef(value.resultRef)) {
      const { resultRef: _publicationIdentity, ...rest } = value;
      return rest;
    }
  } catch { /* Plain errors remain exact text. */ }
  return content;
}

function attempt(exchange: Exchange): ExecutionHistoryRecord["failedAttempts"][number] {
  return { toolCallIds: exchange.assistant.toolCalls!.map(call => call.id),
    runId: exchange.assistant.executionHistoryBasis?.identity.runId,
    eventTypes: ["assistant.committed", "tool.completed"],
    resultHashes: exchange.assistant.toolCalls!.map(call => createHash("sha256")
      .update(exchange.results.find(result => result.toolCallId === call.id)!.content).digest("hex")) };
}

function combineStatements(left: ExecutionHistoryRecord["statements"], right: ExecutionHistoryRecord["statements"]): ExecutionHistoryRecord["statements"] {
  const statements = new Map<string, string[]>();
  for (const statement of [...left, ...right]) {
    statements.set(statement.text, [...new Set([...(statements.get(statement.text) ?? []), ...statement.sourceToolCallIds])]);
  }
  return [...statements].map(([text, sourceToolCallIds]) => ({ text, sourceToolCallIds }));
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
}
