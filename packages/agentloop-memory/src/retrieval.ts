import type { MemoryRevision } from "./types.ts";

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const words = (text: string): string[] => [...segmenter.segment(text.normalize("NFKC").toLowerCase())]
  .filter(item => item.isWordLike && item.segment.length > 1).map(item => item.segment);
// Chinese segmentation has ambiguous word boundaries; Han bigrams supply a
// second view. Arbitrary English character overlap is too weak for admission.
const grams = (text: string): Set<string> => new Set((text.normalize("NFKC").match(/[\p{Script=Han}]{2,}/gu) ?? [])
  .flatMap(word => Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))));
const strings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : [];

/** Only transferable content participates. Historical answers and support
 * ledgers cannot attract a new task to a method. */
export function retrievalText(revision: MemoryRevision): string {
  if (revision.value.taskKnowledge) return JSON.stringify(revision.value.taskKnowledge);
  if (!revision.experienceMaturity) return revision.contentMarkdown;
  const pattern = revision.value.settlementPattern as Record<string, unknown> | undefined;
  const methods = ["classicPath", "toolUsage", "reusableKnowledge", "failureLessons"].flatMap(section =>
    Array.isArray(pattern?.[section]) ? (pattern[section] as Record<string, unknown>[]).filter(row => row && typeof row === "object").flatMap(row =>
      ["objective", "toolName", "purpose", "rule", "trigger", "action", "conditions", "verification", "lesson", "nextAction"].flatMap(key => strings(row[key]))) : []);
  return [pattern?.title, pattern?.goalSummary, ...strings(pattern?.keywords), ...strings(pattern?.retrievalQueries), ...methods].filter(item => typeof item === "string").join(" ");
}

export interface RetrievalScore {
  readonly score: number;
  readonly lexical: number;
  readonly character: number;
  readonly fingerprint: number;
  readonly matchedTerms: readonly string[];
}

/** Local lexical/character/structured hybrid, with reciprocal rank fusion.
 * No network, embedding model or claim of semantic equivalence. Callers must
 * enforce scope/activation/authority before ranking this candidate set. */
export function rankMemoryRevisions(revisions: readonly MemoryRevision[], query: string, context: Readonly<Record<string, unknown>> = {}): ReadonlyMap<string, RetrievalScore> {
  const queryWords = [...new Set(words(query))], queryGrams = grams(query);
  const documents = revisions.map(revision => {
    const text = retrievalText(revision), terms = words(text), frequencies = new Map<string, number>();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    return { revision, terms, frequencies, grams: grams(text) };
  });
  const averageLength = documents.reduce((sum, doc) => sum + doc.terms.length, 0) / Math.max(1, documents.length) || 1;
  const df = new Map(queryWords.map(term => [term, documents.filter(doc => doc.frequencies.has(term)).length]));
  const scores = documents.map(doc => {
    const matchedTerms = queryWords.filter(term => doc.frequencies.has(term));
    const lexical = matchedTerms.reduce((sum, term) => {
      const frequency = doc.frequencies.get(term)!;
      const idf = Math.log(1 + (documents.length - df.get(term)! + 0.5) / (df.get(term)! + 0.5));
      return sum + idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * doc.terms.length / averageLength));
    }, 0);
    const overlap = [...queryGrams].filter(gram => doc.grams.has(gram)).length;
    const character = overlap / Math.max(1, Math.sqrt(queryGrams.size * doc.grams.size));
    const pattern = doc.revision.value.settlementPattern as { applicability?: { taskFingerprint?: Record<string, unknown> } } | undefined;
    const fp = pattern?.applicability?.taskFingerprint ?? {};
    const keys = ["taskKind", "domain", "artifactKind", "sourceKind", "capabilityIds"];
    const fingerprint = keys.filter(key => context[key] !== undefined && fp[key] !== undefined).reduce((sum, key) =>
      sum + (Array.isArray(context[key]) && Array.isArray(fp[key])
        ? Number((context[key] as unknown[]).some(value => (fp[key] as unknown[]).includes(value))) : Number(context[key] === fp[key])), 0);
    return { id: doc.revision.id, score: 0, lexical, character, fingerprint, matchedTerms };
  });
  for (const field of ["lexical", "character", "fingerprint"] as const) {
    const ranked = scores.filter(row => row[field] > 0).sort((a, b) => b[field] - a[field] || a.id.localeCompare(b.id));
    let rank = 1;
    ranked.forEach((row, i) => {
      if (i && ranked[i - 1]![field] !== row[field]) rank = i + 1;
      // Structured similarity never makes a textually unrelated item eligible.
      if (row.lexical > 0 || row.character > 0 || !query.trim()) row.score += 1 / (60 + rank);
    });
  }
  return new Map(scores.map(({ id, ...row }) => [id, row]));
}
