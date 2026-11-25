import { createHash } from "node:crypto";
import type { CommittedDecisionRecords } from "./committed-decision-records.ts";
import type { CurrentDecisionView } from "./current-decision-view.ts";
import { parseRuntimeResultRef, type RuntimeResultRef } from "./runtime-result.ts";

/** Exact committed observations, not model assertions or another fact store. */
export interface CurrentEvidence {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly resultRef: RuntimeResultRef;
  readonly arguments: unknown;
  readonly assistantStatement?: string;
  readonly result: string;
  readonly executionOutcome: CommittedDecisionRecords["observations"][number]["executionOutcome"];
  readonly occurrences: number;
}

/** Default evidence lifecycle. Only identity/version/equality, never relevance
 * guesses, are sufficient to retire content without a semantic declaration.
 */
export function deriveCurrentEvidence(input: {
  readonly records: CommittedDecisionRecords;
  readonly currentView?: CurrentDecisionView;
  readonly candidates: ReadonlySet<string>;
  readonly carried: ReadonlySet<string>;
  readonly required: ReadonlySet<string>;
  /** Worst-case character budget; oversized bodies remain in native transport. */
  readonly maxCharacters?: number;
  /** Large explicit reads keep the existing native read-window lifecycle. */
  readonly maxEntryCharacters?: number;
}) {
  const entries = new Map<string, CurrentEvidence>();
  const owners = new Map<string, CommittedDecisionRecords["checkpoints"][number]>();
  const identities = new Map<string, number>();
  const materialized = new Set<string>();
  const historical = new Set<string>();
  const nativeFallback = new Set<string>();
  const observations = new Map(input.records.observations.map(observation => [observation.toolCallId, observation]));
  const lastCheckpointPosition = Math.max(-1, ...input.records.checkpoints.map(checkpoint => checkpoint.position));
  for (const checkpoint of input.records.checkpoints) for (const call of checkpoint.toolCalls) owners.set(call.id, checkpoint);
  for (const observation of input.records.observations) {
    const ref = observation.resultRef ?? parseRuntimeResultRef(parse(observation.content)?.resultRef);
    if (ref) identities.set(ref.resultId, (identities.get(ref.resultId) ?? 0) + 1);
  }
  for (const observation of input.records.observations) {
    if (!input.candidates.has(observation.toolCallId) || input.carried.has(observation.toolCallId)) continue;
    const checkpoint = owners.get(observation.toolCallId)!;
    if (!checkpoint.toolCalls.every(call => {
      const result = observations.get(call.id);
      const ref = result?.resultRef ?? (result ? parseRuntimeResultRef(parse(result.content)?.resultRef) : undefined);
      return input.candidates.has(call.id) && ref && identities.get(ref.resultId) === 1;
    })) continue;
    const call = checkpoint.toolCalls.find(call => call.id === observation.toolCallId)!;
    const value = parse(observation.content);
    const ref = observation.resultRef ?? parseRuntimeResultRef(value?.resultRef);
    // Ambiguous/missing identities never authorize removal of native content.
    if (!ref || identities.get(ref.resultId) !== 1) continue;
    materialized.add(observation.toolCallId);
    const source = readVersion(observation.name, value);
    const current = source && input.currentView?.workProducts.objects.find(object => object.path === source.path);
    // Preserve the immediate observation even if an external change overtook
    // it, and retain explicitly required historical evidence. File deletion
    // alone does not erase earlier read content or resolve a semantic issue.
    const consumed = lastCheckpointPosition > Math.max(checkpoint.position, observation.position);
    if (consumed && !input.required.has(observation.toolCallId) && !checkpoint.content
      && source && current?.presence === "present" && current.sha256 && current.sha256 !== source.sha256) {
      historical.add(observation.toolCallId);
      continue;
    }
    const args = stripContext(call.arguments);
    // Only exact equivalent reads coalesce. Two successful writes are two
    // effects even when they returned identical text. Every changed selector,
    // scope, error, caveat or version produces a distinct entry.
    const key = checkpoint.basis?.toolEffects[call.name] === "read" && !input.required.has(observation.toolCallId)
      ? hash(JSON.stringify([call.name, args, withoutResultRef(observation.content), checkpoint.content, observation.executionOutcome]))
      : observation.toolCallId;
    const previous = entries.get(key);
    if (previous) historical.add(previous.toolCallId);
    entries.set(key, {
      toolCallId: observation.toolCallId, toolName: observation.name, resultRef: ref, arguments: args,
      ...(checkpoint.content ? { assistantStatement: checkpoint.content } : {}),
      result: observation.content, executionOutcome: observation.executionOutcome,
      occurrences: (previous?.occurrences ?? 0) + 1,
    });
  }
  let remaining = input.maxCharacters ?? Number.POSITIVE_INFINITY;
  const selected = [...entries.values()].filter(entry => {
    const characters = JSON.stringify(entry).length;
    if (characters <= remaining && entry.result.length <= (input.maxEntryCharacters ?? Number.POSITIVE_INFINITY)) {
      remaining -= characters; return true;
    }
    // This is a transport fallback, never a truncated or apparently complete
    // entry. Its original exchange remains available to the ordinary assembler.
    materialized.delete(entry.toolCallId);
    nativeFallback.add(entry.toolCallId);
    return false;
  });
  // Native protocols release complete batches. A budget failure in one member
  // must not duplicate its siblings in both native and structured transport.
  for (const checkpoint of input.records.checkpoints) {
    if (checkpoint.toolCalls.some(call => materialized.has(call.id))
      && !checkpoint.toolCalls.every(call => materialized.has(call.id) || input.carried.has(call.id))) {
      for (const call of checkpoint.toolCalls) { materialized.delete(call.id); historical.delete(call.id); nativeFallback.add(call.id); }
    }
  }
  return { entries: selected.filter(entry => materialized.has(entry.toolCallId)), materialized, historical, nativeFallback };
}

function readVersion(name: string, value: Record<string, unknown> | undefined): { path: string; sha256: string } | undefined {
  // These are kernel-owned read receipts, not arbitrary host stdout fields.
  if (!["computer_read_json", "computer_read_file"].includes(name) || !value) return undefined;
  const location = record(value.contentLocation);
  const path = value.schema === "agentloop.jsonRead/v1" ? value.path : location?.path ?? value.path;
  const sha256 = value.schema === "agentloop.jsonRead/v1" ? value.sha256 : location?.sha256 ?? value.sha256;
  return typeof path === "string" && typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256) ? { path, sha256 } : undefined;
}
function stripContext(value: unknown): unknown {
  if (!record(value)) return value;
  const { _agentloopContext: _, ...args } = value as Record<string, unknown>;
  return args;
}
function withoutResultRef(content: string): unknown {
  const value = parse(content);
  // Do not normalize duplicate keys, whitespace or unsafe numeric values.
  if (!value || JSON.stringify(value) !== content) return content;
  const { resultRef: _, ...body } = value;
  return body;
}
function parse(content: string): Record<string, unknown> | undefined {
  try { return record(JSON.parse(content)); } catch { return undefined; }
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
