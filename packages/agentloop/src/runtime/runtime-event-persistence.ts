import type { RuntimePersistenceInput } from "../storage/runtime-records.ts";
import { appendRunEvents, type RunEventAppendInput } from "../storage/repositories/run-event-sequencer.ts";
import { RedisRunEventJournal } from "./redis-run-event-journal.ts";
import { RunEventBatchQueue, type RunEventBatchOptions } from "./run-event-batch-queue.ts";

/** Legacy SQL event assembly lives here; native state commits its events in the state transaction. */
export function assembleRuntimeEventPersistence(database: RuntimePersistenceInput, options: RunEventBatchOptions | undefined,
  publish: (runId: string, seq: number, event: RunEventAppendInput) => void, onError: (runId: string, error: unknown) => void,
): { journal?: RedisRunEventJournal; queue?: RunEventBatchQueue } {
  if ("records" in database) {
    if (options) throw new TypeError("Native Runtime state owns atomic event persistence; remove the legacy event outbox configuration");
    return {};
  }
  let journal: RedisRunEventJournal | undefined, queue: RunEventBatchQueue | undefined;
    if (options?.outbox?.appendEvents) {
      journal = new RedisRunEventJournal(database, options.outbox, (runId, seq, event) => {
        publish(runId, seq, event);
      }, options);
      if (database.runEventStore) throw new Error("Database already has a Runtime event store");
      database.runEventStore = journal;
    } else if (options) {
      let batchSchema: Promise<void> | undefined;
      queue = new RunEventBatchQueue(async (runId, events, batchId, replaying) => {
        if (batchId) await (batchSchema ??= database.exec(`CREATE TABLE IF NOT EXISTS run_event_batch_commits (
          batch_id VARCHAR(191) PRIMARY KEY, run_id VARCHAR(191) NOT NULL, sequences_json TEXT NOT NULL
        )`));
        const sequences = batchId ? await database.transaction(async () => {
          if (replaying) {
            const prior = await database.prepare("SELECT sequences_json FROM run_event_batch_commits WHERE batch_id = ?")
              .get<{ sequences_json: string }>(batchId);
            if (prior) return JSON.parse(prior.sequences_json) as number[];
          }
          const allocated = await appendRunEvents(database, runId, events);
          await database.prepare("INSERT INTO run_event_batch_commits(batch_id, run_id, sequences_json) VALUES (?, ?, ?)")
            .run(batchId, runId, JSON.stringify(allocated));
          return allocated;
        }) : await appendRunEvents(database, runId, events);
        events.forEach((event, index) => {
          const seq = sequences[index]!;
          publish(runId, seq, event);
        });
      }, options, (runId, error) => {
        onError(runId, error);
      });
    }
  return { journal, queue };
}
