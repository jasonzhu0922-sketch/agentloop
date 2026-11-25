import type { RunEventAppendInput } from "./repositories/run-event-sequencer.ts";
import type { SqlConnection } from "./connection.ts";
import { ascending, type RuntimePersistenceInput } from "./runtime-records.ts";

export interface StoredRunEvent {
  seq: number;
  type: string;
  payload_json: string;
  created_at: number;
}

/** One sequence and read authority for all Runtime event writers. */
export interface RunEventStore {
  /** Seeds a newly created Run without a SQL MAX(seq) round trip. */
  seedRun?(runId: string, minimumSequence?: number): Promise<void>;
  append(runId: string, events: readonly RunEventAppendInput[]): Promise<readonly number[]>;
  events(runId: string): Promise<StoredRunEvent[]>;
  transaction<T>(operation: () => T | Promise<T>, transact: (operation: () => Promise<T>) => Promise<T>): Promise<T>;
}

export async function readRunEvents(connection: RuntimePersistenceInput, runId: string, type?: string): Promise<StoredRunEvent[]> {
  if ("records" in connection) {
    const rows = connection.eventStore ? await connection.eventStore.events(runId) :
      (await connection.records.find("run_events", { run_id: runId, ...(type === undefined ? {} : { type }) })).sort(ascending("seq"));
    return type === undefined ? rows : rows.filter(row => row.type === type);
  }
  const rows = connection.runEventStore ? await connection.runEventStore.events(runId)
    : await connection.prepare(`SELECT seq, type, payload_json, created_at FROM run_events WHERE run_id = ?${type === undefined ? "" : " AND type = ?"} ORDER BY seq`)
      .all<StoredRunEvent>(...[runId, ...(type === undefined ? [] : [type])]);
  return type === undefined ? rows : rows.filter(row => row.type === type);
}
