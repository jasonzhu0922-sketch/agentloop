import type { RunEventRow, RunRepository } from "../storage/repositories/run-repository.ts";

export interface StoredRunEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

/**
 * Read-only durable event access. Runtime orchestration may read raw events for
 * recovery, while externally reachable reads are authorized and sanitized.
 */
export class RuntimeEventQueryService {
  private readonly runs: Pick<RunRepository, "eventsByRun"> & Partial<Pick<RunRepository, "latestEventByRun">>;
  private readonly authorizeRun: (actorUserId: string, runId: string) => Promise<void>;

  constructor(input: {
    readonly runs: Pick<RunRepository, "eventsByRun"> & Partial<Pick<RunRepository, "latestEventByRun">>;
    readonly authorizeRun: (actorUserId: string, runId: string) => Promise<void>;
  }) {
    this.runs = input.runs;
    this.authorizeRun = input.authorizeRun;
  }

  async list(actorUserId: string, runId: string): Promise<StoredRunEvent[]> {
    await this.authorizeRun(actorUserId, runId);
    return (await this.storedForRun(runId)).map(publicRunEvent);
  }

  async latest(actorUserId: string, runId: string): Promise<StoredRunEvent | undefined> {
    await this.authorizeRun(actorUserId, runId);
    // Do not fall back to eventsByRun here: this method is the bounded
    // recovery path and must never turn a missing capability into a full
    // ledger download. The production RunRepository implements the indexed
    // single-row query; legacy adapters simply report no latest event.
    if (this.runs.latestEventByRun === undefined) return undefined;
    const row = await this.runs.latestEventByRun(runId);
    return row === undefined ? undefined : publicRunEvent(eventFromRow(row));
  }

  /** Internal Runtime projection from the durable ledger; it is never an HTTP read path. */
  async storedForRun(runId: string): Promise<StoredRunEvent[]> {
    return eventsFromRows(await this.runs.eventsByRun(runId));
  }
}

export function publicRunEvent(event: StoredRunEvent): StoredRunEvent {
  if (!("privateReasoningContent" in event.data)) return event;
  const { privateReasoningContent: _privateReasoningContent, ...data } = event.data;
  return { ...event, data };
}

function eventsFromRows(rows: readonly RunEventRow[]): StoredRunEvent[] {
  return rows.map(eventFromRow);
}

function eventFromRow(row: RunEventRow): StoredRunEvent {
  return {
    seq: row.seq,
    type: row.type,
    data: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}
