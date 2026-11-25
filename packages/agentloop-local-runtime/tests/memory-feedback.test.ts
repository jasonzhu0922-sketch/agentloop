import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { InMemoryMemoryStore, SqliteMemoryStore } from "@zhujun/agentloop-memory";
import { LocalMemoryFeedback } from "../src/memory/local-memory-feedback.ts";

for (const relation of ["refine_prior", "continue_prior", undefined]) test(`replacement ${relation ?? "unknown"} does not revoke evidence or enqueue correction`, async t => {
  const db = new AppDatabase(":memory:"); t.after(() => db.close()); await db.ready();
  await db.prepare("INSERT INTO conversations(id,owner_user_id,title,created_at,updated_at) VALUES ('chat','alice','test',1,1)").run();
  for (const id of ["target", "next"]) {
    await db.prepare("INSERT INTO runs(id,owner_user_id,conversation_id,depth,status,input,created_at) VALUES (?,'alice','chat',0,'completed','test',1)").run(id);
    await db.prepare("INSERT INTO run_outcomes(run_id,status,result_ref,reason_code,committed_at) VALUES (?,'completed',?,'response_only',1)").run(id, `outcome:${id}`);
  }
  await db.prepare("INSERT INTO run_events(run_id,seq,type,payload_json,created_at) VALUES ('next',1,'conversation.outcome.superseded',?,1)").run(JSON.stringify({ targetRunId: "target", relation }));
  const store = new InMemoryMemoryStore(), scope = { tenantId: "device", ownerUserId: "alice" };
  const poller = new LocalMemoryFeedback({ store, tenantId: "device", sources: () => [{ sourceId: "runtime", database: db }] });
  await poller.poll();
  assert.deepEqual(await store.invalidatedRuns(scope), []);
  assert.deepEqual(await store.settlementJobs(scope, "target"), []);
  assert.equal((await store.feedbackCursor("device:runtime:next"))!.eventKey, "next:1");
});

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: canonical feedback schedules only the owner/chat target and survives a busy worker, restart and rowid reuse`, async t => {
  const runtime = new AppDatabase(":memory:"), memory = new AppDatabase(":memory:");
  t.after(() => { runtime.close(); memory.close(); });
  await runtime.ready();
  const store = backend === "memory" ? new InMemoryMemoryStore() : new SqliteMemoryStore(memory);
  if (backend === "sqlite") await (store as SqliteMemoryStore).ready();
  const scope = { tenantId: "device", ownerUserId: "alice" };
  await runtime.prepare("INSERT INTO conversations(id,owner_user_id,title,created_at,updated_at) VALUES ('chat','alice','test',1,1), ('elsewhere','alice','elsewhere',1,1)").run();
  for (const [id, owner, conversation] of [["target", "alice", "chat"], ["source", "alice", "chat"], ["foreign", "bob", "chat"], ["otherchat", "alice", "elsewhere"]]) {
    await runtime.prepare("INSERT INTO runs(id,owner_user_id,conversation_id,depth,status,input,created_at) VALUES (?,?,?,0,'completed','test',1)").run(id, owner!, conversation!);
    await runtime.prepare("INSERT INTO run_outcomes(run_id,status,result_ref,reason_code,committed_at) VALUES (?,'completed',?,'response_only',1)").run(id, `outcome:${id}`);
  }
  await store.enqueueSettlement({ scope, runId: "target", terminalCommitRef: "outcome:target", now: 1 });
  const initial = (await store.claimSettlement({ now: 1, maxAttempts: 3 }))!;
  const addFeedback = async (run: string, seq: number, target = "target") => runtime.prepare("INSERT INTO run_events(run_id,seq,type,payload_json,created_at) VALUES (?,?,'conversation.outcome.disputed',?,1)").run(run, seq, JSON.stringify({ targetRunId: target }));
  await addFeedback("foreign", 1); await addFeedback("otherchat", 1); await addFeedback("source", 1);
  const poller = new LocalMemoryFeedback({ store, tenantId: "device", sources: () => [{ sourceId: "runtime", database: runtime }], now: () => 10 });
  await poller.poll();
  assert.deepEqual(await store.invalidatedRuns(scope), ["target"], "busy workers cannot delay the persistent recall fence");
  assert.deepEqual(await store.invalidatedRuns({ ...scope, ownerUserId: "bob" }), []);
  assert.equal((await store.feedbackCursor("device:runtime:otherchat"))!.eventKey, "otherchat:1", "other-chat feedback is acknowledged independently");
  assert.equal(await store.feedbackCursor("device:runtime:source"), undefined, "busy target cannot be acknowledged");
  await store.finishSettlement({ job: initial, now: 2, maxAttempts: 3, outcome: "succeeded" });
  await poller.poll();
  assert.equal((await store.settlementJobs(scope, "target"))[0]!.status, "queued");
  assert.equal((await store.feedbackCursor("device:runtime:source"))!.eventKey, "source:1");
  assert.deepEqual(await store.settlementJobs({ ...scope, ownerUserId: "bob" }, "target"), []);
  const replay = (await store.claimSettlement({ now: 10, maxAttempts: 3 }))!;
  await store.finishSettlement({ job: replay, now: 11, maxAttempts: 3, outcome: "succeeded" });
  const reloaded = backend === "sqlite" ? new SqliteMemoryStore(memory) : store;
  assert.deepEqual(await reloaded.invalidatedRuns(scope), ["target"], "the stale-publication fence survives reopening");
  const restarted = new LocalMemoryFeedback({ store: reloaded, tenantId: "device", sources: () => [{ sourceId: "runtime", database: runtime }], now: () => 20 });
  await restarted.poll();
  assert.equal((await reloaded.settlementJobs(scope, "target"))[0]!.status, "succeeded", "acknowledged feedback is not rescheduled on restart");
  await runtime.prepare("DELETE FROM run_events WHERE run_id = 'source'").run();
  await addFeedback("source", 2);
  await restarted.poll();
  assert.equal((await reloaded.settlementJobs(scope, "target"))[0]!.status, "queued", "a reused SQLite rowid cannot hide a new correction");
  assert.equal((await reloaded.feedbackCursor("device:runtime:source"))!.eventKey, "source:2");
});

test("feedback follows the same owner and conversation across local Runtime databases", async t => {
  const left = new AppDatabase(":memory:"), right = new AppDatabase(":memory:");
  t.after(() => { left.close(); right.close(); });
  for (const db of [left, right]) {
    await db.ready();
    await db.prepare("INSERT INTO conversations(id,owner_user_id,title,created_at,updated_at) VALUES ('chat','alice','test',1,1)").run();
  }
  await left.prepare("INSERT INTO runs(id,owner_user_id,conversation_id,depth,status,input,created_at) VALUES ('target','alice','chat',0,'completed','test',1)").run();
  await left.prepare("INSERT INTO run_outcomes(run_id,status,result_ref,reason_code,committed_at) VALUES ('target','completed','outcome:target','response_only',1)").run();
  await right.prepare("INSERT INTO runs(id,owner_user_id,conversation_id,depth,status,input,created_at) VALUES ('correction','alice','chat',0,'completed','test',1)").run();
  await right.prepare(`INSERT INTO run_events(run_id,seq,type,payload_json,created_at) VALUES ('correction',1,'conversation.outcome.superseded','{"targetRunId":"target","relation":"correct_prior"}',1)`).run();
  const store = new InMemoryMemoryStore(), scope = { tenantId: "device", ownerUserId: "alice" };
  await store.enqueueSettlement({ scope, runId: "target", terminalCommitRef: "outcome:target", now: 1 });
  const job = (await store.claimSettlement({ now: 1, maxAttempts: 3 }))!;
  await store.finishSettlement({ job, now: 1, maxAttempts: 3, outcome: "succeeded" });
  const poller = new LocalMemoryFeedback({ store, tenantId: "device", sources: () => [{ sourceId: "left", database: left }, { sourceId: "right", database: right }] });
  await poller.poll();
  assert.equal((await store.settlementJobs(scope, "target"))[0]!.status, "queued");
  const { LocalMemorySettlementReader } = await import("../src/memory/local-memory-settlement-reader.ts");
  const read = await new LocalMemorySettlementReader(() => [left, right], "device").read({ ...scope, runId: "target", terminalCommitRef: "outcome:target" });
  assert.equal(read!.quality.laterCorrected, true, "the target reader must preserve feedback emitted by another local Runtime");
  assert.equal(read!.observations!.find(item => item.kind === "feedback")!.sourceRefs[0]!.runId, "correction");
});
