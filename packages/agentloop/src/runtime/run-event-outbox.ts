import type { RunEventAppendInput } from "../storage/repositories/run-event-sequencer.ts";

export interface RunEventOutboxEntry { readonly id: string; readonly runId: string; readonly event: RunEventAppendInput; readonly seq?: number; readonly transactionId?: string }
export interface RunEventOutboxBatch { readonly id: string; readonly runId: string; readonly entries: readonly RunEventOutboxEntry[] }

/** Deployment-owned durable outbox, with stable batch ids. No writer lease is required. */
export interface RunEventOutbox {
  open(): Promise<{ batches: RunEventOutboxBatch[]; entries: RunEventOutboxEntry[] }>;
  append(runId: string, event: RunEventAppendInput): Promise<RunEventOutboxEntry>;
  /** Atomically allocate sequences and append durable entries, optionally provisional until a SQL state transaction commits. */
  appendEvents?(runId: string, events: readonly RunEventAppendInput[], minimumSequence: number, transactionId?: string): Promise<RunEventOutboxEntry[]>;
  discard?(entries: readonly RunEventOutboxEntry[]): Promise<void>;
  batch(runId: string, entries: readonly RunEventOutboxEntry[]): Promise<RunEventOutboxBatch>;
  complete(batch: RunEventOutboxBatch): Promise<void>;
  close(): Promise<void>;
}
