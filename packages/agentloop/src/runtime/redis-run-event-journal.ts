import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { SqlConnection } from "../storage/connection.ts";
import type { RunEventStore, StoredRunEvent } from "../storage/run-event-store.ts";
import { appendRunEvents, type RunEventAppendInput } from "../storage/repositories/run-event-sequencer.ts";
import type { RunEventOutbox, RunEventOutboxBatch, RunEventOutboxEntry } from "./run-event-outbox.ts";

type Entry = RunEventOutboxEntry & { seq: number; status: "provisional" | "committed" | "discarded"; published?: boolean };
type Transaction = { id: string; entries: Entry[]; marked: boolean; marking?: Promise<void> };

/** Redis acknowledgement is the event commit boundary; SQL is a replayable projection. */
export class RedisRunEventJournal implements RunEventStore {
  private readonly context = new AsyncLocalStorage<Transaction>();
  private readonly background = new AsyncResource("RedisRunEventJournal");
  private readonly entries = new Map<string, Entry[]>();
  private readonly accepting = new Map<string, Promise<unknown>>();
  private readonly floors = new Map<string, number>();
  private readonly batches: RunEventOutboxBatch[] = [];
  private flight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private closing = false;
  private failure?: unknown;
  readonly ready: Promise<void>;
  private readonly sql: SqlConnection;

  private readonly database: SqlConnection;
  private readonly outbox: RunEventOutbox;
  private readonly publish: (runId: string, seq: number, event: RunEventAppendInput) => void;
  private readonly options: { maxEvents?: number; maxDelayMs?: number; maxBytes?: number };
  constructor(database: SqlConnection, outbox: RunEventOutbox,
    publish: (runId: string, seq: number, event: RunEventAppendInput) => void,
    options: { maxEvents?: number; maxDelayMs?: number; maxBytes?: number } = {}) {
    for (const [key, fallback, min, max] of [["maxEvents", 200, 1, 200], ["maxDelayMs", 1000, 1, 60000], ["maxBytes", 1000000, 1024, 4000000]] as const) {
      const value = options[key] ?? fallback;
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid event batch ${key}`);
    }
    this.database = database; this.outbox = outbox; this.publish = publish; this.options = options;
    if (!database.supportsRunEventTransactions || !outbox.appendEvents || !outbox.discard) {
      throw new Error("Durable event journal requires transaction-aware database and sequenced outbox");
    }
    // Background SQL must bypass the event store while retaining the engine's
    // real transaction semantics. This also prevents recursive journal writes.
    this.sql = { dialect: database.dialect, exec: sql => database.exec(sql), prepare: sql => database.prepare(sql),
      transaction: operation => this.context.run(undefined!, () => database.transaction(operation)), close: async () => {} };
    this.ready = this.initialize();
    void this.ready.catch(() => {});
  }

  private async initialize(): Promise<void> {
    await this.database.exec(`CREATE TABLE IF NOT EXISTS run_event_transactions (
      transaction_id VARCHAR(191) PRIMARY KEY, created_at BIGINT NOT NULL
    )`);
    await this.database.exec(`CREATE TABLE IF NOT EXISTS run_event_batch_commits (
      batch_id VARCHAR(191) PRIMARY KEY, run_id VARCHAR(191) NOT NULL, sequences_json TEXT NOT NULL
    )`);
    const saved = await this.outbox.open();
    // Upgrade old manifests before enabling the new sequence authority. This
    // compatibility path runs only on startup for pre-journal records.
    for (const batch of saved.batches.filter(batch => batch.entries.some(entry => entry.seq === undefined))) {
      await this.writeLegacy(batch); await this.outbox.complete(batch);
    }
    const legacy = saved.entries.filter(entry => entry.seq === undefined);
    for (const runId of new Set(legacy.map(entry => entry.runId))) {
      const pending = legacy.filter(entry => entry.runId === runId);
      while (pending.length) {
        const batch = await this.outbox.batch(runId, pending.splice(0, 200));
        await this.writeLegacy(batch); await this.outbox.complete(batch);
      }
    }
    const recovered = [...saved.batches.flatMap(batch => batch.entries), ...saved.entries].filter(entry => entry.seq !== undefined);
    const decisions = new Map<string, boolean>();
    for (const item of recovered) {
      if (item.transactionId && !decisions.has(item.transactionId)) {
        const row = await this.database.prepare("SELECT transaction_id FROM run_event_transactions WHERE transaction_id = ?").get(item.transactionId);
        decisions.set(item.transactionId, !!row);
      }
      if (item.transactionId && !decisions.get(item.transactionId)) { await this.outbox.discard!([item]); continue; }
      this.add({ ...item, seq: item.seq!, status: "committed", published: true });
    }
    for (const batch of saved.batches.filter(batch => batch.entries.every(entry => entry.seq !== undefined))) {
      this.batches.push(batch);
    }
    // Startup loads Redis but does not wait for the SQL projection to catch up.
    this.schedule(1);
  }

  async seedRun(runId: string, minimumSequence = 0): Promise<void> {
    await this.ready;
    if (!Number.isSafeInteger(minimumSequence) || minimumSequence < 0) throw new TypeError("Invalid Run event sequence floor");
    const current = this.floors.get(runId);
    this.floors.set(runId, Math.max(current ?? 0, minimumSequence));
  }

  async append(runId: string, events: readonly RunEventAppendInput[]): Promise<readonly number[]> {
    await this.ready;
    if (this.closing) throw new Error("Run event journal is closed");
    const transaction = this.context.getStore();
    const previous = this.accepting.get(runId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      let floor = this.floors.get(runId);
      if (floor === undefined) {
        const row = await this.database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM run_events WHERE run_id = ?").get<{ seq: number }>(runId);
        floor = Number(row?.seq ?? 0); this.floors.set(runId, floor);
      }
      if (transaction && !transaction.marked) {
        await (transaction.marking ??= this.database.prepare("INSERT INTO run_event_transactions(transaction_id, created_at) VALUES (?, ?)")
          .run(transaction.id, Date.now()).then(() => { transaction.marked = true; }));
      }
      const saved = await this.outbox.appendEvents!(runId, structuredClone(events), floor, transaction?.id);
      for (const item of saved) {
        if (!Number.isSafeInteger(item.seq) || item.seq! <= 0) throw new Error("Outbox returned an invalid event sequence");
        const entry: Entry = { ...item, seq: item.seq!, status: transaction ? "provisional" : "committed" };
        this.add(entry); transaction?.entries.push(entry);
      }
      this.floors.set(runId, saved.at(-1)?.seq ?? floor);
      if (!transaction) { this.publishReady(runId); this.schedule(); }
      return saved.map(entry => entry.seq!);
    });
    this.accepting.set(runId, operation);
    try { return await operation; }
    finally { if (this.accepting.get(runId) === operation) this.accepting.delete(runId); }
  }

  async transaction<T>(operation: () => T | Promise<T>, transact: (operation: () => Promise<T>) => Promise<T>): Promise<T> {
    if (this.context.getStore()) return await operation();
    const transaction: Transaction = { id: randomUUID(), entries: [], marked: false };
    let value: T;
    try { value = await this.context.run(transaction, () => transact(async () => await operation())); }
    catch (error) {
      // An uncertain commit must be resolved from its atomic state marker.
      // If SQL is unreachable, leave provisional records in Redis for restart.
      let committed = false;
      try { committed = transaction.marked && !!await this.database.prepare("SELECT transaction_id FROM run_event_transactions WHERE transaction_id = ?").get(transaction.id); }
      catch { throw error; }
      if (committed) this.commit(transaction);
      else {
        for (const entry of transaction.entries) entry.status = "discarded";
        await this.outbox.discard!(transaction.entries);
        for (const runId of new Set(transaction.entries.map(entry => entry.runId))) this.publishReady(runId);
      }
      throw error;
    }
    this.commit(transaction);
    return value;
  }

  private commit(transaction: Transaction): void {
    for (const entry of transaction.entries) entry.status = "committed";
    for (const runId of new Set(transaction.entries.map(entry => entry.runId))) this.publishReady(runId);
    this.schedule();
  }

  private add(entry: Entry): void {
    const entries = this.entries.get(entry.runId) ?? [];
    entries.push(entry); entries.sort((a, b) => a.seq - b.seq); this.entries.set(entry.runId, entries);
  }

  private publishReady(runId: string): void {
    for (const entry of this.entries.get(runId) ?? []) {
      if (entry.status === "provisional") break;
      if (entry.status === "committed" && !entry.published) {
        entry.published = true; this.publish(runId, entry.seq, entry.event);
      }
    }
  }

  async events(runId: string): Promise<StoredRunEvent[]> {
    await this.ready;
    // Capture Redis entries before querying SQL: a concurrent successful flush
    // may remove entries from memory while the SQL read is in flight.
    const transaction = this.context.getStore();
    const pending = [...(this.entries.get(runId) ?? [])];
    const visible: Entry[] = [];
    for (const entry of pending) {
      if (entry.status === "provisional" && entry.transactionId !== transaction?.id) break;
      if (entry.status !== "discarded") visible.push(entry);
    }
    const cutoff = pending.find(entry => entry.status === "provisional" && entry.transactionId !== transaction?.id)?.seq;
    const rows = await this.database.prepare("SELECT seq, type, payload_json, created_at FROM run_events WHERE run_id = ? ORDER BY seq").all<StoredRunEvent>(runId);
    const merged = new Map(rows.filter(row => cutoff === undefined || row.seq < cutoff).map(row => [Number(row.seq), row]));
    for (const entry of visible) merged.set(entry.seq, { seq: entry.seq, type: entry.event.type, payload_json: JSON.stringify(entry.event.data), created_at: entry.event.createdAt });
    return [...merged.values()].sort((a, b) => a.seq - b.seq);
  }

  private schedule(delay?: number): void {
    if (this.closing || this.timer || this.flight) return;
    const count = [...this.entries.values()].reduce((n, entries) => n + entries.filter(entry => entry.status === "committed").length, 0);
    if (!count && !this.batches.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.background.runInAsyncScope(() => { void this.flush().catch(() => {}); });
    }, delay ?? (count >= (this.options.maxEvents ?? 200) ? 1 : this.options.maxDelayMs ?? 1000));
    this.timer.unref();
  }

  async flush(): Promise<void> {
    await this.ready;
    if (this.flight) return await this.flight;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.flight = this.background.runInAsyncScope(async () => {
      for (;;) {
        let batch = this.batches[0];
        if (!batch) {
          let selected: Entry[] = [];
          for (const entries of this.entries.values()) {
            const ready: Entry[] = [];
            for (const entry of entries) { if (entry.status === "provisional") break; if (entry.status === "committed") ready.push(entry); }
            if (ready.length) {
              let bytes = 0;
              for (const entry of ready) {
                const size = Buffer.byteLength(JSON.stringify(entry.event));
                if (selected.length && (selected.length >= (this.options.maxEvents ?? 200) || bytes + size > (this.options.maxBytes ?? 1000000))) break;
                selected.push(entry); bytes += size;
              }
              break;
            }
          }
          if (!selected.length) break;
          batch = await this.outbox.batch(selected[0]!.runId, selected);
          this.batches.push(batch);
        }
        await this.write(batch);
        await this.outbox.complete(batch);
        const ids = new Set(batch.entries.map(entry => entry.id));
        const remaining = (this.entries.get(batch.runId) ?? []).filter(entry => !ids.has(entry.id) && entry.status !== "discarded");
        if (remaining.length) this.entries.set(batch.runId, remaining); else this.entries.delete(batch.runId);
        this.batches.shift();
      }
      this.failure = undefined;
    });
    try { await this.flight; }
    catch (error) { this.failure = error; throw error; }
    finally { this.flight = undefined; this.schedule(this.failure === undefined ? undefined : 1000); }
  }

  private async write(batch: RunEventOutboxBatch): Promise<void> {
    await this.sql.transaction(async () => {
      if (await this.sql.prepare("SELECT batch_id FROM run_event_batch_commits WHERE batch_id = ?").get(batch.id)) return;
      const existing = await this.sql.prepare("SELECT seq, type, payload_json, created_at FROM run_events WHERE run_id = ? AND seq >= ? AND seq <= ?")
        .all<StoredRunEvent>(batch.runId, batch.entries[0]!.seq!, batch.entries.at(-1)!.seq!);
      const saved = new Map(existing.map(row => [Number(row.seq), row]));
      const missing = batch.entries.filter(entry => {
        const prior = saved.get(entry.seq!);
        if (!prior) return true;
        if (prior.type !== entry.event.type || Number(prior.created_at) !== entry.event.createdAt || prior.payload_json !== JSON.stringify(entry.event.data)) {
          throw new Error(`Run event sequence collision: ${batch.runId}:${entry.seq}`);
        }
        return false;
      });
      if (missing.length) await this.sql.prepare(`INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES ${missing.map(() => "(?, ?, ?, ?, ?)").join(",")}`)
        .run(...missing.flatMap(entry => [batch.runId, entry.seq!, entry.event.type, JSON.stringify(entry.event.data), entry.event.createdAt]));
      const next = Math.max(...batch.entries.map(entry => entry.seq!)) + 1;
      const upsert = this.sql.dialect === "tidb" ? "ON DUPLICATE KEY UPDATE next_seq = GREATEST(next_seq, VALUES(next_seq))"
        : this.sql.dialect === "postgres" ? "ON CONFLICT(run_id) DO UPDATE SET next_seq = GREATEST(run_event_sequences.next_seq, excluded.next_seq)"
        : "ON CONFLICT(run_id) DO UPDATE SET next_seq = MAX(next_seq, excluded.next_seq)";
      await this.sql.prepare(`INSERT INTO run_event_sequences(run_id, next_seq) VALUES (?, ?) ${upsert}`).run(batch.runId, next);
      await this.sql.prepare("INSERT INTO run_event_batch_commits(batch_id, run_id, sequences_json) VALUES (?, ?, ?)")
        .run(batch.id, batch.runId, JSON.stringify(batch.entries.map(entry => entry.seq)));
    });
  }

  private async writeLegacy(batch: RunEventOutboxBatch): Promise<void> {
    await this.sql.transaction(async () => {
      if (await this.sql.prepare("SELECT batch_id FROM run_event_batch_commits WHERE batch_id = ?").get(batch.id)) return;
      const sequences = await appendRunEvents(this.sql, batch.runId, batch.entries.map(entry => entry.event));
      await this.sql.prepare("INSERT INTO run_event_batch_commits(batch_id, run_id, sequences_json) VALUES (?, ?, ?)")
        .run(batch.id, batch.runId, JSON.stringify(sequences));
    });
  }

  async close(): Promise<void> {
    await this.ready;
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    try { await this.flush(); }
    finally { await this.outbox.close(); this.background.emitDestroy(); }
  }
}
