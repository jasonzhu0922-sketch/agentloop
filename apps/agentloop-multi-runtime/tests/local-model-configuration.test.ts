import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase, LlmProviderRegistry } from "@zhujun/agentloop";
import { EncryptedLocalRuntimeSecretStore } from "../local-agent-runtime/src/persistence/encrypted-local-runtime-secret-store.ts";
import { LocalModelConfigurationStore, type LocalModelConfigurationInput } from "../local-agent-runtime/src/persistence/local-model-configuration-store.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "local-model-json-"));
  const database = new AppDatabase(join(root, "agent.db"));
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const store = new LocalModelConfigurationStore(database, new EncryptedLocalRuntimeSecretStore(join(root, "secrets")));
  await store.ready();
  return { store, database };
}

const connection = { key: "test-provider", displayName: "Provider", baseUrl: "https://models.example.test/v1", apiKey: "test-only-secret" };
const responses = { key: "reasoner", displayName: "Reasoner", providerModel: "upstream-reasoner", protocol: "responses" as const,
  contextWindowTokens: 64000, maxOutputTokens: 4096, reasoningEffort: "high" as const, reasoningSummary: "auto" as const,
  reasoningEncryptedContent: true, temperature: 0, topP: 0.8, timeoutMs: 30000, maxAttempts: 1, retryDelayMs: 0 };
const chat = { key: "chat", displayName: "Chat", providerModel: "upstream-chat", protocol: "chat-completions" as const,
  thinkingMode: "enabled" as const, thinkingEffort: "medium" as const, planningThinkingMode: "disabled" as const,
  chatTemplateKwargs: { enable_thinking: true }, temperature: 0.7, topP: 0.9 };

test("Provider-only JSON persists without inventing an executable model", async (t) => {
  const { store } = await fixture(t);
  await store.write({ reuseCloudModels: false, providers: [{ ...connection, models: [] }] });
  assert.deepEqual((await store.read()).providers[0]?.models, []);
  assert.equal((await store.resolve()).registryConfig, undefined);
  assert.equal((await store.resolve()).configured, true);
  const saved = await store.read();
  await store.write({ ...saved, providers: [...saved.providers, { ...connection, key: "second-provider", models: [responses] }] });
  const resolved = await store.resolve();
  const registry = LlmProviderRegistry.fromConfigObject(resolved.registryConfig, resolved.environment);
  assert.deepEqual(registry.modelKeys(), ["reasoner"]);
});

test("model JSON survives save, redacted reload, and credential-preserving edit into both protocol payloads", async (t) => {
  const { store, database } = await fixture(t);
  await store.write({ reuseCloudModels: false, providers: [{ ...connection, models: [responses, chat] }] });
  const saved = await store.read();
  assert.equal(saved.providers[0]?.apiKey, undefined);
  assert.equal(saved.providers[0]?.credentialConfigured, true);
  assert.deepEqual(saved.providers[0]?.models, [responses, chat]);
  await store.write({ ...saved, providers: [{ ...saved.providers[0]!, displayName: "Renamed" }] });
  const row = await database.prepare("SELECT configuration_json FROM local_model_configuration").get() as { configuration_json: string };
  assert.equal(row.configuration_json.includes(connection.apiKey), false);
  const resolved = await store.resolve();
  const registry = LlmProviderRegistry.fromConfigObject(resolved.registryConfig, resolved.environment);
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${connection.apiKey}`);
    return new Response(JSON.stringify(String(url).endsWith("/responses")
      ? { status: "completed", output_text: "ok", output: [] }
      : { choices: [{ finish_reason: "stop", message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } });
  });
  for (const key of ["reasoner", "chat"]) {
    await registry.create(key).complete({ runId: key, phase: "execution", systemPrompt: "Test", messages: [], tools: [] });
  }
  assert.equal(requests[0]?.url, `${connection.baseUrl}/responses`);
  assert.deepEqual(requests[0]?.body.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(requests[0]?.body.include, ["reasoning.encrypted_content"]);
  assert.equal(requests[0]?.body.temperature, 0);
  assert.equal(requests[0]?.body.top_p, 0.8);
  assert.equal(requests[0]?.body.max_output_tokens, 4096);
  assert.equal(registry.create("reasoner").completeTimeoutMs, 30000);
  assert.equal(requests[1]?.url, `${connection.baseUrl}/chat/completions`);
  assert.deepEqual(requests[1]?.body.thinking, { type: "enabled" });
  assert.equal(requests[1]?.body.reasoning_effort, "medium");
  assert.deepEqual(requests[1]?.body.chat_template_kwargs, { enable_thinking: true });
  assert.equal(requests[1]?.body.temperature, 0.7);
  assert.equal(requests[1]?.body.top_p, 0.9);
  assert.equal(requests[1]?.body.reasoning, undefined, "Responses model options do not leak to sibling models");
});

test("invalid JSON model declarations fail before changing saved metadata or credentials", async (t) => {
  const { store } = await fixture(t);
  await store.write({ reuseCloudModels: false, providers: [{ ...connection, models: [responses, chat] }] });
  const previous = await store.snapshot();
  const invalidModels = [
    { ...responses, temperature: 3 }, { ...responses, topP: -0.1 }, { ...responses, topP: null },
    { ...responses, protocol: "chat-completions" }, { ...responses, maxOutputTokens: 64000 },
    { ...responses, contextWindowTokens: 100 }, { ...responses, timeoutMs: 0 },
    { ...responses, maxAttempts: 6 }, { ...responses, maxOutputToken: 2048 },
    { ...chat, thinkingMode: "disabled" }, { ...responses, protocol: "unknown" },
  ];
  for (const model of invalidModels) {
    await assert.rejects(store.write({ reuseCloudModels: false, providers: [{ ...connection, models: [model] }] } as LocalModelConfigurationInput));
    assert.deepEqual(await store.snapshot(), previous);
  }
  await assert.rejects(store.write({ reuseCloudModels: false, providers: [{ ...connection, models: [responses, responses] }] }));
  const saved = await store.read();
  await assert.rejects(store.write({ ...saved, providers: [{ ...saved.providers[0]!, baseUrl: "https://different.example.test/v1" }] }), /local_model_api_key_required/);
  await assert.rejects(store.write({ ...saved, providers: [{ ...saved.providers[0]!, key: "renamed-provider" }] }), /local_model_api_key_required/);
  assert.deepEqual(await store.snapshot(), previous);
  assert.equal((await store.resolve()).environment.LOCAL_MODEL_KEY_TEST_PROVIDER, connection.apiKey);
});
