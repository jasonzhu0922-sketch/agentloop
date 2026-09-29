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
  private readonly runs: Pick<RunRepository, "eventsByRun">;
  private readonly authorizeRun: (actorUserId: string, runId: string) => Promise<void>;

  constructor(input: {
    readonly runs: Pick<RunRepository, "eventsByRun">;
    readonly authorizeRun: (actorUserId: string, runId: string) => Promise<void>;
  }) {
    this.runs = input.runs;
    this.authorizeRun = input.authorizeRun;
  }

  async list(actorUserId: string, runId: string): Promise<StoredRunEvent[]> {
    await this.authorizeRun(actorUserId, runId);
    return (await this.storedForRun(runId)).map(publicRunEvent);
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
  return rows.map((row) => ({
    seq: row.seq,
    type: row.type,
    data: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  }));
}
