import type { ResolvedTemporalScope } from "./runtime-clock.ts";

interface Coverage { startInclusive?: unknown; endExclusive?: unknown; complete?: unknown; timeZone?: unknown }

function coverages(value: unknown, depth = 0): Coverage[] {
  if (depth > 4) return [];
  if (typeof value === "string") { try { return coverages(JSON.parse(value), depth + 1); } catch { return []; } }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const own = record.temporalCoverage;
  return [
    ...(own !== null && typeof own === "object" && !Array.isArray(own) ? [own as Coverage] : []),
    ...[record.data, record.evidenceReceipt, record.stdout, record.content].flatMap((child) => coverages(child, depth + 1)),
  ];
}

/** Validate declared time receipts, not language keywords or provider names.
 * Sources without this contract remain subject to semantic assessment. */
export function temporalEvidenceGap(scope: ResolvedTemporalScope | undefined, results: readonly string[]): string | undefined {
  if (scope === undefined) return undefined;
  const receipts = results.flatMap((result) => coverages(result));
  if (receipts.length === 0) return undefined;
  const requiredStart = Date.parse(scope.startInclusive);
  const requiredEnd = Date.parse(scope.endExclusive);
  const intervals = receipts.flatMap((receipt) => {
    if (receipt.complete !== true || (receipt.timeZone !== undefined && receipt.timeZone !== scope.timeZone)
      || typeof receipt.startInclusive !== "string" || typeof receipt.endExclusive !== "string") return [];
    const start = Date.parse(receipt.startInclusive); const end = Date.parse(receipt.endExclusive);
    return Number.isFinite(start) && Number.isFinite(end) && start < end ? [{ start, end }] : [];
  }).sort((a, b) => a.start - b.start);
  let coveredUntil = requiredStart;
  const gaps: { startInclusive: string; endExclusive: string }[] = [];
  for (const interval of intervals) {
    if (interval.end <= coveredUntil) continue;
    if (interval.start > coveredUntil) {
      gaps.push({ startInclusive: new Date(coveredUntil).toISOString(), endExclusive: new Date(Math.min(interval.start, requiredEnd)).toISOString() });
      if (interval.start >= requiredEnd) { coveredUntil = requiredEnd; break; }
    }
    coveredUntil = Math.max(coveredUntil, interval.end);
    if (coveredUntil >= requiredEnd) break;
  }
  if (coveredUntil < requiredEnd) gaps.push({ startInclusive: new Date(coveredUntil).toISOString(), endExclusive: new Date(requiredEnd).toISOString() });
  if (gaps.length === 0) return undefined;
  return `Declared source receipts do not establish complete coverage of ${scope.startInclusive} <= timestamp < ${scope.endExclusive} in ${scope.timeZone}. Unverified intervals: ${JSON.stringify(gaps)}. Literal date keyword searches and truncated pages do not establish this range.`;
}
