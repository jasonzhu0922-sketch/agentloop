import type { RunEventOutbox, RunEventOutboxEntry as OutboxEntry } from "./run-event-outbox.ts";
import { AsyncResource } from "node:async_hooks";
import type { RunEventAppendInput } from "../storage/repositories/run-event-sequencer.ts";

export interface RunEventBatchOptions {
  readonly maxEvents?: number;
  readonly maxDelayMs?: number;
  readonly maxBytes?: number;
  /** Durable outbox; a persisted batch uses an atomic DB deduplication marker. */
  readonly outbox?: RunEventOutbox;
}

interface PendingRun {
  pending: OutboxEntry[];
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
  flight?: Promise<void>;
  error?: unknown;
  accepting: Promise<void>;
}

/** Only observation events enter this queue. Semantic writes remain commit barriers. */
export class RunEventBatchQueue {
  private readonly runs = new Map<string, PendingRun>();
  private readonly background = new AsyncResource("RunEventBatchQueue");
  private readonly maxEvents: number;
  private readonly maxDelayMs: number;
  private readonly maxBytes: number;
  private readonly outbox?: RunEventOutbox;
  readonly ready: Promise<void>;

  private readonly write: (runId: string, events: readonly RunEventAppendInput[], batchId?: string, replaying?: boolean) => Promise<void>;
  private readonly onError?: (runId: string, error: unknown) => void;
  constructor(write: (runId: string, events: readonly RunEventAppendInput[], batchId?: string, replaying?: boolean) => Promise<void>,
    options: RunEventBatchOptions = {}, onError?: (runId: string, error: unknown) => void) {
    this.write = write; this.onError = onError;
    this.maxEvents = bounded(options.maxEvents ?? 200, 1, 200, "maxEvents");
    this.maxDelayMs = bounded(options.maxDelayMs ?? 1000, 1, 60_000, "maxDelayMs");
    this.maxBytes = bounded(options.maxBytes ?? 1_000_000, 1024, 4_000_000, "maxBytes");
    this.outbox = options.outbox;
    this.ready = this.recover();
    void this.ready.catch(() => {});
  }

  async enqueue(runId: string, event: RunEventAppendInput): Promise<void> {
    await this.ready;
    let state = this.runs.get(runId);
    if (!state) { state = { pending: [], bytes: 0, accepting: Promise.resolve() }; this.runs.set(runId, state); }
    if (state.error !== undefined) throw state.error;
    const copy = structuredClone(event);
    const bytes = Buffer.byteLength(JSON.stringify(copy));
    const target = state;
    const accepting = target.accepting.then(async () => {
      if (target.error !== undefined) throw target.error;
      const entry = this.outbox ? await this.outbox.append(runId, copy) : { id: "", runId, event: copy };
      if (target.error !== undefined) throw target.error;
      target.pending.push(entry); target.bytes += bytes;
    });
    target.accepting = accepting;
    try { await accepting; } catch (error) {
      target.error = error ?? new Error("Run event outbox write failed");
      this.onError?.(runId, target.error); throw target.error;
    }
    if (state.pending.length >= this.maxEvents || state.bytes >= this.maxBytes) {
      await this.flush(runId);
    } else if (!state.timer) {
      state.timer = setTimeout(() => {
        state!.timer = undefined;
        this.background.runInAsyncScope(() => { void this.flush(runId).catch(() => {}); });
      }, this.maxDelayMs);
      state.timer.unref();
    }
  }

  async flush(runId: string): Promise<void> {
    await this.ready;
    const state = this.runs.get(runId);
    if (!state) return;
    await state.accepting;
    if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
    if (state.error !== undefined) throw state.error;
    if (state.flight) {
      await state.flight;
      return await this.flush(runId);
    }
    if (!state.pending.length) return;
    state.flight = (async () => {
      while (state.pending.length) {
        const batch = state.pending.splice(0, this.maxEvents);
        state.bytes -= batch.reduce((size, event) => size + Buffer.byteLength(JSON.stringify(event.event)), 0);
        try {
          const manifest = await this.outbox?.batch(runId, batch);
          await this.write(runId, batch.map(entry => entry.event), manifest?.id);
          if (manifest) await this.outbox!.complete(manifest);
        }
        catch (failure) {
          const error = failure ?? new Error("Run event persistence failed");
          // Keep the failed batch and poison the queue: a failed/uncertain commit
          // must never be silently retried into duplicate ledger records.
          state.pending.unshift(...batch);
          state.bytes += batch.reduce((size, event) => size + Buffer.byteLength(JSON.stringify(event.event)), 0);
          state.error = error;
          this.onError?.(runId, error);
          throw error;
        }
      }
    })();
    try { await state.flight; }
    finally { state.flight = undefined; }
  }

  async release(runId: string): Promise<void> {
    await this.flush(runId);
    const state = this.runs.get(runId);
    if (state && !state.pending.length && !state.flight && state.error === undefined) this.runs.delete(runId);
  }

  private async recover(): Promise<void> {
    if (!this.outbox) return;
    try {
      const saved = await this.outbox.open();
      for (const batch of saved.batches) {
        await this.write(batch.runId, batch.entries.map(entry => entry.event), batch.id, true);
        await this.outbox.complete(batch);
      }
      // Unbatched records were acknowledged locally but not yet sent to DB.
      const byRun = new Map<string, OutboxEntry[]>();
      for (const entry of saved.entries) {
        const entries = byRun.get(entry.runId) ?? []; entries.push(entry); byRun.set(entry.runId, entries);
      }
      for (const [runId, entries] of byRun) {
        while (entries.length) {
          const batch = await this.outbox.batch(runId, entries.splice(0, this.maxEvents));
          await this.write(runId, batch.entries.map(entry => entry.event), batch.id, true);
          await this.outbox.complete(batch);
        }
      }
    } catch (error) { await this.outbox.close(); throw error; }
  }

  async close(): Promise<void> {
    await this.ready;
    const results = await Promise.allSettled([...this.runs.keys()].map(runId => this.flush(runId)));
    for (const state of this.runs.values()) if (state.timer) clearTimeout(state.timer);
    this.background.emitDestroy();
    await this.outbox?.close();
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map(result => result.reason), "Run event persistence failed");
    this.runs.clear();
  }
}

function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid event batch ${name}`);
  return value;
}

// These carry progress/timing only. Receipts, assistant commits, decisions,
// input, budgets, plans, evidence, and terminal transitions never enter the queue.
export const BATCHED_OBSERVATION_EVENTS: ReadonlySet<string> = new Set([
  "assistant.streaming", "model.stream.first_event", "model.stream.awaiting_completion",
  "model.request.started", "model.request.completed", "context.assembled",
  "step_execution.policy_applied",
]);
