import type { AgentLoopToolEvidence, JsonSchema, ModelToolCall, ModelToolDefinition } from "./contracts.ts";
import { estimateTextTokens } from "./context-assembler.ts";
import { badRequest } from "../shared/errors.ts";

/** Tool-owned authoring vocabulary; Runtime does not infer it from a name or extension. */
export interface BoundedToolContent {
  readonly field: string;
  readonly targetField: string;
  readonly continuationInstruction: string;
}

export interface OutputBudgetState {
  readonly shrinkCount: number;
  readonly consecutiveTruncations: number;
}

export interface ToolContentBudget {
  readonly maxOutputTokens: number;
  readonly maxContentCharacters: number;
  readonly maxArgumentsTokens: number;
}

export interface ToolContentBudgetPolicy {
  /** Share of the actual invocation output limit available to one authored payload. */
  readonly outputFraction?: number;
}

export function parseOutputBudgetState(value: unknown): OutputBudgetState | undefined {
  const record = asRecord(value);
  if (record === undefined || !Number.isSafeInteger(record.shrinkCount) || !Number.isSafeInteger(record.consecutiveTruncations)
    || (record.shrinkCount as number) < 0 || (record.consecutiveTruncations as number) < 0) return undefined;
  return { shrinkCount: record.shrinkCount as number, consecutiveTruncations: record.consecutiveTruncations as number };
}

export function toolContentBudget(maxOutputTokens: number, state: OutputBudgetState, policy: ToolContentBudgetPolicy = {}): ToolContentBudget {
  const fraction = policy.outputFraction ?? 0.25;
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) throw badRequest("contentBudgetPolicy.outputFraction must be greater than 0 and at most 1");
  const target = Math.max(1, Math.floor(maxOutputTokens * fraction / 2 ** Math.min(state.shrinkCount, 20)));
  return { maxOutputTokens, maxContentCharacters: Math.min(48_000, target), maxArgumentsTokens: target };
}

export function projectBoundedToolDefinition(
  definition: ModelToolDefinition, content: BoundedToolContent, budget: ToolContentBudget,
): ModelToolDefinition {
  const properties = asRecord(definition.inputSchema.properties) ?? {};
  const fieldSchema = asRecord(properties[content.field]) ?? {};
  const maxLength = Math.min(typeof fieldSchema.maxLength === "number" ? fieldSchema.maxLength : Infinity, budget.maxContentCharacters);
  return {
    ...definition,
    description: `${definition.description} This turn's stricter output budget overrides the static ceiling: ${content.field} must contain at most ${maxLength} characters and the complete serialized arguments must fit ${budget.maxArgumentsTokens} estimated tokens. Produce at most one bounded content call for the same target per turn. ${content.continuationInstruction}`,
    inputSchema: { ...definition.inputSchema, properties: { ...properties, [content.field]: { ...fieldSchema, maxLength } } } as JsonSchema,
  };
}

export function assertToolContentBudget(call: ModelToolCall, content: BoundedToolContent, budget: ToolContentBudget): void {
  const argumentsValue = asRecord(call.arguments);
  if (argumentsValue === undefined || typeof argumentsValue[content.field] !== "string") return; // Tool parser owns shape errors.
  const characters = (argumentsValue[content.field] as string).length;
  const tokens = estimateTextTokens(JSON.stringify(call.arguments));
  if (characters > budget.maxContentCharacters || tokens > budget.maxArgumentsTokens) {
    throw badRequest(`Tool content exceeds this turn's output budget: ${content.field} has ${characters} characters (limit ${budget.maxContentCharacters}); serialized arguments use ${tokens} estimated tokens (limit ${budget.maxArgumentsTokens}). No write was executed. ${content.continuationInstruction}`);
  }
}

/** Compact committed receipts, not generated/truncated arguments, own continuation. */
export function boundedAuthoringContext(
  tools: ReadonlyMap<string, BoundedToolContent>, budget: ToolContentBudget, state: OutputBudgetState,
  evidence: readonly AgentLoopToolEvidence[],
): string | undefined {
  if (tools.size === 0) return undefined;
  const latest = new Map<string, unknown>();
  for (const item of evidence) {
    if (item.isError || item.operationStatus === "unknown" || !tools.has(item.toolName)) continue;
    let receipt: Record<string, unknown> | undefined;
    try { receipt = asRecord(JSON.parse(item.result)); } catch { continue; }
    const targetField = tools.get(item.toolName)!.targetField;
    const target = receipt?.[targetField];
    if (receipt === undefined || typeof target !== "string") continue;
    const inspection = asRecord(receipt.inspection);
    latest.delete(`${item.toolName}:${target}`);
    latest.set(`${item.toolName}:${target}`, {
      toolName: item.toolName, toolCallId: item.toolCallId, target,
      revisionId: receipt.revisionId, bytes: receipt.bytes, writtenBytes: receipt.writtenBytes,
      mode: receipt.mode, sha256: receipt.sha256, resultRef: item.resultRef ?? receipt.resultRef,
      tail: inspection?.tail,
    });
  }
  return JSON.stringify({
    schema: "agentloop.boundedAuthoringContext/v1", budget, recovery: state,
    committedWrites: [...latest.values()].slice(-8),
    instruction: "Use the matching committed write receipt and original task to continue only the missing content. Do not recreate or repeat committed chunks. A truncated unexecuted call contributes no content. A write receipt proves bytes, not semantic completion. Keep authoring until the requested content is complete, then verify the latest revision and submit a standalone completion candidate. If an action's effect is unknown, reconcile it before appending; never replay an uncertain append.",
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
