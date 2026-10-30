import type {
  ExperienceSettlementPattern,
  MemoryScope,
  MemoryStore,
  TaskGroupSearchInput,
  TaskGroupSearchResult,
} from "./types.ts";

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function patternOf(value: Readonly<Record<string, unknown>>): ExperienceSettlementPattern | undefined {
  const pattern = value.settlementPattern;
  return record(pattern) && pattern.schema === "agentloop.experienceSettlement/v1" && pattern.phase === "procedure"
    ? pattern as unknown as ExperienceSettlementPattern
    : undefined;
}

function textTerms(pattern: ExperienceSettlementPattern, content: string): readonly string[] {
  return [
    pattern.title,
    pattern.goalSummary,
    pattern.reuseRule,
    ...(pattern.keywords ?? []),
    ...pattern.classicPath.map((step) => step.objective),
    ...pattern.toolUsage.map((tool) => tool.toolName),
    content,
  ].filter((value): value is string => typeof value === "string").join(" ").toLocaleLowerCase().split(/[^\p{L}\p{N}_:-]+/u).filter((value) => value.length > 1);
}

function fingerprintScore(left: Readonly<Record<string, unknown>> | undefined, right: Readonly<Record<string, unknown>>): number {
  if (left === undefined) return 0;
  const capabilities = (value: Readonly<Record<string, unknown>>): readonly string[] => Array.isArray(value.capabilityIds)
    ? value.capabilityIds.filter((item): item is string => typeof item === "string")
    : [];
  const leftCapabilities = new Set(capabilities(left));
  const rightCapabilities = new Set(capabilities(right));
  const capabilityOverlap = [...leftCapabilities].some((value) => rightCapabilities.has(value));
  if (typeof left.taskKind === "string" && typeof right.taskKind === "string" && left.taskKind !== right.taskKind && !capabilityOverlap) return -1;
  const keys = ["taskKind", "domain", "artifactKind", "sourceKind", "capabilityIds"] as const;
  const comparable = keys.filter((key) => key === "capabilityIds"
    ? leftCapabilities.size > 0 || rightCapabilities.size > 0
    : typeof left[key] === "string" || typeof right[key] === "string");
  if (comparable.length === 0) return 0;
  const matching = comparable.filter((key) => key === "capabilityIds"
    ? capabilityOverlap
    : typeof left[key] === "string" && left[key] === right[key]).length;
  const minimum = comparable.length === 1 ? 1 : 2;
  return matching >= minimum && matching / comparable.length >= 0.5 ? matching / comparable.length : 0;
}

/**
 * Retrieve bounded Task Group candidates after scope and goal-family filtering.
 * This is deliberately deterministic; an LLM may judge a candidate later but
 * cannot widen the tenant/user scope or bypass the task fingerprint gate.
 */
export async function searchTaskGroupCandidates(
  store: MemoryStore,
  scope: MemoryScope,
  input: TaskGroupSearchInput = {},
): Promise<readonly TaskGroupSearchResult[]> {
  const queryTerms = [...new Set((input.query ?? []).flatMap((query) => query.toLocaleLowerCase().split(/[^\p{L}\p{N}_:-]+/u).filter((term) => term.length > 1)))];
  const results: TaskGroupSearchResult[] = [];
  for (const entry of await store.active(scope)) {
    if (entry.item.kind !== "experience" || entry.item.subtype !== "experience.procedure" || entry.revision.experienceMaturity !== "procedure") continue;
    const pattern = patternOf(entry.revision.value);
    if (pattern === undefined) continue;
    const fingerprint = fingerprintScore(input.taskFingerprint, pattern.applicability.taskFingerprint);
    if (fingerprint < 0) continue;
    const terms = textTerms(pattern, entry.revision.contentMarkdown);
    const matchedTerms = queryTerms.filter((term) => terms.includes(term));
    const score = fingerprint * 100 + matchedTerms.length * 5 + Math.min(1, entry.revision.confidence);
    if (fingerprint === 0 && matchedTerms.length === 0 && input.taskFingerprint !== undefined) continue;
    results.push({ item: entry.item, revision: entry.revision, score, matchedTerms });
  }
  return results.sort((left, right) => right.score - left.score || right.revision.createdAt - left.revision.createdAt).slice(0, Math.max(0, input.limit ?? 8));
}

export function taskGroupPatternFromRevision(revision: { readonly value: Readonly<Record<string, unknown>> }): ExperienceSettlementPattern | undefined {
  return patternOf(revision.value);
}
