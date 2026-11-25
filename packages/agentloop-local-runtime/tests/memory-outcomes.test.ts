import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { InMemoryMemoryStore, SqliteMemoryStore } from "@zhujun/agentloop-memory";
import { LocalMemoryOutcomes } from "../src/memory/local-memory-outcomes.ts";

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: terminal outbox recovers missed HIL notifications and retries acknowledgement across restart`, async t => {
  const runtime = new AppDatabase(":memory:"), memory = new AppDatabase(":memory:");
  t.after(() => { runtime.close(); memory.close(); });
  await runtime.ready();
  const store = backend === "memory" ? new InMemoryMemoryStore() : new SqliteMemoryStore(memory);
  if (backend === "sqlite") await (store as SqliteMemoryStore).ready();
  const add = async (id: string, owner: string, status = "completed") => {
    await runtime.prepare("INSERT INTO runs(id,owner_user_id,depth,status,input,created_at) VALUES (?,?,0,?,'test',1)").run(id, owner, status);
    await runtime.prepare("INSERT INTO run_outcomes(run_id,status,result_ref,reason_code,committed_at) VALUES (?,?,?,'test',1)").run(id, status, status === "completed" ? `result:${id}` : null);
  };
  await add("hil-resumed", "alice"); await add("failed", "alice", "failed"); await add("other-owner", "bob");
  await runtime.prepare("INSERT INTO runs(id,owner_user_id,depth,status,input,created_at) VALUES ('unfinished','alice',0,'running','test',1)").run();
  const sources = () => [{ sourceId: "runtime", database: runtime }];
  const scope = { tenantId: "device", ownerUserId: "alice" };
  const original = store.advanceFeedbackCursor.bind(store);
  let interrupt = true;
  store.advanceFeedbackCursor = async (...args) => { if (interrupt) { interrupt = false; throw new Error("crash after enqueue"); } return original(...args); };
  await assert.rejects(new LocalMemoryOutcomes({ store, tenantId: "device", sources }).poll(), /crash/);
  assert.equal((await store.settlementJobs(scope, "hil-resumed")).length + (await store.settlementJobs(scope, "failed")).length, 1, "exactly the enqueued record survives a failed acknowledgement");
  const reloaded = backend === "sqlite" ? new SqliteMemoryStore(memory) : store;
  const poller = new LocalMemoryOutcomes({ store: reloaded, tenantId: "device", sources, now: () => 10 });
  await poller.poll(); await poller.poll();
  assert.equal((await reloaded.settlementJobs(scope, "hil-resumed")).length, 1, "notification and replay cannot create two learning cases");
  assert.equal((await reloaded.settlementJobs(scope, "failed"))[0]!.terminalCommitRef, "failed:1");
  assert.deepEqual(await reloaded.settlementJobs(scope, "other-owner"), []);
  assert.equal((await reloaded.settlementJobs({ ...scope, ownerUserId: "bob" }, "other-owner")).length, 1);
  assert.deepEqual(await reloaded.settlementJobs(scope, "unfinished"), []);
  await runtime.prepare("DELETE FROM runs WHERE id = 'other-owner'").run();
  await add("replacement", "alice", "cancelled");
  await poller.poll();
  assert.equal((await reloaded.settlementJobs(scope, "replacement")).length, 1, "rowid reuse cannot hide a new terminal outcome");
});

test("outbox failure leaves the cursor for retry and never acknowledges a later outcome", async t => {
  const runtime = new AppDatabase(":memory:"); t.after(() => runtime.close()); await runtime.ready();
  for (const id of ["first", "second"]) {
    await runtime.prepare("INSERT INTO runs(id,owner_user_id,depth,status,input,created_at) VALUES (?,'alice',0,'completed','test',1)").run(id);
    await runtime.prepare("INSERT INTO run_outcomes(run_id,status,reason_code,committed_at) VALUES (?,'completed','test',1)").run(id);
  }
  const store = new InMemoryMemoryStore();
  const enqueue = store.enqueueSettlement.bind(store);
  store.enqueueSettlement = async () => { throw new Error("memory busy"); };
  const poller = new LocalMemoryOutcomes({ store, tenantId: "device", sources: () => [{ sourceId: "runtime", database: runtime }] });
  await assert.rejects(poller.poll(), /memory busy/);
  assert.equal(await store.feedbackCursor("device:outcomes:runtime"), undefined);
  store.enqueueSettlement = enqueue; await poller.poll();
  assert.equal((await store.settlementJobs({ tenantId: "device", ownerUserId: "alice" }, "second")).length, 1);
});
