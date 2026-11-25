import type { AgentLoopToolEvidence, ModelToolDefinition } from "./contracts.ts";
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
  /** Advisory share of invocation output for recovery; never an admission limit. */
  readonly outputFraction?: number;
}

export function parseOutputBudgetState(value: unknown): OutputBudgetState | undefined {
  const record = asRecord(value);
  if (record === undefined || !Number.isSafeInteger(record.shrinkCount) || !Number.isSafeInteger(record.consecutiveTruncations)
    || (record.shrinkCount as number) < 0 || (record.consecutiveTruncations as number) < 0) return undefined;
  return { shrinkCount: record.shrinkCount as number, consecutiveTruncations: record.consecutiveTruncations as number };
}

export function toolContentBudget(maxOutputTokens: number, state: OutputBudgetState, policy: ToolContentBudgetPolicy = {}): ToolContentBudget {
  const fraction = policy.outputFraction ?? 1;
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) throw badRequest("contentBudgetPolicy.outputFraction must be greater than 0 and at most 1");
  const target = Math.max(1, Math.floor(maxOutputTokens * fraction / 2 ** Math.min(state.shrinkCount, 20)));
  // These are planning hints after actual output truncation, not a second
  // admission gate on complete native calls the provider already returned.
  return { maxOutputTokens, maxContentCharacters: Math.min(48_000, target * 4), maxArgumentsTokens: target };
}

export function projectBoundedToolDefinition(
  definition: ModelToolDefinition, content: BoundedToolContent, budget: ToolContentBudget,
): ModelToolDefinition {
  return {
    ...definition,
    description: `${definition.description} Prefer one complete write when the requested content fits the Tool schema and the model output window. Output estimates are advisory and do not narrow this schema. After actual output truncation, aim for a shorter payload (approximately ${budget.maxArgumentsTokens} tokens); do not repeat the truncated call. Produce at most one content call for the same target per turn. ${content.continuationInstruction}`,
  };
}

/** Compact committed receipts, not generated/truncated arguments, own continuation. */
export function boundedAuthoringContext(
  tools: ReadonlyMap<string, BoundedToolContent>, budget: ToolContentBudget, state: OutputBudgetState,
  evidence: readonly AgentLoopToolEvidence[],
): string | undefined {
  if (tools.size === 0) return undefined;
  const latest = new Map<string, unknown>();
  const targetFields = [...new Set([...tools.values()].map(tool => tool.targetField))];
  for (const item of evidence) {
    if (item.isError || item.operationStatus === "unknown") continue;
    let receipt: Record<string, unknown> | undefined;
    try { receipt = asRecord(JSON.parse(item.result)); } catch { continue; }
    if (receipt === undefined) continue;
    const inspection = asRecord(receipt.inspection);
    // A later revision-bound mutation (for example a patch) supersedes the old
    // write receipt for the same target. Never keep advertising its stale tail.
    if (!tools.has(item.toolName) && (typeof receipt.revisionId !== "string" || inspection === undefined)) continue;
    const after = asRecord(receipt.after);
    for (const targetField of targetFields) {
      const target = receipt[targetField];
      if (typeof target !== "string") continue;
      latest.delete(`${targetField}:${target}`);
      latest.set(`${targetField}:${target}`, {
        toolName: item.toolName, toolCallId: item.toolCallId, target,
        revisionId: receipt.revisionId, bytes: receipt.bytes ?? after?.bytes, writtenBytes: receipt.writtenBytes,
        totalLines: receipt.totalLines ?? inspection?.totalLines,
        mode: receipt.mode ?? receipt.operation, sha256: receipt.sha256 ?? after?.sha256 ?? inspection?.sha256,
        resultRef: item.resultRef ?? receipt.resultRef, tail: inspection?.tail,
      });
    }
  }
  return JSON.stringify({
    schema: "agentloop.boundedAuthoringContext/v1", budget: { ...budget, enforcement: "advisory" }, recovery: state,
    committedWrites: [...latest.values()].slice(-8),
    instruction: "Prefer one complete write when it fits the Tool schema and model output window; splitting is not required. After an actual output truncation, use a shorter complete call. For an existing file, use its latest committed revision and exact tail to continue only the missing content; a later patch supersedes an earlier write. Do not recreate an existing path with mode=create or replace already completed content just to resume. A truncated unexecuted call contributes no content. A receipt proves bytes, not semantic completion. Complete the user's requested content before verifying the latest revision and submitting a standalone completion candidate. If an action's effect is unknown, reconcile it before appending; never replay an uncertain append.",
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
