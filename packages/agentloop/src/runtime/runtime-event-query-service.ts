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
  const { privateReasoningContent: _privateReasoningContent, ...data } = event.data;
  if ((event.type === "assistant.streaming" || event.type === "assistant.committed") && typeof data.content === "string") {
    return { ...event, data: { ...data, content: publicAssistantContent(data.content) } };
  }
  return { ...event, data };
}

// Model output can echo server-owned evidence or provider framing. These are
// not assistant prose. Streaming events are cumulative snapshots, so withhold
// an incomplete opening marker and an unfinished record until the next one.
function publicAssistantContent(content: string): string {
  const open = "<runtime_evidence_record";
  const close = "</runtime_evidence_record>";
  let result = content;
  for (;;) {
    const start = result.toLowerCase().indexOf(open);
    if (start < 0) break;
    const end = result.toLowerCase().indexOf(close, start + open.length);
    result = result.slice(0, start) + (end < 0 ? "" : result.slice(end + close.length));
    if (end < 0) break;
  }
  const controls = ["<|begin_of_sentence|>", "<｜begin▁of▁sentence｜>"];
  for (const control of controls) result = result.split(control).join("");
  for (const marker of [open, ...controls]) {
    for (let length = Math.min(marker.length - 1, result.length); length > 0; length--) {
      if (result.slice(-length).toLowerCase() === marker.slice(0, length).toLowerCase()) {
        result = result.slice(0, -length);
        break;
      }
    }
  }
  return result;
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
