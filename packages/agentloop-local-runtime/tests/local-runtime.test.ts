import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { AppDatabase, type ModelAdapter, type ModelInvocation } from "@zhujun/agentloop";
import { createLocalRuntime, type LocalModelProviderPort } from "@zhujun/agentloop-local-runtime";
import { LocalRuntimeFactory, LocalRuntimeDatabaseRegistry, LocalRuntimeSupervisor } from "@zhujun/agentloop-local-runtime/host";
import { greetingModel, modelPort } from "./fixtures/models.ts";

const owner = { ownerUserId: "owner-a" };
const otherOwner = { ownerUserId: "owner-b" };

async function fixture(t: test.TestContext, models = modelPort()) {
  const root = await mkdtemp(join(tmpdir(), "agentloop-shared-local-"));
  const skillRoot = join(root, "skills"); await mkdir(skillRoot);
  const options = { id: "standalone", databasePath: join(root, "runtime.db"), workspaceRoot: join(root, "workspace"),
    uploadStorageRoot: join(root, "uploads"), skillPackageStoreRoot: join(root, "packages"),
    bundledSkillDirectories: [skillRoot], models };
  let runtime = await createLocalRuntime(options);
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { root, runtime, options, reopen: async () => { await runtime.close(); runtime = await createLocalRuntime(options); return runtime; } };
}

async function settle(runtime: Awaited<ReturnType<typeof createLocalRuntime>>, id: string) {
  for (let count = 0; count < 300; count++) {
    const run = await runtime.getRun(owner, id);
    if (run.status !== "running") return run;
    await setTimeout(10);
  }
  throw new Error("controlled local Run did not settle");
}

test("standalone host executes and restores a Run and ordered events without Router or registration", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected_network_request"); });
  let invocations = 0;
  const { root, runtime, reopen } = await fixture(t, modelPort(greetingModel(() => { invocations++; })));
  assert.deepEqual(runtime.models(), ["local:test"]);
  assert.equal("database" in runtime, false);
  assert.equal("runs" in runtime, false);
  assert.equal("admissions" in runtime, false);
  const started = await runtime.startRun(owner, { input: "你好", modelKey: "local:test" });
  const run = await settle(runtime, started.id);
  assert.equal(run.status, "completed", run.errorCode);
  assert.match(run.output ?? "", /本机 Runtime/);
  assert.ok(invocations >= 3, "intent, execution and assessment use the real Kernel");
  const events = await runtime.events(owner, run.id);
  assert.ok(events.length > 0);
  const lastSeq = events[Math.floor(events.length / 2)]!.seq;
  assert.deepEqual(await runtime.events(owner, run.id, lastSeq), events.filter(event => event.seq > lastSeq));
  await assert.rejects(runtime.getRun(otherOwner, run.id), /not found/i);
  await assert.rejects(runtime.events(otherOwner, run.id), /not found/i);
  await assert.rejects(runtime.artifacts(otherOwner, run.id), /not found/i);
  assert.deepEqual(await runtime.conversations(otherOwner), []);
  const uploaded = await runtime.upload(owner, { conversationId: run.conversationId, originalName: "notes.txt", content: Buffer.from("local-only source") });
  assert.equal((await runtime.source(owner, uploaded.id)).originalName, "notes.txt");
  await assert.rejects(runtime.source(otherOwner, uploaded.id), /not found/i);
  await assert.rejects(runtime.upload(otherOwner, { conversationId: run.conversationId, originalName: "wrong-owner.txt", content: Buffer.from("denied") }), /not found/i);
  const restored = await reopen();
  assert.equal((await restored.getRun(owner, run.id)).output, run.output);
  assert.deepEqual(await restored.events(owner, run.id), events);
  assert.equal((await restored.source(owner, uploaded.id)).originalName, "notes.txt");
  assert.ok((await restored.conversations(owner)).some(item => item.id === run.conversationId));
  const files = await readdir(root);
  assert.equal(files.includes("memory.db"), false);
  assert.equal(files.includes("device-identity.json"), false);
});

test("shared Supervisor and Factory execute the real Kernel and restore isolated Runtime databases without a Router", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected_network_request"); });
  const root = await mkdtemp(join(tmpdir(), "shared-supervisor-kernel-"));
  const skills = join(root, "skills"); await mkdir(skills);
  const open = async () => {
    const factory = new LocalRuntimeFactory({ databasePath: join(root, "default.db"),
      runtimeDataRoot: join(root, "runtimes"), skillPackageStoreRoot: join(root, "packages"),
      environment: { AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: skills }, models: modelPort() });
    const database = new AppDatabase(join(root, "supervisor.db"));
    return new LocalRuntimeSupervisor(database, (definition, configuration) => factory.create(definition, {
      ...configuration, integrationEnvironment: { ...configuration.integrationEnvironment, WEB_SEARCH_DISABLED: "1" },
    }, join(root, "workspace"), join(root, "uploads")));
  };
  let supervisor = await open();
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true }); });
  await supervisor.ready("stable-default");
  const child = await supervisor.create("Research");
  const left = supervisor.runtime("stable-default"); const right = supervisor.runtime(child.id);
  assert.notEqual(left.database, right.database);
  const grant = await left.scopes.create(skills);
  await assert.rejects(right.scopes.paths([grant.id]), /directory scope is unavailable/);
  const started = await supervisor.admitRun("stable-default", async runtime => {
    const run = await runtime.runs.startConversation(owner.ownerUserId, "你好", { modelKey: "local:test" });
    return { runId: run.id, value: run };
  });
  let run = started;
  for (let count = 0; run.status === "running" && count < 300; count++) {
    await setTimeout(10);
    run = await left.runs.get(owner.ownerUserId, started.id);
  }
  assert.equal(run.status, "completed", run.errorCode);
  await supervisor.runSettled("stable-default", run.id);
  const events = await left.runs.events(owner.ownerUserId, run.id);
  assert.ok(events.length > 0);
  await assert.rejects(right.runs.get(owner.ownerUserId, run.id), /not found/i);
  await supervisor.stop(child.id);
  await supervisor.close();
  supervisor = await open();
  await supervisor.ready("unused-new-id");
  assert.equal((await supervisor.list())[0]?.id, "stable-default");
  assert.equal((await supervisor.list())[1]?.status, "stopped");
  const restored = supervisor.runtime("stable-default");
  assert.deepEqual(await restored.runs.events(owner.ownerUserId, run.id), events);
  assert.equal((await restored.runs.get(owner.ownerUserId, run.id)).output, run.output);
  await assert.rejects(restored.runs.get(otherOwner.ownerUserId, run.id), /not found/i);
});

test("directory grants survive reopen and revoked or foreign scope IDs cannot authorize a Run", async (t) => {
  const { root, runtime, reopen } = await fixture(t);
  const directory = join(root, "consented"); await mkdir(directory);
  const grant = await runtime.grantDirectory(directory);
  const restored = await reopen();
  assert.ok((await restored.directories()).some(item => item.id === grant.id));
  await restored.revokeDirectory(grant.id);
  assert.deepEqual(await restored.directories(), []);
  for (const id of [grant.id, "lds_deadbeef"]) {
    await assert.rejects(restored.startRun(owner, { input: "Read files", modelKey: "local:test", directoryScopeIds: [id] }), /directory scope is unavailable/);
  }
  assert.deepEqual(await restored.conversations(owner), [], "failed authorization must not create a conversation");
});

test("missing identity for enabled Memory fails before registering a usable Runtime and releases handles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-memory-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databases = new LocalRuntimeDatabaseRegistry();
  const factory = new LocalRuntimeFactory({ databasePath: join(root, "runtime.db"), skillPackageStoreRoot: join(root, "packages"), databases, models: modelPort() });
  await assert.rejects(factory.create({ id: "same-id", displayName: "Test", storageKey: "default", isDefault: true }, {
    customSkillDirectories: [], mcpServers: [], integrationEnvironment: { WEB_SEARCH_DISABLED: "1" }, memory: { enabled: true, settlementModelKey: "local:test" },
  }, join(root, "workspace"), join(root, "uploads")), /local_runtime_identity_required/);
  assert.deepEqual(databases.list(), []);
  assert.equal((await readdir(root)).includes("memory.db"), false);
  const database = new AppDatabase(join(root, "runtime.db"));
  await database.exec("CREATE TABLE bootstrap_probe (id TEXT PRIMARY KEY)");
  await database.close();
});

test("policy bootstrap failure releases the Runtime registry and SQLite for a later restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-policy-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillRoot = join(root, "skills"); await mkdir(skillRoot);
  const databases = new LocalRuntimeDatabaseRegistry();
  const options = { databasePath: join(root, "runtime.db"), skillPackageStoreRoot: join(root, "packages"), databases,
    models: modelPort(), environment: { AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: skillRoot } };
  const definition = { id: "same-id", displayName: "Test", storageKey: "default", isDefault: true };
  const config = { customSkillDirectories: [], mcpServers: [], integrationEnvironment: { WEB_SEARCH_DISABLED: "1" } };
  await assert.rejects(new LocalRuntimeFactory({ ...options, loadExecutionPolicy: async () => { throw new Error("invalid_policy"); } })
    .create(definition, config, join(root, "workspace"), join(root, "uploads")), /invalid_policy/);
  assert.deepEqual(databases.list(), []);
  const runtime = await new LocalRuntimeFactory(options).create(definition, config, join(root, "workspace"), join(root, "uploads"));
  assert.equal(databases.list().length, 1);
  await runtime.close?.(); await runtime.database.close();
  assert.deepEqual(databases.list(), []);
});

test("Memory database registries belong to the embedding host, including identical Runtime IDs", async () => {
  const first = new LocalRuntimeDatabaseRegistry(); const second = new LocalRuntimeDatabaseRegistry();
  const left = new AppDatabase(":memory:"); const right = new AppDatabase(":memory:");
  try {
    first.register("default", left); second.register("default", right);
    assert.deepEqual(first.list(), [left]); assert.deepEqual(second.list(), [right]);
    first.unregister("default", right);
    assert.deepEqual(first.list(), [left], "a stale handle must not unregister another instance");
    first.unregister("default", left);
    assert.deepEqual(first.list(), []); assert.deepEqual(second.list(), [right]);
  } finally { await left.close(); await right.close(); }
});

test("invalid models and empty owners are rejected before creating a conversation", async (t) => {
  const { runtime } = await fixture(t);
  for (const modelKey of ["", "local:missing", "cloud:test"]) {
    await assert.rejects(runtime.startRun(owner, { input: "Hello", modelKey }), /model_required|local_model_unavailable/);
  }
  await assert.rejects(runtime.startRun({ ownerUserId: "" }, { input: "Hello", modelKey: "local:test" }), /owner_user_id_required/);
  assert.deepEqual(await runtime.conversations(owner), []);
  await assert.rejects(runtime.events(owner, "unused", -1), /event_sequence_invalid/);
});

test("close refuses active work, remains usable after refusal, and is idempotent after settlement", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const base = greetingModel();
  const models = modelPort({ ...base, async complete(input, signal) {
    if (input.tools.some(tool => tool.name === "resolve_conversation_turn")) { entered(); await blocked; }
    return await base.complete(input, signal);
  } });
  const { runtime } = await fixture(t, models);
  try {
    const starting = runtime.startRun(owner, { input: "Hello", modelKey: "local:test" });
    await entering;
    await assert.rejects(runtime.close(), /runtime_active_runs_prevent_close/);
    assert.deepEqual(runtime.models(), ["local:test"]);
    release();
    const started = await starting;
    await settle(runtime, started.id);
    await Promise.all([runtime.close(), runtime.close()]);
    await runtime.close();
    assert.throws(() => runtime.models(), /local_runtime_closed/);
  } finally { release(); }
});

test("enabled Memory takes its stable local identity from the host without a device state file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-memory-identity-"));
  const skills = join(root, "skills"); await mkdir(skills);
  let lookups = 0;
  const factory = new LocalRuntimeFactory({
    databasePath: join(root, "runtime.db"), skillPackageStoreRoot: join(root, "packages"), models: modelPort(),
    identity: { async installationId() { lookups++; return "stable-installation"; } },
    environment: { AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: skills },
  });
  const definition = { id: "unpaired", displayName: "Local", storageKey: "default", isDefault: true };
  for (const settlementModelKey of [undefined, "cloud:test", "local:"]) {
    await assert.rejects(factory.create(definition, {
      customSkillDirectories: [], mcpServers: [], integrationEnvironment: { WEB_SEARCH_DISABLED: "1" },
      memory: { enabled: true, settlementModelKey },
    }, join(root, "workspace"), join(root, "uploads")), /memory_settlement_model_required|memory_settlement_model_must_be_local/);
  }
  assert.equal(lookups, 0, "invalid Memory configuration must not consult device identity");
  assert.equal((await readdir(root)).includes("memory.db"), false);
  const runtime = await factory.create(definition, {
    customSkillDirectories: [], mcpServers: [], integrationEnvironment: { WEB_SEARCH_DISABLED: "1" },
    memory: { enabled: true, settlementModelKey: "local:test" },
  }, join(root, "workspace"), join(root, "uploads"));
  try {
    assert.equal(lookups, 1);
    assert.equal(runtime.memory?.tenantId, "local-device:stable-installation");
    assert.equal((await readdir(root)).includes("memory.db"), true);
    assert.equal((await readdir(root)).includes("device-identity.json"), false);
  } finally { await runtime.close?.(); await runtime.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("Runtime storage keys must remain inside their configured roots", () => {
  const factory = new LocalRuntimeFactory({ databasePath: "/tmp/local-runtime/runtime.db", skillPackageStoreRoot: "/tmp/local-runtime/packages" });
  for (const storageKey of ["..", "../outside", "/tmp/absolute-outside", "."]) {
    const definition = { id: "child", displayName: "Child", storageKey, isDefault: false };
    assert.throws(() => factory.runtimeRootFor(definition), /runtime_storage_key_outside_data_root/);
    assert.throws(() => factory.runtimeUploadRootFor(definition, "/tmp/local-runtime/uploads"), /runtime_upload_storage_key_outside_root/);
  }
});
