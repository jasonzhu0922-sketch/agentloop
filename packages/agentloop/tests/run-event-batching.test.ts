import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunEventBatchQueue } from "../src/runtime/run-event-batch-queue.ts";
import type { RunEventOutbox, RunEventOutboxBatch, RunEventOutboxEntry } from "../src/runtime/run-event-outbox.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";

const event = (n: number) => ({ type: "assistant.streaming", data: { content: `part-${n}` }, createdAt: n });

test("count threshold and flush use one ordered batch and freeze caller data", async () => {
  const saved: unknown[] = [];
  const queue = new RunEventBatchQueue(async (runId, events) => { saved.push({ runId, events }); }, { maxEvents: 3 });
  const first = event(1);
  await queue.enqueue("run", first); first.data.content = "mutated";
  await queue.enqueue("run", event(2)); assert.equal(saved.length, 0);
  await queue.enqueue("run", event(3));
  assert.deepEqual(saved, [{ runId: "run", events: [event(1), event(2), event(3)] }]);
  await queue.close();
});

test("timer persists sparse observations without an execution checkpoint", async () => {
  let committed!: () => void;
  const done = new Promise<void>(resolve => { committed = resolve; });
  const queue = new RunEventBatchQueue(async () => committed(), { maxDelayMs: 10 });
  await queue.enqueue("run", event(1));
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("batch timer did not flush")), 1000).unref())]);
  await queue.close();
});

test("flush waits for an in-flight batch and background failures remain visible", async () => {
  let finish!: () => void;
  const slow = new Promise<void>(resolve => { finish = resolve; });
  const queue = new RunEventBatchQueue(async () => slow);
  await queue.enqueue("run", event(1));
  let drained = false;
  const drain = queue.flush("run").then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  await queue.enqueue("run", event(2)); finish(); await drain; await queue.close();
  const error = new Error("database disconnected");
  const failed = new RunEventBatchQueue(async () => { throw error; });
  await failed.enqueue("run", event(1));
  await assert.rejects(failed.flush("run"), failure => failure === error);
  await assert.rejects(failed.enqueue("run", event(2)), failure => failure === error);
  await assert.rejects(failed.close(), AggregateError);
});

class MemoryOutbox implements RunEventOutbox {
  sequence = 0;
  batchSequence = 0;
  entries: RunEventOutboxEntry[] = [];
  batches: RunEventOutboxBatch[] = [];
  async open() { const claimed = new Set(this.batches.flatMap(batch => batch.entries.map(entry => entry.id))); return { batches: [...this.batches], entries: this.entries.filter(entry => !claimed.has(entry.id)) }; }
  async append(runId: string, event: RunEventOutboxEntry["event"]) { const entry = { id: String(++this.sequence), runId, event }; this.entries.push(entry); return entry; }
  async batch(runId: string, entries: readonly RunEventOutboxEntry[]) { const batch = { id: String(++this.batchSequence), runId, entries }; this.batches.push(batch); return batch; }
  async complete(batch: RunEventOutboxBatch) { const ids = new Set(batch.entries.map(entry => entry.id)); this.entries = this.entries.filter(entry => !ids.has(entry.id)); this.batches = this.batches.filter(item => item.id !== batch.id); }
  async close() {}
}

test("outbox records are recovered before new execution starts", async () => {
  const outbox = new MemoryOutbox();
  await outbox.append("run", event(1)); await outbox.append("run", event(2));
  const saved: unknown[] = [];
  const queue = new RunEventBatchQueue(async (runId, events, batchId) => { assert.ok(batchId); saved.push({ runId, events }); }, { outbox });
  await queue.ready;
  assert.deepEqual(saved, [{ runId: "run", events: [event(1), event(2)] }]);
  assert.equal(outbox.entries.length, 0); await queue.close();
});

test("Runtime separates transient progress from commit and deduplicates an uncertain batch on restart", async t => {
  const directory = await mkdtemp(join(tmpdir(), "run-event-runtime-"));
  const database = new AppDatabase(":memory:");
  t.after(async () => { await database.close(); await rm(directory, { recursive: true, force: true }); });
  await database.prepare("INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at) VALUES ('run', 'owner', NULL, 0, 0, 'running', 'question', 1)").run();
  const outbox = new MemoryOutbox();
  const create = () => new RunService({ database, skills: new SkillService(database), modelFactory: () => { throw new Error("unused"); },
    eventBatching: { outbox, maxDelayMs: 60000 } });
  const runs = create(); await runs.initializeRunEvents();
  const live: unknown[] = [], committed: unknown[] = [];
  runs.subscribeRunProgress("run", item => live.push(item));
  runs.subscribeRunEvents("run", item => committed.push(item));
  const append = (runs as unknown as { appendRunEvent(id: string, value: unknown): Promise<void> }).appendRunEvent.bind(runs);
  await append("run", event(1)); await append("run", event(2));
  assert.equal(live.length, 2); assert.equal("seq" in (live[0] as object), false);
  assert.equal(committed.length, 0);
  assert.equal((await database.prepare("SELECT seq FROM run_events WHERE run_id = 'run'").all()).length, 0);
  // Simulate a connection failure after the outer transaction really committed.
  const original = database.transaction.bind(database);
  let depth = 0, armed = true;
  database.transaction = async operation => {
    const outer = depth++ === 0;
    try {
      const value = await original(operation);
      if (outer && armed) { armed = false; throw new Error("commit acknowledgement lost"); }
      return value;
    } finally { depth--; }
  };
  await assert.rejects(runs.flushRunEvents("run"), /acknowledgement lost/);
  await assert.rejects(runs.closeRunEvents(), AggregateError);
  database.transaction = original;
  const recovered = create(); await recovered.initializeRunEvents();
  const rows = await database.prepare("SELECT seq, type FROM run_events WHERE run_id = 'run' ORDER BY seq").all();
  assert.equal(rows.length, 2); assert.deepEqual(rows.map((row: any) => row.seq), [1, 2]);
  assert.equal((await database.prepare("SELECT batch_id FROM run_event_batch_commits").all()).length, 1);
  await recovered.closeRunEvents();
});

test("a complete Run drains observations before publishing its terminal result", async t => {
  const { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } = await import("./runtime-test-helpers.ts");
  const database = new AppDatabase(":memory:");
  const directory = await mkdtemp(join(tmpdir(), "event-batching-execute-"));
  const outbox = new MemoryOutbox();
  const runs = new RunService({ database, skills: new SkillService(database), workspaceRoot: directory,
    plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
    eventBatching: { outbox, maxDelayMs: 60000 },
    modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async () => ({ content: "Confirmed answer.", finishReason: "stop", toolCalls: [] }) }),
  });
  t.after(async () => { await runs.closeRunEvents(); await database.close(); await rm(directory, { recursive: true, force: true }); });
  await runs.initializeRunEvents();
  const result = await runs.execute("owner", "Give a short confirmed answer.");
  assert.equal(result.status, "completed");
  const events = await runs.events("owner", result.id);
  assert.equal(events.at(-1)!.type, "run.completed");
  assert.equal(outbox.entries.length, 0); assert.equal(outbox.batches.length, 0);
  assert.ok(events.some(event => event.type === "context.assembled"));
});
