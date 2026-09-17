import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { ControlPlaneStore } from "../src/control-plane/control-plane-store.ts";
import { PersistentMultiRuntimeRouter } from "../src/control-plane/persistent-router.ts";
import { startAssignmentReconciler } from "../src/control-plane/assignment-reconciler.ts";
import { streamEvents } from "../src/http/router-http.ts";
import type { RuntimeRunStatus } from "../src/domain/contracts.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(getRun: (id: string) => Promise<RuntimeRunStatus>) {
  const database = new AppDatabase(":memory:"); const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ id: "host", endpoint: "http://host", profile: "general", capabilities: ["document"], maxConcurrentRuns: 20, activeRunCount: 0, status: "ready" }], 100);
  await store.heartbeat({ runtimeId: "host", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  let dispatches = 0;
  const router = new PersistentMultiRuntimeRouter({ store, now: () => 200, endpointFactory: () => ({
    dispatch: async () => ({ remoteRunId: `run-${++dispatches}` }), getRun,
  }) });
  const submit = (id: string) => router.submit({ tenantId: "tenant", ownerUserId: "user", conversationId: `c-${id}`, clientMessageId: id,
    input: "fixture", resourceRefs: [] });
  return { database, store, router, submit, dispatches: () => dispatches };
}

test("without any browser read, background reconciliation persists Host terminal status to assignment and task", async () => {
  const f = await fixture(async (remoteRunId) => ({ remoteRunId, status: "completed", finishedAt: 200 }));
  const assignment = await f.submit("one");
  const stop = startAssignmentReconciler(f.router);
  try {
    await stop(); // Awaits the initial background pass, with no events/status client.
    assert.equal((await f.store.assignment(assignment.id))?.status, "completed");
    const row = await f.database.prepare("SELECT status FROM mr_tasks").get() as { status: string };
    assert.equal(row.status, "completed"); assert.equal(f.dispatches(), 1);
  } finally { await stop(); await f.database.close(); }
});

test("unreachable Host is not a failed Run; bounded keyset batches reach other assignments and later retry", async () => {
  let unavailable = true;
  const seen: string[] = [];
  const f = await fixture(async (remoteRunId) => {
    seen.push(remoteRunId);
    if (remoteRunId === "run-1" && unavailable) throw new Error("offline");
    return { remoteRunId, status: "completed" };
  });
  try {
    const a = await f.submit("one"); const b = await f.submit("two");
    await f.router.reconcileAssignments(1); await f.router.reconcileAssignments(1);
    assert.equal((await f.store.assignment(a.id))?.status, "accepted");
    assert.equal((await f.store.assignment(b.id))?.status, "completed");
    assert.deepEqual(new Set(seen), new Set(["run-1", "run-2"]));
    unavailable = false;
    await f.router.reconcileAssignments(1); await f.router.reconcileAssignments(1);
    assert.equal((await f.store.assignment(a.id))?.status, "completed");
  } finally { await f.database.close(); }
});

test("reconciliation passes do not overlap and stale running responses cannot undo a terminal assignment", async () => {
  let release!: (run: RuntimeRunStatus) => void;
  const f = await fixture(() => new Promise((resolve) => { release = resolve; }));
  try {
    const a = await f.submit("one");
    const first = f.router.reconcileAssignments();
    assert.equal(f.router.reconcileAssignments(), first);
    await settle();
    await f.store.observeRun(a.id, { remoteRunId: "run-1", status: "cancelled" }, 250);
    release({ remoteRunId: "run-1", status: "running" }); await first;
    assert.equal((await f.store.assignment(a.id))?.status, "cancelled"); assert.equal(f.dispatches(), 1);
  } finally { await f.database.close(); }
});

test("a mismatched Host response cannot change an assignment", async () => {
  const f = await fixture(async () => ({ remoteRunId: "wrong-run", status: "completed" }));
  try { const a = await f.submit("one"); await f.router.reconcileAssignments(); assert.equal((await f.store.assignment(a.id))?.status, "accepted"); }
  finally { await f.database.close(); }
});

test("late observation does not move an old conversation above recent work", async () => {
  const f = await fixture(async (remoteRunId) => ({ remoteRunId, status: "completed", finishedAt: 220 }));
  try {
    const old = await f.submit("old"); const recent = await f.submit("recent");
    await f.store.observeRun(recent.id, { remoteRunId: "run-2", status: "completed", finishedAt: 500 }, 510);
    await f.store.observeRun(old.id, { remoteRunId: "run-1", status: "completed", finishedAt: 220 }, 10_000);
    const page = await f.store.listConversations("tenant", "user", { limit: 30, offset: 0 });
    assert.deepEqual(page.conversations.map((c) => [c.id, c.updatedAt]), [["c-recent", 500], ["c-old", 220]]);
    const row = await f.database.prepare("SELECT last_observed_at FROM mr_assignments WHERE id = ?").get(old.id) as { last_observed_at: number };
    assert.equal(row.last_observed_at, 10_000);
  } finally { await f.database.close(); }
});

test("running observation preserves admission time and missing finish time does not manufacture activity", async () => {
  const f = await fixture(async (remoteRunId) => ({ remoteRunId, status: "running" }));
  try {
    const a = await f.submit("one");
    await f.store.observeRun(a.id, { remoteRunId: "run-1", status: "running" }, 10_000);
    const row = await f.database.prepare("SELECT updated_at, last_observed_at FROM mr_assignments WHERE id = ?").get(a.id) as { updated_at: number; last_observed_at: number };
    assert.equal(row.updated_at, 200); assert.equal(row.last_observed_at, 10_000);
    await f.store.observeRun(a.id, { remoteRunId: "run-1", status: "completed" }, 20_000);
    const page = await f.store.listConversations("tenant", "user", { limit: 30, offset: 0 });
    assert.equal(page.conversations[0].updatedAt, 200);
  } finally { await f.database.close(); }
});

test("terminal event projection retains event time rather than poll time", async () => {
  const f = await fixture(async (remoteRunId) => ({ remoteRunId, status: "running" }));
  try {
    const a = await f.submit("one");
    const replayRouter = new PersistentMultiRuntimeRouter({ store: f.store, now: () => 10_000, endpointFactory: () => ({
      dispatch: async () => { throw new Error("must not dispatch"); },
      events: async () => [{ seq: 2, type: "run.completed", data: {}, createdAt: 250 }],
    }) });
    await replayRouter.events(a.id, 0);
    const page = await f.store.listConversations("tenant", "user", { limit: 30, offset: 0 });
    assert.equal(page.conversations[0].updatedAt, 250);
  } finally { await f.database.close(); }
});

test("late parent observation cannot overwrite a newer continuation task status or activity", async () => {
  const f = await fixture(async (remoteRunId) => ({ remoteRunId, status: "running" }));
  try {
    const a = await f.submit("one");
    await f.store.createContinuationAssignment(a.id, "child-run", 500);
    await f.store.observeRun(a.id, { remoteRunId: "run-1", status: "failed", finishedAt: 250 }, 10_000);
    const page = await f.store.listConversations("tenant", "user", { limit: 30, offset: 0 });
    assert.equal(page.conversations[0].lastStatus, "running");
    assert.equal(page.conversations[0].updatedAt, 500);
    assert.equal((await f.store.assignment(a.id))?.status, "failed");
  } finally { await f.database.close(); }
});

function responseFixture() {
  const response = new EventEmitter() as EventEmitter & { statusCode: number; setHeader(): void; flushHeaders(): void; write(value: string): void; end(): void };
  const writes: string[] = [];
  response.setHeader = () => {}; response.flushHeaders = () => {}; response.write = (value) => { writes.push(value); };
  response.end = () => { response.emit("close"); };
  return { response, writes };
}

test("empty resume preserves afterSeq, non-overlapping polls, and a terminal snapshot without invented seq", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { response, writes } = responseFixture();
  let release!: () => void; let polls = 0;
  streamEvents(new EventEmitter() as never, response as never, async (_id, afterSeq) => {
    assert.equal(afterSeq, 398); polls++;
    await new Promise<void>((resolve) => { release = resolve; });
    return { assignment: { tenantId: "tenant", ownerUserId: "user" }, events: [] };
  }, "a", [], 398, async () => ({ remoteRunId: "run", status: "completed", output: "final" }));
  t.mock.timers.tick(3000); assert.equal(polls, 1);
  release(); await settle();
  assert.match(writes.join(""), /event: run.snapshot/); assert.doesNotMatch(writes.join(""), /^id:/m);
  t.mock.timers.tick(2000); assert.equal(polls, 1);
});

test("Router upstream polling error is transport-only; later durable terminal event is still emitted", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { response, writes } = responseFixture(); let calls = 0;
  streamEvents(new EventEmitter() as never, response as never, async () => {
    if (++calls === 1) throw new Error("temporary fetch failure");
    return { assignment: { tenantId: "t", ownerUserId: "u" }, events: [{ seq: 2, type: "run.completed", data: {}, createdAt: 2 }] };
  }, "a", []);
  try {
    t.mock.timers.tick(1000); await settle();
    assert.match(writes.join(""), /event: stream.error/); assert.doesNotMatch(writes.join(""), /run.failed/);
    t.mock.timers.tick(1000); await settle(); assert.match(writes.join(""), /event: run.completed/);
  } finally { response.emit("close"); }
});
