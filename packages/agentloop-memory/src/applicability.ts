import type { MemoryApplicability, MemoryRevision } from "./types.ts";

/** Exact selectors restrict scope. Text similarity only ranks suggestions; it
 * never proves a natural-language condition or grants authority. */
export function applicabilityMatches(scope: MemoryApplicability, context: Readonly<Record<string, unknown>>): boolean {
  const intersects = (key: string, expected: readonly unknown[]) => {
    const actual = context[key];
    return (Array.isArray(actual) ? actual : [actual]).some(item => expected.includes(item));
  };
  return Object.entries(scope.context ?? {}).every(([key, values]) => intersects(key, values))
    && !Object.entries(scope.excludedContext ?? {}).some(([key, values]) => intersects(key, values));
}

export function relevanceScore(revision: MemoryRevision, goal: unknown): number {
  if (typeof goal !== "string" || !goal.trim()) return 0;
  const pattern = revision.value.settlementPattern as Record<string, unknown> | undefined;
  const terms = (text: string): Set<string> => new Set((text.toLowerCase().match(/[a-z][\w:-]+|[\p{Script=Han}]+/gu) ?? []).flatMap(term =>
    /\p{Script=Han}/u.test(term) ? Array.from({ length: Math.max(1, term.length - 1) }, (_, i) => term.slice(i, i + 2)) : [term]));
  const query = terms(goal);
  // Historical answers remain searchable in the audit UI, but must not select
  // a method for a new task. Rank experiences by their transferable content.
  const stringsIn = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsIn) : [];
  const methodText = ["classicPath", "toolUsage", "reusableKnowledge", "failureLessons"].flatMap(section =>
    Array.isArray(pattern?.[section]) ? (pattern[section] as Record<string, unknown>[]).filter(row => row && typeof row === "object").flatMap(row =>
      ["objective", "purpose", "rule", "trigger", "action", "conditions", "verification", "lesson", "nextAction"].flatMap(key => stringsIn(row[key]))) : []);
  const description = terms([pattern?.goalSummary, pattern?.title, ...(Array.isArray(pattern?.keywords) ? pattern.keywords : []),
    ...(revision.experienceMaturity ? methodText : [revision.contentMarkdown])].filter(item => typeof item === "string").join(" "));
  return [...query].filter(term => description.has(term)).length / Math.max(1, query.size);
}
