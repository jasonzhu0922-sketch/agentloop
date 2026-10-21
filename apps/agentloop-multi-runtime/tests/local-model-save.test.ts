import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase, SkillService, type ModelFactory } from "@zhujun/agentloop";
import { EncryptedLocalRuntimeSecretStore } from "../local-agent-runtime/src/persistence/encrypted-local-runtime-secret-store.ts";
import { LocalModelConfigurationStore, type LocalModelConfigurationInput } from "../local-agent-runtime/src/persistence/local-model-configuration-store.ts";
import { LocalAgentService } from "../local-agent-runtime/src/service/local-agent-service.ts";
import { LocalRuntimeFactory } from "../local-agent-runtime/src/service/local-runtime-factory.ts";
import { LocalRuntimeSupervisor } from "../local-agent-runtime/src/service/runtime-supervisor.ts";

const initial: LocalModelConfigurationInput = {
  reuseCloudModels: false,
  providers: [{ key: "provider", displayName: "Provider", baseUrl: "https://old.example.test/v1", apiKey: "old-test-secret",
    models: [{ key: "model", displayName: "Model", providerModel: "old-model", temperature: 0.2, maxAttempts: 1 }] }],
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "local-model-save-"));
  await mkdir(join(root, "skills"));
  await writeFile(join(root, "state.json"), JSON.stringify({ defaultRuntimeId: "default-runtime" }));
  await writeFile(join(root, "skills.json"), JSON.stringify({ schema: "agentloop.skillDirectories/v1", customSkillDirectories: [] }));
  const database = new AppDatabase(join(root, "supervisor.db"));
  const seed = new LocalModelConfigurationStore(database, new EncryptedLocalRuntimeSecretStore(join(root, "model-secrets")));
  await seed.ready();
  await seed.write(initial);
  database.close();
  const appRoot = new URL("../", import.meta.url).pathname;
  const options = {
    appRoot, statePath: join(root, "state.json"), databasePath: join(root, "runtime.db"),
    supervisorDatabasePath: join(root, "supervisor.db"), workspaceRoot: join(root, "workspace"),
    skillPackageStoreRoot: join(root, "packages"), providerConfigPath: join(root, "must-not-load.json"),
    skillDirectoriesConfigPath: join(root, "skills.json"),
    stepExecutionStrategyConfigPath: join(appRoot, "config", "step-execution-strategy.json"),
    environment: { AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: join(root, "skills") },
    integrationEnvironment: { WEB_SEARCH_DISABLED: "1" },
  };
  const service = await LocalAgentService.create(options);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await service.close(); } };
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  // Inspect the owning resources to prove that persistence leaves them intact.
  const { supervisor, modelConfigurations: store } = service as unknown as {
    supervisor: LocalRuntimeSupervisor; modelConfigurations: LocalModelConfigurationStore;
  };
  return { service, supervisor, store, options, close };
}

test("saving models preserves active Runtime resources and MCP sessions while new adapters use updated configuration", async (t) => {
  const factory = t.mock.method(LocalRuntimeFactory.prototype, "create");
  const skills = t.mock.method(SkillService.prototype, "syncSkillDirectories");
  const reload = t.mock.method(LocalRuntimeSupervisor.prototype, "reloadRunningInstances");
  const lock = t.mock.method(LocalRuntimeSupervisor.prototype, "withDeviceReconfiguration");
  let mcpRequests = 0;
  const requests: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (String(url).includes("mcp.example.test")) {
      mcpRequests += 1;
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = body.method === "initialize"
        ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "test", version: "1" } }
        : { tools: [{ name: "lookup", inputSchema: { type: "object" } }] };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }
    requests.push({ url: String(url), authorization: new Headers(init.headers).get("authorization")!, body });
    if (requests.length === 1) { entered.resolve(); await release.promise; }
    return Response.json({ status: "completed", output_text: "ok", output: [] });
  });
  const { service, supervisor } = await fixture(t);
  const child = await supervisor.create("MCP Runtime", { mcpServers: [{
    key: "lookup", displayName: "Lookup", transport: "http", url: "https://mcp.example.test/mcp", auth: { kind: "none" },
  }] });
  assert.ok(mcpRequests > 0, "the Runtime established a real MCP HTTP session through the mocked transport");
  const runtimes = [supervisor.runtime("default-runtime"), supervisor.runtime(child.id)];
  const summaries = await supervisor.list();
  const calls = { factory: factory.mock.callCount(), skills: skills.mock.callCount(), mcp: mcpRequests };
  const modelFactory = (runtimes[0]!.runs as unknown as { modelFactory: ModelFactory }).modelFactory;
  const oldAdapter = modelFactory(undefined, "local:model");
  const invocation = { runId: "in-flight", phase: "execution" as const, systemPrompt: "Test", messages: [], tools: [] };
  await supervisor.admitRun("default-runtime", async () => ({ runId: invocation.runId, value: undefined }));
  const pending = oldAdapter.complete(invocation);
  await entered.promise;
  await service.updateLocalModelConfiguration({ reuseCloudModels: true, providers: [{
    ...initial.providers[0]!, baseUrl: "https://new.example.test/v1", apiKey: "new-test-secret",
    models: [{ key: "model", displayName: "Updated", providerModel: "new-model", temperature: 0.8, maxAttempts: 1 },
      { key: "extra", displayName: "Extra", providerModel: "extra-model" }],
  }] });
  assert.equal(factory.mock.callCount(), calls.factory);
  assert.equal(skills.mock.callCount(), calls.skills);
  assert.equal(mcpRequests, calls.mcp);
  assert.equal(reload.mock.callCount(), 0);
  assert.equal(lock.mock.callCount(), 0);
  for (const runtime of runtimes) {
    assert.equal(supervisor.runtime(runtime.id), runtime);
    assert.deepEqual(runtime.modelKeys, ["local:extra", "local:model"]);
    await runtime.database.prepare("SELECT 1").get();
  }
  assert.equal(runtimes[0]!.activeRunIds.has(invocation.runId), true);
  assert.deepEqual((await supervisor.list()).map(({ activeRunCount, ...row }) => row), summaries.map(({ activeRunCount, ...row }) => row));
  assert.ok(modelFactory(undefined, "cloud:shared-model"));
  release.resolve();
  await pending;
  await oldAdapter.complete(invocation);
  await modelFactory(undefined, "local:model").complete(invocation);
  assert.deepEqual(requests.map(({ url, authorization, body }) => [url, authorization, body.model, body.temperature]), [
    ["https://old.example.test/v1/responses", "Bearer old-test-secret", "old-model", 0.2],
    ["https://old.example.test/v1/responses", "Bearer old-test-secret", "old-model", 0.2],
    ["https://new.example.test/v1/responses", "Bearer new-test-secret", "new-model", 0.8],
  ]);
  await service.updateLocalModelConfiguration({ reuseCloudModels: false, providers: [] });
  assert.deepEqual(runtimes[0]!.modelKeys, []);
  assert.throws(() => modelFactory(undefined, "cloud:shared-model"), /cloud_model_reuse_disabled/);
  assert.throws(() => modelFactory(undefined, "local:model"), /local_model_unavailable/);
  assert.equal(factory.mock.callCount(), calls.factory);
  assert.equal(mcpRequests, calls.mcp);
  await supervisor.runSettled("default-runtime", invocation.runId);
});

test("model saves serialize credential-preserving edits without blocking Run admission, and recover after rejection", async (t) => {
  const { service, supervisor, store } = await fixture(t);
  const saved = await store.read();
  const previous = store.current();
  await assert.rejects(service.updateLocalModelConfiguration({ ...saved, providers: [{
    ...saved.providers[0]!, models: [{ ...saved.providers[0]!.models[0]!, temperature: 3 }],
  }] }));
  assert.equal(store.current(), previous);
  assert.deepEqual(await store.read(), saved);
  const writeSecret = EncryptedLocalRuntimeSecretStore.prototype.write;
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let writes = 0;
  t.mock.method(EncryptedLocalRuntimeSecretStore.prototype, "write", async function (this: EncryptedLocalRuntimeSecretStore, values: Readonly<Record<string, string>>) {
    if (++writes === 1) { entered.resolve(); await release.promise; }
    return await writeSecret.call(this, values);
  });
  const first = service.updateLocalModelConfiguration({ ...saved, providers: [{ ...saved.providers[0]!, apiKey: "rotated-test-secret" }] });
  await entered.promise;
  const second = service.updateLocalModelConfiguration({ ...saved, providers: [{ ...saved.providers[0]!, displayName: "Renamed" }] });
  await supervisor.admitRun("default-runtime", async () => ({ runId: "during-save", value: undefined }));
  assert.equal(writes, 1, "the second edit waits for the credential rotation");
  release.resolve();
  await Promise.all([first, second]);
  assert.equal((await store.read()).providers[0]!.displayName, "Renamed");
  assert.equal(store.current().environment.LOCAL_MODEL_KEY_PROVIDER, "rotated-test-secret");
  assert.equal((await store.resolve()).environment.LOCAL_MODEL_KEY_PROVIDER, "rotated-test-secret");
  await supervisor.runSettled("default-runtime", "during-save");
});

test("failed model credential cleanup restores persisted and published configuration without rebuilding Runtime", async (t) => {
  const { service, supervisor, store, options, close } = await fixture(t);
  const runtime = supervisor.runtime("default-runtime");
  const saved = await store.read();
  const previous = await store.snapshot();
  const removeSecret = EncryptedLocalRuntimeSecretStore.prototype.remove;
  let removals = 0;
  t.mock.method(EncryptedLocalRuntimeSecretStore.prototype, "remove", async function (this: EncryptedLocalRuntimeSecretStore, key: string) {
    if (++removals === 1) throw new Error("test_cleanup_failure");
    return await removeSecret.call(this, key);
  });
  await assert.rejects(service.updateLocalModelConfiguration({ ...saved, providers: [{ ...saved.providers[0]!, apiKey: "failed-test-secret" }] }), /test_cleanup_failure/);
  assert.deepEqual(await store.snapshot(), previous);
  assert.equal(store.current().environment.LOCAL_MODEL_KEY_PROVIDER, "old-test-secret");
  assert.equal(supervisor.runtime(runtime.id), runtime);
  await service.updateLocalModelConfiguration({ ...saved, providers: [{ ...saved.providers[0]!, apiKey: "saved-test-secret" }] });
  // A fresh Agent process resolves the same durable configuration without a reload at save time.
  const expected = await service.localModelConfiguration();
  await close();
  const reopened = await LocalAgentService.create(options);
  try {
    assert.deepEqual(await reopened.localModelConfiguration(), expected);
    const restored = (reopened as unknown as { modelConfigurations: LocalModelConfigurationStore }).modelConfigurations.current();
    assert.equal(restored.environment.LOCAL_MODEL_KEY_PROVIDER, "saved-test-secret");
  } finally { await reopened.close(); }
});
