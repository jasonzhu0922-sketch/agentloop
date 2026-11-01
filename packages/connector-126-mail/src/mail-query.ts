export interface MailQuery {
  readonly query?: string;
  readonly receivedAtGte?: string;
  readonly receivedAtLt?: string;
  readonly timeZone?: string;
  readonly folder?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface MailQueryScope {
  readonly folder: string;
  readonly timestampField: "IMAP.INTERNALDATE";
  readonly timeZone: string;
  readonly textQuery?: string;
  readonly receivedAtGte?: string;
  readonly receivedAtLt?: string;
}

export function timeCoverage(input: MailQuery, complete: boolean) {
  return { complete: complete && input.receivedAtGte !== undefined, timeZone: input.timeZone ?? "UTC",
    ...(input.receivedAtGte === undefined ? {} : { startInclusive: new Date(timestamp(input.receivedAtGte)).toISOString(), endExclusive: new Date(timestamp(input.receivedAtLt)).toISOString() }),
  };
}

export function dateInZone(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const part = (name: string) => parts.find((value) => value.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** A civil date already belongs to the query zone; do not shift it again. */
export function weekdayForDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(`${date}T00:00:00Z`));
}

export function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) throw new Error("Mail time bounds require RFC3339 timestamps with a UTC offset");
  const result = Date.parse(value);
  const civil = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(result) || !Number.isFinite(civil) || new Date(civil).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error("Invalid mail timestamp");
  return result;
}

export function validateQuery(value: unknown, counting = false): MailQuery {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Mail query must be an object");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["query", "receivedAtGte", "receivedAtLt", "timeZone", "folder", ...(counting ? [] : ["limit", "offset"])]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("Unknown mail query field");
  if (input.query !== undefined && (typeof input.query !== "string" || input.query.trim().length === 0 || input.query.length > 200)) throw new Error("Mail query must be a non-empty text string");
  if (input.folder !== undefined && (typeof input.folder !== "string" || !input.folder.trim() || input.folder.length > 200)) throw new Error("Invalid mailbox folder");
  if (input.timeZone !== undefined && (typeof input.timeZone !== "string" || !input.timeZone)) throw new Error("Invalid timeZone");
  dateInZone(Date.now(), input.timeZone as string | undefined ?? "UTC");
  if ((input.receivedAtGte === undefined) !== (input.receivedAtLt === undefined)) throw new Error("Supply both receivedAtGte and receivedAtLt");
  if (input.receivedAtGte !== undefined && timestamp(input.receivedAtGte) >= timestamp(input.receivedAtLt)) throw new Error("Mail time range must have start before end");
  if (input.query === undefined && input.receivedAtGte === undefined) throw new Error("Supply text query or received-time bounds; dates in query are only text matches, never time filters");
  if (counting && (input.receivedAtGte === undefined || input.timeZone === undefined)) throw new Error("Counting requires receivedAtGte, receivedAtLt and timeZone");
  if (counting && timestamp(input.receivedAtLt) - timestamp(input.receivedAtGte) > 366 * 86_400_000) throw new Error("Count at most 366 days per request");
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100)) throw new Error("Mail limit must be 1..100");
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0)) throw new Error("Mail offset must be a non-negative integer");
  return input as MailQuery;
}

export function queryScope(input: MailQuery): MailQueryScope {
  return { folder: input.folder ?? "INBOX", timestampField: "IMAP.INTERNALDATE", timeZone: input.timeZone ?? "UTC",
    ...(input.query === undefined ? {} : { textQuery: input.query }),
    ...(input.receivedAtGte === undefined ? {} : { receivedAtGte: new Date(timestamp(input.receivedAtGte)).toISOString(), receivedAtLt: new Date(timestamp(input.receivedAtLt)).toISOString() }),
  };
}

export function emptyDailyCounts(input: MailQuery): Map<string, number> {
  const start = dateInZone(timestamp(input.receivedAtGte), input.timeZone!);
  const end = dateInZone(timestamp(input.receivedAtLt) - 1, input.timeZone!);
  const result = new Map<string, number>();
  for (let day = Date.parse(`${start}T00:00:00Z`); day <= Date.parse(`${end}T00:00:00Z`); day += 86_400_000) result.set(new Date(day).toISOString().slice(0, 10), 0);
  return result;
}
