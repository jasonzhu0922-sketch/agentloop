import type { ModelInvocation } from "./contracts.ts";

/** One immutable reference instant per Run, not a moving date per model phase. */
export interface RuntimeClock {
  readonly schema: "agentloop.runtimeClock/v1";
  readonly source: "runtime";
  readonly anchorDateTimeIso: string;
  readonly timeZone: string;
  readonly timeZoneSource: "runtime_configuration" | "runtime_host";
  readonly localDate: string;
}

export function localDateAt(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const part = (name: string) => parts.find((item) => item.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function parseOffsetTimestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) throw new Error("Time bounds require valid RFC3339 timestamps with explicit offsets");
  const date = value.slice(0, 10);
  const civil = Date.parse(`${date}T00:00:00Z`);
  const result = Date.parse(value);
  if (!Number.isFinite(civil) || new Date(civil).toISOString().slice(0, 10) !== date || !Number.isFinite(result)) throw new Error("Invalid calendar timestamp");
  return result;
}

export function createRuntimeClock(now = Date.now(), timeZone?: string): RuntimeClock {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return Object.freeze({
    schema: "agentloop.runtimeClock/v1", source: "runtime", anchorDateTimeIso: new Date(now).toISOString(),
    timeZone: zone, timeZoneSource: timeZone === undefined ? "runtime_host" : "runtime_configuration",
    localDate: localDateAt(now, zone),
  });
}

/** Apply at the common model boundary, including resolver, retries and recovery. */
export function withRuntimeClock(invocation: ModelInvocation, clock: RuntimeClock, temporalScope?: ResolvedTemporalScope, recurringTime?: RecurringTimeCondition): ModelInvocation {
  return { ...invocation, systemPrompt: [invocation.systemPrompt,
    '<runtime_time_context source="server">', JSON.stringify(clock),
    "This is the authoritative reference for relative time in this Run. Use its localDate and timeZone, not model knowledge, historical transcripts, or source timestamps, for today/now. Keep this reference across phases and midnight. A user-supplied historical or hypothetical reference is a task scope, not a change to the runtime clock. Never promote a model-inferred date into an explicit user constraint. Use received/created/modified timestamps according to the declared tool contract; keyword matches do not establish date coverage or exhaustive counts.",
    "</runtime_time_context>",
    ...(temporalScope === undefined ? [] : ['<resolved_temporal_scope source="server" semantics="derived-not-user-quote">', JSON.stringify(temporalScope), "Use this one interval throughout planning, evidence acquisition, aggregation, artifact production and assessment. Derive query filters and display buckets from the same startInclusive/endExclusive in timeZone; do not independently expand to extra periods, drop a boundary bucket, or switch to another interpretation in a later stage. Retain partial-period and missing-period caveats. Tool receipts must establish the requested scope and completeness before asserting exhaustive counts or zero results.", "</resolved_temporal_scope>"]),
    ...(recurringTime === undefined ? [] : ['<recurring_time_condition source="user-quote">', JSON.stringify(recurringTime), "This is a recurring condition, not a continuous date range. Preserve the quoted condition alongside any separate date range. Resolve ambiguous clock times, time zone and cross-day attribution using the task's authorized context; do not present assumptions as user-provided facts.", "</recurring_time_condition>"]),
  ].join("\n") };
}

/** A user-quoted recurring condition; its business interpretation is not a Runtime clock calculation. */
export interface RecurringTimeCondition {
  readonly kind: "recurring";
  readonly expression: string;
}

export function parseRecurringTimeCondition(value: unknown, userInputs?: readonly string[]): RecurringTimeCondition | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "kind" && key !== "expression") || record.kind !== "recurring"
    || typeof record.expression !== "string" || record.expression.trim() !== record.expression || !record.expression || record.expression.length > 240) return undefined;
  if (userInputs !== undefined && !userInputs.some((input) => input.includes(record.expression as string))) return undefined;
  return { kind: "recurring", expression: record.expression };
}

export interface ResolvedTemporalScope {
  readonly expression: string;
  readonly basis: "runtime_clock" | "user_explicit";
  readonly timeZone: string;
  readonly anchorDateTimeIso?: string;
  readonly alignment?: "calendar_month";
  readonly startInclusive: string;
  readonly endExclusive: string;
}

export function parseResolvedTemporalScope(value: unknown): ResolvedTemporalScope | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.expression !== "string" || !record.expression || (record.basis !== "runtime_clock" && record.basis !== "user_explicit") || typeof record.timeZone !== "string"
    || typeof record.startInclusive !== "string" || typeof record.endExclusive !== "string" || !Number.isFinite(Date.parse(record.startInclusive)) || !(Date.parse(record.startInclusive) < Date.parse(record.endExclusive))) return undefined;
  try { localDateAt(Date.parse(record.startInclusive), record.timeZone); } catch { return undefined; }
  if (record.basis === "runtime_clock" && (typeof record.anchorDateTimeIso !== "string" || !Number.isFinite(Date.parse(record.anchorDateTimeIso)))) return undefined;
  return value as ResolvedTemporalScope;
}

/** ISO civil dates in intent are user-owned literals, not clock-derived claims.
 * Computed dates belong only in the separately typed temporal scope. */
export function assertNoInferredCalendarDates(fields: readonly string[], userInputs: readonly string[]): void {
  const literalDates = new Set(userInputs.flatMap((input) => input.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []));
  if (fields.some((field) => (field.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []).some((date) => !literalDates.has(date)))) {
    throw new Error("Keep runtime-derived ISO dates out of effectiveGoal, taskIntent purposes and userConstraints. Preserve the user's relative wording there; put computed dates only in temporalScope.");
  }
}

// Convert a civil day boundary in an IANA zone without treating every day as
// 24 hours. Searching UTC instants also handles non-hour offsets and DST.
export function startOfLocalDay(date: string, timeZone: string): number {
  const nominal = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 10) !== date) throw new Error("Invalid calendar date");
  let low = nominal - 36 * 3_600_000;
  let high = nominal + 36 * 3_600_000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (localDateAt(mid, timeZone) < date) low = mid + 1;
    else high = mid;
  }
  if (localDateAt(low, timeZone) !== date) throw new Error("Calendar date does not exist in this time zone");
  return low;
}

export function resolveTemporalScope(value: unknown, clock: RuntimeClock, userInputs: readonly string[]): ResolvedTemporalScope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("temporalScope must be an object");
  const spec = value as Record<string, unknown>;
  if (typeof spec.expression !== "string" || spec.expression.length === 0 || spec.expression.length > 240) throw new Error("temporalScope.expression must quote the current or selected prior user's time requirement exactly");
  // Models often omit typographic spaces around Han characters or numbers.
  // Anchor those equivalent spellings back to the actual user substring;
  // never normalize away word boundaries (e.g. 'not able' != 'notable').
  const parts = spec.expression.trim().split(/(\s+)/u);
  const flexible = /[\p{Script=Han}\d]/u;
  const pattern = parts.map((part, index) => /^\s+$/u.test(part)
    ? (flexible.test(parts[index - 1]?.slice(-1) ?? "") || flexible.test(parts[index + 1]?.slice(0, 1) ?? "") ? "\\s*" : "\\s+")
    : [...part].map((char) => flexible.test(char) ? `\\s*${char}\\s*` : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("")).join("");
  const expression = userInputs.map((input) => input.match(new RegExp(pattern, "u"))?.[0].trim()).find((quote) => quote);
  if (!expression) throw new Error(`temporalScope.expression must quote one contiguous current or selected prior user's time requirement. Rejected expression: ${JSON.stringify(spec.expression)}. Do not combine separated clauses or add interpretation.`);
  const timeZone = spec.timeZone === undefined ? clock.timeZone : String(spec.timeZone);
  localDateAt(Date.parse(clock.anchorDateTimeIso), timeZone); // validate IANA zone
  let start: number;
  let end: number;
  if (spec.basis === "runtime_clock") {
    if (timeZone !== clock.timeZone && !userInputs.some((input) => input.includes(timeZone))) throw new Error("A different temporal timeZone must be explicitly requested by the user");
    if (spec.alignment !== "calendar_month" && (spec.startMonthOffset !== undefined || spec.endMonthOffset !== undefined)) throw new Error("Month offsets require calendar_month alignment");
    if (spec.alignment === "elapsed_seconds") {
      const offsets = [spec.startSecondOffset, spec.endSecondOffset];
      if (!offsets.every((offset) => Number.isSafeInteger(offset) && Math.abs(offset as number) <= 31_622_400_000)) throw new Error("Elapsed ranges require integer startSecondOffset/endSecondOffset");
      start = Date.parse(clock.anchorDateTimeIso) + Number(spec.startSecondOffset) * 1000;
      end = Date.parse(clock.anchorDateTimeIso) + Number(spec.endSecondOffset) * 1000;
    } else if (spec.alignment === "calendar_month") {
      if (spec.startDayOffset !== undefined || spec.endDayOffset !== undefined
        || spec.startSecondOffset !== undefined || spec.endSecondOffset !== undefined) throw new Error("Calendar-month ranges use month offsets only");
      if (spec.endAtReferenceInstant !== undefined && typeof spec.endAtReferenceInstant !== "boolean") throw new Error("endAtReferenceInstant must be boolean");
      if (spec.endAtReferenceInstant === true && spec.endMonthOffset !== undefined) throw new Error("Use either endAtReferenceInstant or endMonthOffset, not both");
      const offsets = [spec.startMonthOffset, ...(spec.endAtReferenceInstant === true ? [] : [spec.endMonthOffset])];
      if (!offsets.every((offset) => Number.isSafeInteger(offset) && Math.abs(offset as number) <= 12_000)) throw new Error("Relative calendar-month ranges require integer startMonthOffset/endMonthOffset");
      const reference = new Date(`${localDateAt(Date.parse(clock.anchorDateTimeIso), timeZone).slice(0, 7)}-01T00:00:00Z`);
      const month = (offset: unknown) => {
        const date = new Date(reference);
        date.setUTCMonth(date.getUTCMonth() + Number(offset));
        return date.toISOString().slice(0, 10);
      };
      start = startOfLocalDay(month(spec.startMonthOffset), timeZone);
      end = spec.endAtReferenceInstant === true ? Date.parse(clock.anchorDateTimeIso) : startOfLocalDay(month(spec.endMonthOffset), timeZone);
    } else {
      if (spec.alignment !== undefined && spec.alignment !== "calendar_day") throw new Error("Unknown temporal alignment");
      if (spec.endAtReferenceInstant !== undefined && typeof spec.endAtReferenceInstant !== "boolean") throw new Error("endAtReferenceInstant must be boolean");
      if (spec.endAtReferenceInstant === true && spec.endDayOffset !== undefined) throw new Error("Use either endAtReferenceInstant or endDayOffset, not both");
      const offsets = [spec.startDayOffset, ...(spec.endAtReferenceInstant === true ? [] : [spec.endDayOffset])];
      if (!offsets.every((offset) => Number.isSafeInteger(offset) && Math.abs(offset as number) <= 366_000)) throw new Error("Relative calendar ranges require integer startDayOffset/endDayOffset from the runtime's local day");
      const reference = Date.parse(`${localDateAt(Date.parse(clock.anchorDateTimeIso), timeZone)}T00:00:00Z`);
      const day = (offset: unknown) => new Date(reference + Number(offset) * 86_400_000).toISOString().slice(0, 10);
      start = startOfLocalDay(day(spec.startDayOffset), timeZone);
      end = spec.endAtReferenceInstant === true ? Date.parse(clock.anchorDateTimeIso) : startOfLocalDay(day(spec.endDayOffset), timeZone);
    }
    if (spec.startInclusive !== undefined || spec.endExclusive !== undefined) throw new Error("Relative scopes use offsets, not model-invented absolute dates");
  } else if (spec.basis === "user_explicit") {
    start = parseOffsetTimestamp(spec.startInclusive); end = parseOffsetTimestamp(spec.endExclusive);
  } else throw new Error("temporalScope.basis must be runtime_clock or user_explicit");
  if (start >= end) throw new Error("temporalScope must have startInclusive before endExclusive");
  return { expression, basis: spec.basis, timeZone,
    ...(spec.basis === "runtime_clock" ? { anchorDateTimeIso: clock.anchorDateTimeIso } : {}),
    ...(spec.basis === "runtime_clock" && spec.alignment === "calendar_month" ? { alignment: "calendar_month" as const } : {}),
    startInclusive: new Date(start).toISOString(), endExclusive: new Date(end).toISOString(),
  };
}
