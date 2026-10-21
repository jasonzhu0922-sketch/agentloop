import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase, RunService, SkillService } from "@zhujun/agentloop";
import { EncryptedLocalRuntimeSecretStore } from "../local-agent-runtime/src/persistence/encrypted-local-runtime-secret-store.ts";
import { LocalModelConfigurationStore } from "../local-agent-runtime/src/persistence/local-model-configuration-store.ts";
import { RouterService } from "../src/router/service/router-service.ts";
import { taskFromRequest } from "../src/router/api/task-submission.ts";
import { LocalRuntimeFactory } from "../local-agent-runtime/src/service/local-runtime-factory.ts";

test("local RunService rejects a Run without an explicit model key", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      requireExplicitModel: true,
      modelFactory: () => { throw new Error("model factory must not run without a model key"); },
    });
    await assert.rejects(runs.executeConversation("owner-1", "hello"), (error: unknown) =>
      (error as { code?: string; message?: string }).code === "BAD_REQUEST"
      && (error as { message?: string }).message === "model_required");
  } finally {
    database.close();
  }
});

test("cloud-only Local Runtime requires a model source and forwards a cloud selection through a tracked model Action", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-model-routing-"));
  const appRoot = new URL("../", import.meta.url).pathname;
  await mkdir(join(root, "skills"));
  await writeFile(join(root, "state.json"), JSON.stringify({ device: { id: "device-test", agentToken: "test-only-token" } }));
  const runtime = await new LocalRuntimeFactory({
    appRoot, routerUrl: "https://router.example.test", statePath: join(root, "state.json"),
    databasePath: join(root, "runtime.db"), workspaceRoot: join(root, "workspace"),
    skillPackageStoreRoot: join(root, "packages"), providerConfigPath: join(root, "unused-provider.json"),
    skillDirectoriesConfigPath: join(root, "unused-skills.json"),
    stepExecutionStrategyConfigPath: join(appRoot, "config", "step-execution-strategy.json"),
    environment: { AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: join(root, "skills") },
  }).create({ id: "runtime", displayName: "Runtime", storageKey: "default", isDefault: true }, {
    customSkillDirectories: [], mcpServers: [], integrationEnvironment: { WEB_SEARCH_DISABLED: "1" },
    modelConfiguration: { configured: true, reuseCloudModels: true, registryConfig: undefined, environment: {} },
  }, join(root, "workspace"), join(root, "uploads"));
  try {
    await assert.rejects(runtime.runs.executeConversation("owner", "hello", { modelKey: "deepseek-v4-flash-2" }), (error: unknown) =>
      (error as { code?: string; message?: string }).code === "MODEL_ERROR"
      && (error as { message?: string }).message?.includes("model_source_required") === true,
    );
    const invalid = await runtime.database.prepare("SELECT id FROM runs WHERE model_key = ? ORDER BY created_at DESC LIMIT 1").get("deepseek-v4-flash-2") as { id: string };
    const failure = (await runtime.runs.events("owner", invalid.id)).find((event) => event.type === "run.failed");
    assert.match(String(failure?.data.message), /model_source_required/);
    let requestedKey: string | undefined;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requestedKey = body.modelKey;
      // invocation.runId is a request correlation id. The durable Action is
      // owned by the enclosing persisted Run, so correlate through model_key.
      const actions = await runtime.database.prepare(`
        SELECT actions.id
        FROM runtime_actions actions
        JOIN runs ON runs.id = actions.run_id
        WHERE runs.model_key = ?
      `).all("cloud:deepseek-v4-flash-2");
      assert.equal(actions.length, 1, "the proxy call is covered by a durable model Action");
      return new Response(`${JSON.stringify({ type: "error", error: "test_provider_stop" })}\n`, { headers: { "content-type": "application/x-ndjson" } });
    });
    await assert.rejects(runtime.runs.executeConversation("owner", "hello", { modelKey: "cloud:deepseek-v4-flash-2" }), (error: unknown) =>
      (error as { code?: string }).code === "INTERNAL_ERROR",
    );
    assert.equal(requestedKey, "deepseek-v4-flash-2");
    const valid = await runtime.database.prepare("SELECT id FROM runs WHERE model_key = ? ORDER BY created_at DESC LIMIT 1").get("cloud:deepseek-v4-flash-2") as { id: string };
    const actions = await runtime.database.prepare("SELECT state, error_code FROM runtime_actions WHERE run_id = ?").all(valid.id) as Array<{ state: string; error_code: string | null }>;
    assert.ok(actions.some((action) => action.state === "failed" && action.error_code === "INTERNAL_ERROR"));
  } finally {
    runtime.database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("local model configuration persists metadata separately from encrypted credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-models-"));
  const database = new AppDatabase(join(root, "agentloop.db"));
  try {
    const store = new LocalModelConfigurationStore(database, new EncryptedLocalRuntimeSecretStore(join(root, "secrets")));
    await store.ready();
    await store.write({
      reuseCloudModels: true,
      providers: [{
        key: "my-provider", displayName: "My provider", baseUrl: "https://models.example.test/v1", apiKey: "private-api-key",
        models: [{ key: "my-provider.fast", displayName: "Fast", providerModel: "fast-v2" }],
      }],
    });

    const row = await database.prepare("SELECT configuration_json, secret_storage_key FROM local_model_configuration WHERE singleton = 1").get() as { configuration_json: string; secret_storage_key: string };
    assert.equal(row.configuration_json.includes("private-api-key"), false);
    assert.ok(row.secret_storage_key);
    const resolved = await store.resolve();
    assert.equal(resolved.reuseCloudModels, true);
    assert.equal(resolved.environment.LOCAL_MODEL_KEY_MY_PROVIDER, "private-api-key");
    const storedConfiguration = await store.read();
    assert.deepEqual(storedConfiguration.providers[0]?.models.map((model) => model.key), ["my-provider.fast"]);
    assert.equal("defaultModelKey" in storedConfiguration, false);
    assert.equal("defaultProvider" in storedConfiguration, false);
    const storedSecret = await readFile(join(root, "secrets", `${row.secret_storage_key}.json`), "utf8");
    assert.equal(storedSecret.includes("private-api-key"), false);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("task submission requires an explicitly selected model", async () => {
  const principal = { tenantId: "tenant-1", userId: "user-1", email: "user@example.test" } as const;
  await assert.rejects(
    taskFromRequest({ conversationId: "conversation-1", clientMessageId: "message-1", input: "hello" }, principal, undefined),
    (error: unknown) => (error as { statusCode?: number; message?: string }).statusCode === 409
      && (error as { message?: string }).message === "model_required: choose a model before sending",
  );
  await assert.rejects(
    taskFromRequest({ conversationId: "conversation-1", clientMessageId: "message-blank", input: "hello", requestedModelKey: "  " }, principal, undefined),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
  );

  const task = await taskFromRequest({
    conversationId: "conversation-1", clientMessageId: "message-2", input: "hello", requestedModelKey: "cloud:gpt-test",
  }, principal, undefined);
  assert.equal(task.requestedModelKey, "cloud:gpt-test");
});

test("cloud model reuse catalogs only Cloud Host models", async () => {
  const endpointCalls: string[] = [];
  const endpointSelections: Array<readonly unknown[]> = [];
  const router = new RouterService({
    store: {
      async runtimeEndpoints(...selection: unknown[]) {
        endpointSelections.push(selection);
        return [{ id: "cloud-1", endpoint: "https://cloud.test" }];
      },
    } as never,
    endpointFactory(endpoint) {
      endpointCalls.push(endpoint);
      return {
        async models() {
          return endpoint === "https://cloud.test" ? [{ key: "cloud:model", displayName: "Cloud model" }] : [];
        },
      } as never;
    },
  });

  assert.deepEqual(await router.cloudModels("tenant-1", "user-1"), [{ key: "cloud:model", displayName: "Cloud model" }]);
  assert.deepEqual(endpointCalls, ["https://cloud.test"]);
  assert.deepEqual(endpointSelections, [[]]);
});

test("cloud model invocation does not fail over after a Host has begun the model request", async () => {
  let invocations = 0;
  const router = new RouterService({
    store: { async runtimeEndpoints() { return [
      { id: "cloud-1", endpoint: "https://cloud-1.test" },
      { id: "cloud-2", endpoint: "https://cloud-2.test" },
    ]; } } as never,
    endpointFactory(endpoint) {
      return {
        async models() { return [{ key: "model-a", displayName: "Model A" }]; },
        async completeModelStream() {
          invocations += 1;
          throw new Error("provider_request_failed");
        },
      } as never;
    },
  });

  await assert.rejects(router.completeCloudModelStream("tenant-1", "user-1", "model-a", {} as never, async () => undefined), /provider_request_failed/);
  assert.equal(invocations, 1);
});

test("an empty configured model catalog keeps Runtime management available while rejecting model execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-empty-model-catalog-"));
  const appRoot = new URL("../", import.meta.url).pathname;
  await mkdir(join(root, "skills"));
  const runtime = await new LocalRuntimeFactory({
    appRoot, statePath: join(root, "state.json"), databasePath: join(root, "runtime.db"),
    workspaceRoot: join(root, "workspace"), skillPackageStoreRoot: join(root, "packages"),
    providerConfigPath: join(root, "must-not-load.json"), skillDirectoriesConfigPath: join(root, "unused-skills.json"),
    stepExecutionStrategyConfigPath: join(appRoot, "config", "step-execution-strategy.json"),
    environment: { AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: join(root, "skills") },
  }).create({ id: "empty", displayName: "Empty Runtime", storageKey: "default", isDefault: true }, {
    customSkillDirectories: [], mcpServers: [], integrationEnvironment: { WEB_SEARCH_DISABLED: "1" },
    modelConfiguration: { configured: true, reuseCloudModels: false, registryConfig: undefined, environment: {} },
  }, join(root, "workspace"), join(root, "uploads"));
  try {
    assert.deepEqual(runtime.modelKeys, []);
    await assert.rejects(runtime.runs.executeConversation("owner", "hello", { modelKey: "local:missing" }), /local_model_unavailable/);
    await assert.rejects(runtime.runs.executeConversation("owner", "hello", { modelKey: "cloud:missing" }), /cloud_model_reuse_disabled/);
  } finally {
    runtime.database.close();
    await rm(root, { recursive: true, force: true });
  }
});
