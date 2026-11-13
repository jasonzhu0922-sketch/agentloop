import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { createLocalRuntimeManager, EncryptedLocalRuntimeSecretStore, type LocalModelConfigurationInput } from "@zhujun/agentloop-local-runtime";
import { fixtureProvider } from "./fixtures/http-model.ts";
import { modelPort } from "./fixtures/models.ts";

const credential = "fixture-only-not-a-real-provider-key";
function configuration(baseUrl: string, protocol: "responses" | "chat-completions" = "responses"): LocalModelConfigurationInput {
  return { reuseCloudModels: false, providers: [{ key: "fixture", displayName: "Fixture", baseUrl, apiKey: credential,
    models: [{ key: "reasoner", displayName: "Reasoner", providerModel: "upstream-name", protocol, contextWindowTokens: 128000, maxOutputTokens: 8192, maxAttempts: 1, timeoutMs: 5000 }] }] };
}
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "local-model-settings-")); const skills = join(root, "skills"); await mkdir(skills);
  const secrets = new EncryptedLocalRuntimeSecretStore(join(root, "vault"));
  const options = { dataDirectory: root, defaultRuntimeId: "default", bundledSkillDirectories: [skills], modelSecrets: secrets };
  let manager = await createLocalRuntimeManager(options);
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { root, options, secrets, manager, reopen: async () => { await manager.close(); manager = await createLocalRuntimeManager(options); return manager; } };
}
async function settle(manager: Awaited<ReturnType<typeof createLocalRuntimeManager>>, id: string) {
  for (let count = 0; count < 500; count++) {
    const run = await manager.runtime("default").getRun({ ownerUserId: "alice" }, id);
    if (run.status !== "running") { await setTimeout(10); return run; }
    await setTimeout(10);
  }
  throw new Error("fixture_run_not_settled");
}

for (const protocol of ["responses", "chat-completions"] as const) test(`public model settings execute ${protocol}, preserve credentials and survive reopen`, async t => {
  const fixture = await fixtureProvider(); t.after(() => fixture.close());
  const { manager, root, reopen } = await setup(t); const view = manager.runtime("default");
  const initial = await manager.modelConfiguration(); assert.equal(initial.editable, true); assert.deepEqual(await view.models(), []);
  const input = configuration(fixture.baseUrl, protocol);
  const stored = await manager.configureModels(input, initial.revision);
  assert.equal(JSON.stringify(stored).includes(credential), false); assert.equal(stored.configuration.providers[0]?.credentialConfigured, true);
  assert.deepEqual(await view.models(), ["local:reasoner"]);
  const run = await view.startRun({ ownerUserId: "alice" }, { input: "你好", requestId: "configured", modelKey: "local:reasoner" });
  const done = await settle(manager, run.id); assert.equal(done.status, "completed", JSON.stringify({ done, events: done.status === "failed" ? await view.events({ ownerUserId: "alice" }, run.id) : [] })); assert.match(done.output!, /本机 Runtime/);
  assert.ok(fixture.calls.length >= 2); assert.equal(fixture.calls[0]?.authorization, `Bearer ${credential}`); assert.equal(fixture.calls[0]?.body.model, "upstream-name");
  assert.equal(fixture.calls[0]?.path, protocol === "responses" ? "/v1/responses" : "/v1/chat/completions");
  const preserved = await manager.configureModels(stored.configuration, stored.revision); assert.notEqual(preserved.revision, stored.revision);
  const restored = await reopen(); assert.deepEqual(await restored.runtime("default").models(), ["local:reasoner"]);
  const next = await restored.runtime("default").startRun({ ownerUserId: "alice" }, { input: "你好", requestId: "reopened", modelKey: "local:reasoner" });
  assert.equal((await settle(restored, next.id)).status, "completed");
  // Inspect actual persisted files, including SQLite and diagnostics, not a mock serializer.
  async function scan(path: string): Promise<void> { for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name); if (entry.isDirectory()) await scan(file); else assert.equal((await readFile(file)).includes(Buffer.from(credential)), false, file);
  } }
  await scan(root);
});

test("serialized settings reject stale edits and a moved endpoint cannot reuse an old key", async t => {
  const { manager } = await setup(t); const input = configuration("https://provider.example/v1"); const initial = await manager.modelConfiguration();
  const results = await Promise.allSettled([manager.configureModels(input, initial.revision), manager.configureModels(input, initial.revision)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(String((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason), /model_configuration_stale/);
  const before = await manager.modelConfiguration();
  const moved = { ...before.configuration, providers: before.configuration.providers.map(provider => ({ ...provider, baseUrl: "https://other.example/v1" })) };
  await assert.rejects(manager.configureModels(moved, before.revision), /local_model_api_key_required/);
  assert.deepEqual(await manager.modelConfiguration(), before);
  await assert.rejects(manager.configureModels({ ...input, reuseCloudModels: true }, before.revision), /model_configuration_invalid/);
  const removed = await manager.configureModels({ reuseCloudModels: false, providers: [] }, before.revision);
  assert.deepEqual(removed.configuration.providers, []); assert.deepEqual(await manager.runtime("default").models(), []);
});

test("active Run blocks model changes without discarding the saved configuration", async t => {
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const blocked = new Promise<void>(resolve => { release = resolve; });
  const provider = await fixtureProvider(async () => { entered(); await blocked; });
  const { manager } = await setup(t); t.after(() => provider.close());
  const initial = await manager.modelConfiguration(); const saved = await manager.configureModels(configuration(provider.baseUrl), initial.revision);
  const run = await manager.runtime("default").startRun({ ownerUserId: "alice" }, { requestId: "blocked", input: "你好", modelKey: "local:reasoner" });
  try {
    await started;
    await assert.rejects(manager.configureModels({ reuseCloudModels: false, providers: [] }, saved.revision), /runtime_active_runs_prevent_reconfiguration/);
    await assert.rejects(manager.testModel(saved.configuration, saved.revision, 'reasoner'), /runtime_active_runs_prevent_reconfiguration/);
    assert.equal((await manager.modelConfiguration()).revision, saved.revision);
  } finally { release(); await settle(manager, run.id); }
});

test("injected host models are explicitly read-only rather than silently ignoring saved models", async t => {
  const { root, options } = await setup(t);
  const injected = await createLocalRuntimeManager({ ...options, dataDirectory: join(root, "injected"), models: modelPort() });
  try { const settings = await injected.modelConfiguration(); assert.equal(settings.editable, false); await assert.rejects(injected.configureModels(configuration("https://example.test/v1"), settings.revision), /model_configuration_read_only/); }
  finally { await injected.close(); }
});

test("missing vault key never silently generates a new key for existing ciphertext", async t => {
  const root = await mkdtemp(join(tmpdir(), "model-vault-missing-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EncryptedLocalRuntimeSecretStore(root); const reference = await store.write({ TEST_KEY: credential });
  const encrypted = await readFile(join(root, `${reference}.json`)); await unlink(join(root, "master.key"));
  const reopened = new EncryptedLocalRuntimeSecretStore(root);
  await assert.rejects(reopened.read(reference), /master_key_missing/);
  await assert.rejects(reopened.write({ TEST_KEY: "replacement-fixture" }), /master_key_missing/);
  assert.deepEqual(await readFile(join(root, `${reference}.json`)), encrypted); assert.equal((await readdir(root)).includes("master.key"), false);
});

test("a model profile awaiting replacement credentials stays visible and cannot be used until repaired", async t => {
  const { manager, root, reopen } = await setup(t);
  const initial = await manager.modelConfiguration();
  await manager.configureModels(configuration("https://provider.example/v1"), initial.revision);
  const database = new DatabaseSync(join(root, "supervisor.db"));
  database.prepare("UPDATE local_model_configuration SET secret_storage_key = NULL WHERE singleton = 1").run();
  database.close();
  const recovered = await reopen();
  const pending = await recovered.modelConfiguration();
  assert.equal(pending.configuration.providers[0]?.credentialConfigured, false);
  assert.equal(pending.configuration.providers[0]?.models[0]?.key, "reasoner");
  assert.deepEqual(await recovered.runtime("default").models(), []);
  const restored = await recovered.configureModels(configuration("https://provider.example/v1"), pending.revision);
  assert.equal(restored.configuration.providers[0]?.credentialConfigured, true);
  assert.deepEqual(await recovered.runtime("default").models(), ["local:reasoner"]);
});

test("a SQLite write failure keeps the previous catalog and removes only the uncommitted credential", async t => {
  const { manager, secrets, root } = await setup(t); const initial = await manager.modelConfiguration();
  const saved = await manager.configureModels(configuration("https://old.example/v1"), initial.revision);
  const before = await secrets.listKeys();
  const database = new DatabaseSync(join(root, "supervisor.db"));
  database.exec("CREATE TRIGGER reject_model_write BEFORE INSERT ON local_model_configuration BEGIN SELECT RAISE(ABORT, 'fixture_write_failure'); END");
  try { await assert.rejects(manager.configureModels(configuration("https://new.example/v1"), saved.revision), /fixture_write_failure/); }
  finally { database.exec("DROP TRIGGER reject_model_write"); database.close(); }
  assert.deepEqual(await manager.modelConfiguration(), saved); assert.deepEqual(await secrets.listKeys(), before);
});

test("post-commit cleanup failure is reported without restoring a potentially deleted old credential", async t => {
  const { manager, secrets } = await setup(t); const initial = await manager.modelConfiguration();
  const saved = await manager.configureModels(configuration("https://old.example/v1"), initial.revision);
  const original = secrets.remove.bind(secrets);
  const cleanup = t.mock.method(secrets, "remove", async reference => { await original(reference); throw new Error("fixture_cleanup_after_delete"); });
  const updated = await manager.configureModels(configuration("https://new.example/v1"), saved.revision); cleanup.mock.restore();
  assert.equal(updated.credentialCleanupPending, true); assert.equal(updated.configuration.providers[0]?.baseUrl, "https://new.example/v1");
  assert.equal((await manager.modelConfiguration()).revision, updated.revision);
  assert.deepEqual(await manager.runtime("default").models(), ["local:reasoner"]);
  assert.equal((await secrets.listKeys()).length, 1);
});

test('draft probes reuse the saved credential without persisting edits or changing revision', async t => {
  const { manager, secrets } = await setup(t);
  const initial = await manager.modelConfiguration();
  const saved = await manager.configureModels(configuration('https://probe.example/v1', 'chat-completions'), initial.revision);
  const vaultBefore = await secrets.listKeys(); let sent: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${credential}`);
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] }), { headers: { 'content-type': 'application/json' } });
  });
  const draft = structuredClone(saved.configuration);
  (draft.providers[0]!.models[0] as any).reasoning = 'medium';
  (draft.providers[0]!.models[0] as any).providerModel = 'edited-upstream';
  const result = await manager.testModel(draft, saved.revision, 'reasoner');
  assert.equal(result.ok, true); assert.equal(sent.model, 'edited-upstream'); assert.equal(sent.reasoning_effort, 'medium');
  assert.equal(sent.max_tokens, 8192, 'a probe must retain the configured generation budget');
  assert.deepEqual(await manager.modelConfiguration(), saved); assert.deepEqual(await secrets.listKeys(), vaultBefore);
  await assert.rejects(manager.testModel(draft, initial.revision, 'reasoner'), /model_configuration_stale/);
  const moved = { ...draft, providers: [{ ...draft.providers[0]!, baseUrl: 'https://different.example/v1' }] };
  await assert.rejects(manager.testModel(moved, saved.revision, 'reasoner'), /local_model_api_key_required/);
  assert.deepEqual(await manager.modelConfiguration(), saved);
});

test('failed draft probes preserve a bounded provider reason and redact the effective key', async t => {
  const { manager } = await setup(t); const initial = await manager.modelConfiguration();
  const input = configuration('https://probe.example/v1', 'chat-completions');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: `invalid model; reflected ${credential}` } }), { status: 400 }));
  const result = await manager.testModel(input, initial.revision, 'reasoner');
  assert.equal(result.ok, false); assert.match(result.message, /HTTP 400/); assert.match(result.message, /invalid model/); assert.doesNotMatch(result.message, new RegExp(credential));
  assert.deepEqual(await manager.modelConfiguration(), initial);
});

test('native provider kind, standard reasoning and SDK extensions survive persistence and reopening', async t => {
  const { manager, reopen } = await setup(t); const initial = await manager.modelConfiguration();
  const input = { reuseCloudModels: false, providers: [{ key: 'bailian', displayName: '百炼', kind: 'alibaba' as const, baseUrl: 'https://example.test/compatible-mode/v1', apiKey: credential,
    models: [{ key: 'qwen', displayName: 'Qwen', providerModel: 'qwen3-max', reasoning: 'medium' as const, providerOptions: { thinkingBudget: 2048 } }] }] };
  const saved = await manager.configureModels(input, initial.revision);
  assert.equal(saved.configuration.providers[0]?.kind, 'alibaba');
  const restored = await reopen(); assert.deepEqual(await restored.modelConfiguration(), saved);
  assert.equal(JSON.stringify(saved).includes(credential), false);
});

test('SiliconFlow preset persists independently of model name and sends its documented thinking switch', async t => {
  const { manager, reopen } = await setup(t); const initial = await manager.modelConfiguration();
  const input: LocalModelConfigurationInput = { reuseCloudModels: false, providers: [{
    key: 'siliconflow', displayName: '硅基流动', preset: 'siliconflow', kind: 'openai-compatible',
    baseUrl: 'https://proxy.example/v1', apiKey: credential,
    models: [{ key: 'hosted-deepseek', displayName: 'DeepSeek', providerModel: 'deepseek-ai/DeepSeek-V4-Flash', enableThinking: false }],
  }] };
  const requests: { url: string; body: any }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] }), { headers: { 'content-type': 'application/json' } });
  });
  assert.equal((await manager.testModel(input, initial.revision, 'hosted-deepseek')).ok, true);
  assert.equal(requests[0]?.url, 'https://proxy.example/v1/chat/completions');
  assert.equal(requests[0]?.body.enable_thinking, false);
  assert.equal(requests[0]?.body.reasoning_effort, undefined);
  assert.equal(requests[0]?.body.thinking, undefined);
  const saved = await manager.configureModels(input, initial.revision);
  const restored = await reopen(); assert.deepEqual(await restored.modelConfiguration(), saved);
  assert.equal((await restored.testModel(saved.configuration, saved.revision, 'hosted-deepseek')).ok, true);
  assert.equal(requests[1]?.url, requests[0]?.url);
  const moved = { ...saved.configuration, providers: saved.configuration.providers.map(provider => ({ ...provider, baseUrl: 'https://api.siliconflow.cn/v1' })) };
  await assert.rejects(restored.configureModels(moved, saved.revision), /api_key_required/);
  assert.deepEqual(await restored.modelConfiguration(), saved);
});

test('a platform preset cannot claim a different SDK driver', async t => {
  const { manager } = await setup(t); const initial = await manager.modelConfiguration();
  const input = configuration('https://example.test/v1', 'chat-completions');
  const invalid = { ...input, providers: input.providers.map(provider => ({ ...provider, preset: 'siliconflow' as const, kind: 'deepseek' as const })) };
  await assert.rejects(manager.configureModels(invalid, initial.revision), /service_driver_mismatch/);
  assert.deepEqual(await manager.modelConfiguration(), initial);
});
