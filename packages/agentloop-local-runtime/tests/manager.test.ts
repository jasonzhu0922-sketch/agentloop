import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { createLocalRuntimeManager, type LocalModelProviderPort, type ManagedLocalRuntime } from "@zhujun/agentloop-local-runtime";
import { LocalRunAdmissionService, LocalRuntimeFactory } from "@zhujun/agentloop-local-runtime/host";
import { greetingModel, modelPort } from "./fixtures/models.ts";

const owner = { ownerUserId: "alice" }; const other = { ownerUserId: "bob" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}
async function fixture(t: test.TestContext, models = modelPort(), capacity = 10) {
  const root = await mkdtemp(join(tmpdir(), "shared-runtime-manager-"));
  const skills = join(root, "skills"); await mkdir(skills);
  const options = { dataDirectory: root, defaultRuntimeId: "stable-default", models, maxConcurrentRuns: capacity, bundledSkillDirectories: [skills] };
  let manager = await createLocalRuntimeManager(options);
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { root, options, manager, reopen: async () => {
    await manager.close(); manager = await createLocalRuntimeManager(options); return manager;
  } };
}
async function settle(runtime: ManagedLocalRuntime, id: string, context = owner) {
  for (let count = 0; count < 300; count++) {
    const run = await runtime.getRun(context, id);
    if (run.status !== "running") { await setTimeout(5); return run; }
    await setTimeout(10);
  }
  throw new Error("controlled Run did not settle");
}
function audit<T>(path: string, operation: (database: DatabaseSync) => T, readOnly = true): T {
  const database = new DatabaseSync(path, { readOnly });
  try { return operation(database); } finally { database.close(); }
}

async function controlFixture(t: test.TestContext, legacyLedger = false) {
  const root = await mkdtemp(join(tmpdir(), "shared-admission-control-"));
  const skills = join(root, "skills"); await mkdir(skills);
  if (legacyLedger) audit(join(root, "runtime.db"), db => {
    db.exec(`CREATE TABLE local_run_admissions (
      owner_user_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      reservation_id TEXT NOT NULL, run_id TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY(owner_user_id, request_id), UNIQUE(run_id))`);
    db.prepare("INSERT INTO local_run_admissions VALUES (?, ?, ?, ?, NULL, ?)")
      .run(owner.ownerUserId, "pre-migration", "fingerprint", "reservation", Date.now());
  }, false);
  const control = await new LocalRuntimeFactory({ databasePath: join(root, "runtime.db"), skillPackageStoreRoot: join(root, "packages"),
    models: modelPort(), environment: { AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: skills } }).create({
    id: "test", displayName: "Test", storageKey: "default", isDefault: true,
  }, { customSkillDirectories: [], mcpServers: [], integrationEnvironment: { WEB_SEARCH_DISABLED: "1" } }, join(root, "workspace"), join(root, "uploads"));
  t.after(async () => { await control.close?.(); await control.database.close(); await rm(root, { recursive: true, force: true }); });
  return { root, control };
}

test("managed runtimes pass trusted search opt-in to the factory and default to disabled", async t => {
  const original = LocalRuntimeFactory.prototype.create;
  const calls: Array<{ disabled: string | undefined; options: unknown; planning: number | undefined; step: number | undefined }> = [];
  t.mock.method(LocalRuntimeFactory.prototype, "create", function (...args: Parameters<typeof original>) {
    calls.push({ disabled: args[1].integrationEnvironment.WEB_SEARCH_DISABLED, options: this.input.webToolsOptions, planning: this.input.planningMaxTurns, step: this.input.stepMaxTurns });
    return original.apply(this, args);
  });
  const root = await mkdtemp(join(tmpdir(), "managed-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skills = join(root, "skills"); await mkdir(skills);
  const options = { dataDirectory: root, defaultRuntimeId: "default", models: modelPort(), bundledSkillDirectories: [skills] };
  const disabled = await createLocalRuntimeManager(options); await disabled.close();
  const search = { searchProvider: "bocha" as const, searchEndpoint: "https://search.example/v1", searchApiKey: "test-key" };
  const enabled = await createLocalRuntimeManager({ ...options, webSearch: search, planningMaxTurns: 8, stepMaxTurns: 64 }); await enabled.close();
  assert.equal(calls[0]?.disabled, "1");
  assert.equal(calls[1]?.disabled, "0");
  assert.deepEqual(calls[1]?.options, search);
  assert.equal(calls[1]?.planning, 8); assert.equal(calls[1]?.step, 64);
});

test("managed business views survive lifecycle changes and database reopen without exposing controls", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected_network"); });
  const { manager, reopen } = await fixture(t);
  for (const key of ["supervisor", "configurations", "services"]) assert.equal(key in manager, false);
  const view = manager.runtime("stable-default");
  assert.equal("database" in view, false); assert.equal("runs" in view, false); assert.equal("close" in view, false);
  assert.deepEqual(await view.models(), ["local:test"]);
  const child = await manager.createRuntime("Research");
  const run = await view.startRun(owner, { requestId: "first", input: "你好", modelKey: "local:test" });
  assert.equal((await settle(view, run.id)).status, "completed");
  await assert.rejects(manager.runtime(child.id).getRun(owner, run.id), /not found/i);
  await assert.rejects(view.getRun(other, run.id), /not found/i);
  const events = await view.events(owner, run.id);
  await manager.restartRuntime("stable-default");
  assert.deepEqual(await view.events(owner, run.id), events, "retained views must resolve the new control");
  await manager.stopRuntime(child.id);
  await manager.configureRuntime(child.id, { skillPackageIds: [], mcpServers: [] });
  await manager.startRuntime(child.id);
  await manager.stopRuntime(child.id);
  const restored = await reopen();
  assert.equal((await restored.runtimes())[0]?.id, "stable-default");
  assert.equal((await restored.runtimes())[1]?.status, "stopped");
  assert.deepEqual(await restored.runtime("stable-default").events(owner, run.id), events);
  await assert.rejects(manager.runtimes(), /local_runtime_closed/);
});

test("concurrent owner-scoped retries create one Run and preserve identity after restart", async (t) => {
  const { root, manager, reopen } = await fixture(t);
  const runtime = manager.runtime("stable-default");
  const input = { requestId: "retry-1", input: "你好", modelKey: "local:test" };
  const runs = await Promise.all(Array.from({ length: 8 }, () => runtime.startRun(owner, input)));
  assert.equal(new Set(runs.map(run => run.id)).size, 1);
  await assert.rejects(runtime.startRun(owner, { ...input, input: "different" }), /request_id_payload_conflict/);
  await assert.rejects(runtime.startRun(owner, { ...input, connectorConnectionIds: [] }), /request_id_payload_conflict/);
  await settle(runtime, runs[0]!.id);
  const bob = await runtime.startRun(other, input);
  assert.notEqual(bob.id, runs[0]!.id);
  await settle(runtime, bob.id, other);
  audit(join(root, "runtime.db"), db => {
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count, 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM local_run_admissions WHERE run_id IS NOT NULL").get() as { count: number }).count, 2);
  });
  const restored = await reopen();
  const replay = await restored.runtime("stable-default").startRun(owner, input);
  assert.equal(replay.id, runs[0]!.id);
  assert.equal(replay.status, "completed");
  audit(join(root, "runtime.db"), db => assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count, 2));
});

test("a binding write failure rolls back Kernel Run creation and permits a provably safe retry", async (t) => {
  let invocations = 0;
  const { root, manager } = await fixture(t, modelPort(greetingModel(() => { invocations++; })));
  const path = join(root, "runtime.db");
  const runtime = manager.runtime("stable-default");
  const seed = await runtime.startRun(owner, { requestId: "seed", input: "你好", modelKey: "local:test" });
  await settle(runtime, seed.id);
  const source = await runtime.upload(owner, { conversationId: seed.conversationId, originalName: "evidence.txt", content: Buffer.from("local evidence") });
  const beforeFailure = invocations;
  audit(path, db => db.exec(`CREATE TRIGGER reject_admission_binding BEFORE UPDATE OF run_id ON local_run_admissions
    BEGIN SELECT RAISE(ABORT, 'test_binding_write_failed'); END`), false);
  const input = { requestId: "storage-failure", input: "你好", modelKey: "local:test", conversationId: seed.conversationId, uploadedSourceIds: [source.id] };
  await assert.rejects(runtime.startRun(owner, input), /test_binding_write_failed/);
  assert.equal(invocations, beforeFailure, "a failed admission cannot reach any model operation");
  audit(path, db => {
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count, 1, "only the seed Run remains");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM run_sources").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM local_run_admissions").get() as { count: number }).count, 1, "only the seed admission remains");
    db.exec("DROP TRIGGER reject_admission_binding");
  }, false);
  const run = await runtime.startRun(owner, input);
  assert.equal((await settle(runtime, run.id)).status, "completed");
  assert.ok(invocations > beforeFailure);
  audit(path, db => assert.equal((db.prepare("SELECT COUNT(*) AS count FROM run_sources WHERE source_id = ?").get(source.id) as { count: number }).count, 1));
});

test("an unbound reservation left by process loss is reported as unknown and never automatically replayed", async (t) => {
  const { root, manager, reopen } = await fixture(t);
  const input = { requestId: "interrupted", input: "你好", modelKey: "local:test" };
  const fingerprint = createHash("sha256").update(JSON.stringify({ input: input.input, modelKey: input.modelKey,
    conversationId: null, directoryScopeIds: [], uploadedSourceIds: [], connectorConnectionIds: null, allowDangerousTools: false })).digest("hex");
  audit(join(root, "runtime.db"), db => db.prepare(`INSERT INTO local_run_admissions
    (owner_user_id, request_id, fingerprint, reservation_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(owner.ownerUserId, input.requestId, fingerprint, "lost-process", Date.now()), false);
  const restored = await reopen();
  await assert.rejects(restored.runtime("stable-default").startRun(owner, input), /admission_outcome_unknown/);
  audit(join(root, "runtime.db"), db => assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count, 0));
  assert.equal((await restored.runtimes())[0]?.activeRunCount, 0);
  await assert.rejects(manager.runtimes(), /local_runtime_closed/);
});

test("restored running admissions retain capacity regardless of age and never replay model execution", async (t) => {
  let invocations = 0;
  const { root, manager, reopen } = await fixture(t, modelPort(greetingModel(() => { invocations++; })), 1);
  const input = { requestId: "restored-running", input: "你好", modelKey: "local:test" };
  await manager.close();
  // Persisted-state fixture, not an actual process kill or external-tool retry.
  const runId = "persisted-running"; const createdAt = Date.now() - 3_600_000;
  const fingerprint = createHash("sha256").update(JSON.stringify({ input: input.input, modelKey: input.modelKey,
    conversationId: null, directoryScopeIds: [], uploadedSourceIds: [], connectorConnectionIds: null, allowDangerousTools: false })).digest("hex");
  audit(join(root, "runtime.db"), db => {
    db.exec("BEGIN");
    db.prepare("INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("persisted-conversation", owner.ownerUserId, input.input, createdAt, createdAt);
    db.prepare("INSERT INTO runs(id, owner_user_id, conversation_id, depth, status, input, model_key, created_at) VALUES (?, ?, ?, 0, 'running', ?, ?, ?)")
      .run(runId, owner.ownerUserId, "persisted-conversation", input.input, input.modelKey, createdAt);
    db.prepare("INSERT INTO local_run_admissions(owner_user_id, request_id, fingerprint, reservation_id, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(owner.ownerUserId, input.requestId, fingerprint, "committed-reservation", runId, createdAt);
    db.exec("COMMIT");
  }, false);
  const beforeReopen = invocations;
  const restored = await reopen(); const runtime = restored.runtime("stable-default");
  assert.equal((await restored.runtimes())[0]?.activeRunCount, 1);
  assert.equal((await runtime.startRun(owner, input)).id, runId);
  assert.equal(invocations, beforeReopen);
  await assert.rejects(runtime.startRun(owner, { ...input, requestId: "new" }), /runtime_capacity_exhausted/);
  await assert.rejects(restored.close(), /runtime_active_runs_prevent_close/);
  await runtime.cancelRun(owner, runId);
  assert.equal((await restored.runtimes())[0]?.activeRunCount, 0);
  assert.equal(invocations, beforeReopen);
});

test("cancelled status does not permit teardown while the model execution is still unwinding", async (t) => {
  const entered = deferred(); const release = deferred(); const base = greetingModel();
  const models = modelPort({ ...base, async complete(input, signal) {
    entered.resolve(); await release.promise;
    return base.complete(input, signal);
  } });
  const { manager } = await fixture(t, models, 1);
  const runtime = manager.runtime("stable-default");
  const input = { requestId: "slow", input: "你好", modelKey: "local:test" };
  const run = await runtime.startRun(owner, input); await entered.promise;
  try {
    assert.equal((await runtime.startRun(owner, input)).id, run.id, "replay does not consume another capacity slot");
    await assert.rejects(runtime.startRun(owner, { ...input, requestId: "over-capacity" }), /runtime_capacity_exhausted/);
    await runtime.cancelRun(owner, run.id);
    await assert.rejects(manager.close(), /runtime_active_runs_prevent_close/);
    assert.equal((await manager.stopRuntime("stable-default")).status, "draining");
    await assert.rejects(runtime.startRun(owner, { ...input, requestId: "after-drain" }), /runtime_draining/);
  } finally { release.resolve(); }
  for (let count = 0; count < 300; count++) {
    if ((await manager.runtimes())[0]?.status === "stopped") break;
    await setTimeout(10);
  }
  assert.equal((await manager.runtimes())[0]?.status, "stopped");
  await manager.startRuntime("stable-default");
  assert.equal((await runtime.getRun(owner, run.id)).status, "cancelled");
});

test("manager close refuses in-flight business operations, stays usable after refusal, and is idempotent", async (t) => {
  const { manager } = await fixture(t);
  const operation = manager.runtime("stable-default").conversations(owner);
  await assert.rejects(manager.close(), /runtime_operations_prevent_close/);
  await operation;
  assert.equal((await manager.runtimes()).length, 1);
  const closing = manager.close();
  await assert.rejects(manager.runtimes(), /local_runtime_closed/);
  await Promise.all([closing, manager.close()]);
  await manager.close();
});

test("a lost response after atomic commit recovers the original Run rather than starting a second", async (t) => {
  const { root, control } = await controlFixture(t);
  const original = control.runs.startConversation.bind(control.runs);
  t.mock.method(control.runs, "startConversation", async (...args) => {
    const run = await original(...args);
    await control.runs.whenRunIdle(run.id);
    throw new Error("test_response_lost_after_commit");
  });
  const admissions = new LocalRunAdmissionService(control);
  const input = { requestId: "lost-response", input: "你好", modelKey: "local:test" };
  const legacy = { dispatchKey: "legacy-dispatch", assignmentId: "assignment-a" };
  const first = await admissions.startResult(owner.ownerUserId, input, legacy);
  const replay = await admissions.startResult(owner.ownerUserId, input, legacy);
  assert.equal(replay.run.id, first.run.id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.status, "completed");
  await assert.rejects(admissions.start(owner.ownerUserId, { ...input, input: "conflicting" }, legacy), /request_id_payload_conflict/);
  const legacyRow = await control.database.prepare("SELECT owner_user_id, remote_run_id FROM local_runtime_dispatches WHERE dispatch_key = ?").get(legacy.dispatchKey) as { owner_user_id: string; remote_run_id: string };
  assert.deepEqual({ ...legacyRow }, { owner_user_id: owner.ownerUserId, remote_run_id: first.run.id });
  await control.database.prepare("DELETE FROM local_run_admissions").run();
  const historical = await admissions.startResult(owner.ownerUserId, { ...input, requestId: "historical", modelKey: "local:removed" }, legacy);
  assert.equal(historical.run.id, first.run.id, "old-format ledgers remain readable without a current model");
  await assert.rejects(admissions.start(other.ownerUserId, input, legacy), /local_runtime_dispatch_owner_mismatch/);
  await admissions.flushSettlements();
  audit(join(root, "runtime.db"), db => assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count, 1));
});

test("conversation deletion atomically preserves retry tombstones without hiding unexpected missing Runs", async (t) => {
  const { control } = await controlFixture(t, true);
  const migrated = await control.database.prepare("SELECT run_deleted FROM local_run_admissions WHERE request_id = 'pre-migration'").get() as { run_deleted: number };
  assert.equal(migrated.run_deleted, 0, "migration preserves existing reservations");
  const admissions = new LocalRunAdmissionService(control);
  const input = { requestId: "deleted", input: "你好", modelKey: "local:test" };
  const first = await admissions.start(owner.ownerUserId, input);
  await control.runs.whenRunIdle(first.id); await admissions.flushSettlements();
  assert.ok(first.conversationId);
  await assert.rejects(control.runs.deleteConversation(other.ownerUserId, first.conversationId!), /not found/i);
  await control.database.exec(`CREATE TRIGGER reject_conversation_delete BEFORE DELETE ON conversations
    BEGIN SELECT RAISE(ABORT, 'test_delete_rollback'); END`);
  await assert.rejects(control.runs.deleteConversation(owner.ownerUserId, first.conversationId!), /test_delete_rollback/);
  assert.equal((await admissions.start(owner.ownerUserId, input)).id, first.id, "rolled-back deletion must also roll back its mark");
  await control.database.exec("DROP TRIGGER reject_conversation_delete");
  await control.runs.deleteConversation(owner.ownerUserId, first.conversationId!);
  await admissions.refresh();
  await assert.rejects(admissions.start(owner.ownerUserId, input), /admission_run_deleted/);
  const next = await admissions.start(owner.ownerUserId, { ...input, requestId: "unrelated" });
  assert.notEqual(next.id, first.id);
  await control.runs.whenRunIdle(next.id); await admissions.flushSettlements();
  const tombstone = await control.database.prepare("SELECT run_id, run_deleted FROM local_run_admissions WHERE request_id = ?")
    .get(input.requestId) as { run_id: string; run_deleted: number };
  assert.deepEqual({ ...tombstone }, { run_id: first.id, run_deleted: 1 });
  await control.database.prepare(`INSERT INTO local_run_admissions
    (owner_user_id, request_id, fingerprint, reservation_id, run_id, created_at) VALUES (?, 'corrupt', '', '', 'missing-run', ?)`)
    .run(owner.ownerUserId, Date.now());
  await assert.rejects(admissions.refresh(), /admission_run_missing/, "unmarked missing Runs are still integrity failures");
  await control.database.prepare("DELETE FROM local_run_admissions WHERE request_id = 'corrupt'").run();
  await admissions.flushSettlements();
});

test("concurrent distinct requests do not share rollback or leak a failed reservation", async (t) => {
  const { root, manager } = await fixture(t);
  const path = join(root, "runtime.db"); const runtime = manager.runtime("stable-default");
  audit(path, db => db.exec(`CREATE TRIGGER reject_one_admission BEFORE UPDATE OF run_id ON local_run_admissions
    WHEN OLD.request_id = 'fails' BEGIN SELECT RAISE(ABORT, 'test_one_binding_failed'); END`), false);
  const results = await Promise.allSettled([
    runtime.startRun(owner, { requestId: "fails", input: "你好", modelKey: "local:test" }),
    runtime.startRun(owner, { requestId: "succeeds", input: "你好", modelKey: "local:test" }),
  ]);
  assert.equal(results[0]?.status, "rejected");
  assert.equal(results[1]?.status, "fulfilled");
  const succeeded = results[1];
  if (succeeded?.status !== "fulfilled") throw new Error("the unrelated request failed");
  await settle(runtime, succeeded.value.id);
  audit(path, db => {
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count, 1);
    assert.deepEqual(db.prepare("SELECT request_id FROM local_run_admissions").all().map(row => row.request_id), ["succeeds"]);
  });
});
