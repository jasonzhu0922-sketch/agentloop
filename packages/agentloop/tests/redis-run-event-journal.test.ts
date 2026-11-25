import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/storage/database.ts";
import { appendRunEvent } from "../src/storage/repositories/run-event-sequencer.ts";
import { readRunEvents } from "../src/storage/run-event-store.ts";
import { RedisRunEventJournal } from "../src/runtime/redis-run-event-journal.ts";
import type { RunEventOutbox, RunEventOutboxBatch, RunEventOutboxEntry } from "../src/runtime/run-event-outbox.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";

class MemoryOutbox implements RunEventOutbox {
  id = 0; counters = new Map<string, number>(); entries: RunEventOutboxEntry[] = []; batches: RunEventOutboxBatch[] = [];
  async open() { const claimed = new Set(this.batches.flatMap(batch => batch.entries.map(entry => entry.id))); return { batches: [...this.batches], entries: this.entries.filter(entry => !claimed.has(entry.id)) }; }
  async append(runId: string, event: RunEventOutboxEntry["event"]) { return (await this.appendEvents(runId, [event], 0))[0]!; }
  async appendEvents(runId: string, events: readonly RunEventOutboxEntry["event"][], floor: number, transactionId?: string) {
    let seq = Math.max(this.counters.get(runId) ?? 0, floor);
    const entries = events.map(event => ({ id: String(++this.id), runId, event: structuredClone(event), seq: ++seq, ...(transactionId ? { transactionId } : {}) }));
    this.entries.push(...entries); this.counters.set(runId, seq); return entries;
  }
  async discard(entries: readonly RunEventOutboxEntry[]) { const ids = new Set(entries.map(entry => entry.id)); this.entries = this.entries.filter(entry => !ids.has(entry.id)); }
  async batch(runId: string, entries: readonly RunEventOutboxEntry[]) { const batch = { id: `batch-${++this.id}`, runId, entries }; this.batches.push(batch); return batch; }
  async complete(batch: RunEventOutboxBatch) { await this.discard(batch.entries); this.batches = this.batches.filter(item => item.id !== batch.id); }
  async close() {}
}
const event = (n: number) => ({ type: "decision.committed", data: { value: n }, createdAt: n });
async function fixture(t: any) {
  const database = new AppDatabase(":memory:"); await database.ready();
  await database.prepare("INSERT INTO runs(id, owner_user_id, depth, allow_dangerous_tools, status, input, created_at) VALUES ('run', 'owner', 0, 0, 'running', 'question', 1)").run();
  const outbox = new MemoryOutbox(), published: number[] = [];
  const journal = new RedisRunEventJournal(database, outbox, (_runId, seq) => published.push(seq), { maxDelayMs: 60000 });
  database.runEventStore = journal; await journal.ready;
  t.after(async () => { await journal.close(); await database.close(); });
  return { database, outbox, journal, published };
}

test("all event writers and evidence reads use Redis before SQL projection", async t => {
  const { database, journal, published, outbox } = await fixture(t);
  await appendRunEvent(database, "run", event(1));
  await database.transaction(async () => {
    await appendRunEvent(database, "run", event(2));
    assert.deepEqual(published, [1]);
    assert.deepEqual((await readRunEvents(database, "run")).map(row => row.seq), [1, 2]);
  });
  assert.deepEqual(published, [1, 2]); assert.equal(outbox.entries.length, 2);
  assert.equal((await database.prepare("SELECT seq FROM run_events").all()).length, 0);
  await journal.flush();
  assert.deepEqual((await readRunEvents(database, "run")).map(row => row.seq), [1, 2]);
  assert.deepEqual(published, [1, 2]); assert.equal(outbox.entries.length, 0);
});

test("failed state transactions discard their events without reusing sequences", async t => {
  const { database, outbox, published } = await fixture(t);
  await assert.rejects(database.transaction(async () => {
    await appendRunEvent(database, "run", event(1)); throw new Error("rollback");
  }), /rollback/);
  assert.equal(outbox.entries.length, 0); assert.deepEqual(published, []);
  assert.deepEqual(await readRunEvents(database, "run"), []);
  assert.equal(await appendRunEvent(database, "run", event(2)), 2);
  assert.deepEqual(published, [2]);
});

test("SQL projection failure retains the same batch for retry and never poisons Redis admission", async t => {
  const { database, journal, outbox } = await fixture(t);
  await appendRunEvent(database, "run", event(1));
  const sql = (journal as any).sql, prepare = sql.prepare;
  let attempts = 0;
  sql.prepare = (query: string) => {
    if (query.startsWith("INSERT INTO run_events")) {
      const statement = prepare(query);
      return { ...statement, run: async (...args: any[]) => { if (++attempts === 1) throw new Error("sink unavailable"); return statement.run(...args); } };
    }
    return prepare(query);
  };
  await assert.rejects(journal.flush(), /sink unavailable/);
  const batchId = outbox.batches[0]!.id;
  await appendRunEvent(database, "run", event(2));
  assert.equal((await readRunEvents(database, "run")).length, 2);
  await journal.flush();
  assert.equal((await database.prepare("SELECT batch_id FROM run_event_batch_commits WHERE batch_id = ?").all(batchId)).length, 1);
  assert.equal((await readRunEvents(database, "run")).length, 2); assert.equal(outbox.entries.length, 0);
});

test("a complete Run advances through model, Action result and terminal events while the SQL sink is blocked", async t => {
  const { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } = await import("./runtime-test-helpers.ts");
  const database = new AppDatabase(":memory:");
  const directory = await mkdtemp(join(tmpdir(), "async-event-run-")), outbox = new MemoryOutbox();
  let calls = 0;
  const runs = new RunService({ database, skills: new SkillService(database), workspaceRoot: directory,
    plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
    eventBatching: { outbox, maxEvents: 1, maxDelayMs: 1 },
    modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async () => { calls++; return { content: "Confirmed answer.", finishReason: "stop", toolCalls: [] }; } }),
  });
  const journal = (runs as any).eventJournal as RedisRunEventJournal;
  const original = (journal as any).write.bind(journal);
  let unblock!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; }), writing = new Promise<void>(resolve => { started = resolve; });
  (journal as any).write = async (batch: any) => { started(); await gate; return original(batch); };
  t.after(async () => { unblock(); await runs.closeRunEvents(); await database.close(); await rm(directory, { recursive: true, force: true }); });
  await runs.initializeRunEvents();
  const result = await Promise.race([runs.execute("owner", "Give a short confirmed answer."),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Run waited for SQL event sink")), 10000).unref())]);
  await writing;
  assert.equal(result.status, "completed"); assert.ok(calls > 0);
  const events = await runs.events("owner", result.id);
  assert.equal(events.at(-1)!.type, "run.completed");
  assert.ok(events.some(event => event.type === "action.dispatched"));
  assert.ok(outbox.entries.length > 0);
  assert.equal((await database.prepare("SELECT seq FROM run_events WHERE run_id = ?").all(result.id)).length, 0);
  unblock(); await journal.flush();
  assert.equal((await database.prepare("SELECT seq FROM run_events WHERE run_id = ?").all(result.id)).length, events.length);
});

test("restart merges pending Redis records and resolves committed or rolled back state transactions", async t => {
  const { database, journal, outbox } = await fixture(t);
  await appendRunEvent(database, "run", event(1));
  await database.transaction(async () => { await appendRunEvent(database, "run", event(2)); });
  await outbox.appendEvents("run", [event(3)], 2, "aborted-process-transaction");
  // Recreate only the journal, retaining SQL and durable Redis state.
  const recovered = new RedisRunEventJournal(database, outbox, () => {}, { maxDelayMs: 60000 });
  database.runEventStore = recovered; await recovered.ready;
  assert.deepEqual((await recovered.events("run")).map(row => row.seq), [1, 2]);
  assert.equal(await appendRunEvent(database, "run", event(4)), 4);
  await recovered.flush();
  assert.deepEqual((await recovered.events("run")).map(row => row.seq), [1, 2, 4]);
  // The old process no longer owns the outbox. Suppress its test cleanup work.
  (journal as any).entries.clear(); await recovered.close();
});

test("an uncertain SQL sink commit retries its stable manifest without duplicate event publication or rows", async t => {
  const { database, journal, outbox, published } = await fixture(t);
  await appendRunEvent(database, "run", event(1));
  const sql = (journal as any).sql, transact = sql.transaction;
  let armed = true;
  sql.transaction = async (operation: any) => {
    const value = await transact(operation);
    if (armed) { armed = false; throw new Error("commit acknowledgement lost"); }
    return value;
  };
  await assert.rejects(journal.flush(), /acknowledgement lost/);
  assert.equal(outbox.entries.length, 1);
  await journal.flush();
  assert.equal(outbox.entries.length, 0);
  assert.equal((await database.prepare("SELECT seq FROM run_events").all()).length, 1);
  assert.equal((await database.prepare("SELECT batch_id FROM run_event_batch_commits").all()).length, 1);
  assert.deepEqual(published, [1]);
});

test("later accepted events cannot jump past an unresolved state transaction in live replay", async t => {
  const { database, journal, published } = await fixture(t);
  let entered!: () => void, finish!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
  const tx = database.transaction(async () => { await appendRunEvent(database, "run", event(1)); entered(); await gate; });
  await inside;
  await appendRunEvent(database, "run", event(2));
  assert.deepEqual(published, []);
  // Avoid trying to acquire SQLite's transaction lock for this external read.
  const original = (journal as any).database.prepare;
  (journal as any).database.prepare = (query: string) => query.startsWith("SELECT seq, type, payload_json")
    ? { all: async () => [] } : original.call(database, query);
  assert.deepEqual(await journal.events("run"), []);
  (journal as any).database.prepare = original;
  finish(); await tx;
  assert.deepEqual(published, [1, 2]);
});

test("a newly created Run seeds its empty ledger before the first Redis event", async t => {
  const { database, journal } = await fixture(t);
  let maxQuery = false;
  const original = (journal as any).database.prepare;
  (journal as any).database.prepare = (query: string) => {
    if (/MAX\(seq\)/iu.test(query)) maxQuery = true;
    return original.call(database, query);
  };
  await journal.seedRun("run", 0);
  await journal.append("run", [event(1)]);
  (journal as any).database.prepare = original;
  assert.equal(maxQuery, false);
});
