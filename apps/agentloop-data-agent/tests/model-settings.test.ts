import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelSettings } from "../src/model-settings.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "data-agent-model-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "models.json");
  const config = {
    defaultModelKey: "ds-pro",
    providers: { bailian: { kind: "alibaba", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "TEST_API_KEY",
      defaultModel: "deepseek-v4-pro", contextWindowTokens: 128000, maxOutputTokens: 8192, maxAttempts: 1 } },
    models: {
      "ds-pro": { providerKey: "bailian", providerModel: "deepseek-v4-pro", displayName: "Pro", reasoning: "none", providerOptions: { parallelToolCalls: false } },
      "ds-flash": { providerKey: "bailian", providerModel: "deepseek-v4.1-flash", displayName: "Flash", reasoning: "none" },
    },
  };
  await writeFile(path, JSON.stringify(config));
  const settings = await new ModelSettings(path, { TEST_API_KEY: "private-model-key" }).load();
  return { path, config, settings, input: () => {
    const snapshot = settings.publicConfig();
    return { ...snapshot.models.find(m => m.key === "ds-pro")!, revision: snapshot.revision };
  } };
}

test("editing and reloading a hosted model preserves its native provider and SDK options", async t => {
  const { path, config, settings, input } = await fixture(t);
  assert.equal(JSON.stringify(settings.publicConfig()).includes("private-model-key"), false);
  await settings.save({ ...input(), displayName: "Edited", reasoning: "medium" });
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(saved.models["ds-flash"], config.models["ds-flash"]);
  assert.deepEqual(saved.providers.bailian, config.providers.bailian);
  const reloaded = await new ModelSettings(path, { TEST_API_KEY: "private-model-key" }).load();
  const model = reloaded.publicConfig().models.find(m => m.key === "ds-pro")!;
  assert.equal(model.kind, "alibaba");
  assert.equal(model.reasoning, "medium");
  assert.deepEqual(model.providerOptions, { parallelToolCalls: false });
  assert.equal(Object.hasOwn(saved.providers[saved.models["ds-pro"].providerKey], "enableThinking"), false);
  let body: any;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "OK" } }] });
  });
  await reloaded.registry.create("ds-pro").complete({ runId: "saved-native-settings", phase: "execution", systemPrompt: "Test", messages: [], tools: [] });
  assert.equal(body.enable_thinking, true);
  assert.ok(body.thinking_budget > 0);
  await reloaded.save({ ...model, revision: reloaded.publicConfig().revision, reasoning: "none" });
  await reloaded.registry.create("ds-pro").complete({ runId: "saved-native-off", phase: "execution", systemPrompt: "Test", messages: [], tools: [] });
  assert.equal(body.enable_thinking, false);
  assert.equal(body.thinking_budget, undefined);
});

test("the settings boundary rejects legacy fields and SDK-incompatible protocol without writing", async t => {
  const { path, settings, input } = await fixture(t);
  const before = await readFile(path, "utf8");
  for (const patch of [{ enable_thinking: false }, { enableThinking: false }, { protocol: "responses" }, { reasoning: "invented" }]) {
    await assert.rejects(settings.save({ ...input(), ...patch }));
    assert.equal(await readFile(path, "utf8"), before);
  }
});

test("changing service identity requires new credentials and retains the requested SDK kind", async t => {
  const { settings, input } = await fixture(t);
  await assert.rejects(settings.save({ ...input(), baseUrl: "https://another.example/v1" }), /API Key/);
  await settings.save({ ...input(), kind: "deepseek", baseUrl: "https://api.deepseek.com/beta", providerModel: "deepseek-chat", providerOptions: {}, apiKey: "new-private-key" });
  assert.equal(settings.publicConfig().models.find(m => m.key === "ds-pro")!.kind, "deepseek");
  assert.equal(JSON.stringify(settings.publicConfig()).includes("new-private-key"), false);
});

test("external configuration edits cannot be overwritten by a stale settings snapshot", async t => {
  const { path, config, settings, input } = await fixture(t);
  const external = JSON.stringify({ ...config, defaultModelKey: "ds-flash" });
  await writeFile(path, external);
  await assert.rejects(settings.save(input()), /配置文件已更新/);
  assert.equal(await readFile(path, "utf8"), external);
});

test("Data Agent exposes and applies its fixed runtime reliability policy without changing the exact provider model", async t => {
  const { path, settings } = await fixture(t);
  const publicConfig = settings.publicConfig();
  assert.deepEqual(publicConfig.runtimePolicy, {
    source: "application-policy", timeoutCapMs: 60_000, maxAttemptsFloor: 2, toolChoiceMode: "named-as-required",
    description: "Data Agent 固定使用指定工具必选策略、至少两次模型尝试，并限制单次模型请求超时；配置中更严格的值仍会保留。",
  });
  const runtime = settings.registry.create("ds-pro") as any;
  assert.equal(runtime.model, "deepseek-v4-pro");
  assert.equal(runtime.timeoutMs, 60_000);
  assert.equal(runtime.maxAttempts, 2);
  assert.equal(runtime.toolChoiceMode, "named-as-required");

  const strict = JSON.parse(await readFile(path, "utf8"));
  strict.providers.bailian.timeoutMs = 30_000;
  strict.providers.bailian.maxAttempts = 4;
  await writeFile(path, JSON.stringify(strict));
  const strictSettings = await new ModelSettings(path, { TEST_API_KEY: "private-model-key" }).load();
  const strictRuntime = strictSettings.registry.create("ds-pro") as any;
  assert.equal(strictRuntime.timeoutMs, 30_000);
  assert.equal(strictRuntime.maxAttempts, 4);
  assert.equal(strictRuntime.toolChoiceMode, "named-as-required");
});
