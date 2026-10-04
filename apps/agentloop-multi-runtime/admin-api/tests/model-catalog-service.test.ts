import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { ReleaseApplicationService } from "../src/application/release-service.ts";
import { ModelCatalogApplicationService } from "../src/application/model-catalog-service.ts";
import { migrateControlPlane } from "../src/persistence/control-plane-migrations.ts";
import { SqlControlPlaneStore } from "../src/persistence/sql-control-plane-store.ts";

test("model catalog registers, edits, and removes models as immutable route drafts with key-value parameters", async () => {
  const database = new AppDatabase(":memory:");
  await migrateControlPlane(database);
  const store = new SqlControlPlaneStore(database);
  const releases = new ReleaseApplicationService(store);
  const models = new ModelCatalogApplicationService(store, releases);
  const first = await models.register({ modelKey: "model-a", displayName: "Model A", providerKey: "provider-a", providerModel: "upstream-a", baseUrl: "https://models.example.test/v1", apiKeyEnv: "MODEL_A_KEY", protocol: "chat-completions", defaultModel: true, parameters: { thinkingMode: "enabled", thinkingEffort: "medium", chatTemplateKwargs: { thinking: true } } }, "admin", "model-register-a");
  assert.equal(first.state, "draft");
  assert.deepEqual((await models.list()).map((model) => ({ key: model.key, parameters: model.parameters, defaultModel: model.defaultModel })), [{ key: "model-a", parameters: { thinkingMode: "enabled", thinkingEffort: "medium", chatTemplateKwargs: { thinking: true } }, defaultModel: true }]);
  const second = await models.register({
    modelKey: "deepseek-v4-flash-2",
    displayName: "DeepSeek v4 Flash 2",
    providerKey: "provider-a",
    providerModel: "DeepSeek-V4-flash",
    baseUrl: "https://models.example.test/v1",
    apiKeyEnv: "MODEL_A_KEY",
    protocol: "chat-completions",
    parameters: {
      maxOutputTokens: 16_384,
      toolChoiceMode: "named-as-required",
      chatTemplateKwargs: { thinking: false, effort: "none" },
      reasoningVisibility: "hidden",
    },
  }, "admin", "model-register-b");
  assert.equal(second.version, 2);
  assert.equal((second.payload.providerConfiguration as { providers: { "provider-a": { defaultModel: string } } }).providers["provider-a"].defaultModel, "upstream-a");
  const deepseek = (await models.list()).find((model) => model.key === "deepseek-v4-flash-2");
  assert.equal(deepseek?.maxOutputTokens, 16_384);
  assert.deepEqual(deepseek?.parameters, {
    toolChoiceMode: "named-as-required",
    chatTemplateKwargs: { thinking: false, effort: "none" },
    reasoningVisibility: "hidden",
  });
  await models.update("deepseek-v4-flash-2", { modelKey: "deepseek-v4-flash-2", displayName: "DeepSeek v4 Flash 2 edited", providerKey: "provider-a", providerModel: "DeepSeek-V4-flash", baseUrl: "https://models.example.test/v1", apiKeyEnv: "MODEL_A_KEY", protocol: "chat-completions", parameters: { customFlag: true, chatTemplateKwargs: { thinking: false, effort: "none" } } }, "admin", "model-update-b");
  assert.equal((await models.list()).find((model) => model.key === "deepseek-v4-flash-2")?.displayName, "DeepSeek v4 Flash 2 edited");
  await models.remove("model-a", "admin", "model-delete-a");
  assert.deepEqual((await models.list()).map((model) => model.key), ["deepseek-v4-flash-2"]);
  await database.close();
});

test("model catalog seeds the configured provider document once without activating it", async () => {
  const database = new AppDatabase(":memory:");
  await migrateControlPlane(database);
  const store = new SqlControlPlaneStore(database);
  const models = new ModelCatalogApplicationService(store, new ReleaseApplicationService(store));
  const seeded = await models.seedFromProviderConfiguration({
    defaultProvider: "openai",
    defaultModelKey: "deepseek-v4-flash",
    providers: {
      openai: { kind: "openai-compatible", baseUrl: "https://models.example.test/v1", apiKeyEnv: "OPENAI_API_KEY", protocol: "responses" },
      deepseek: { kind: "openai-compatible", baseUrl: "https://deepseek.example.test/v1", apiKeyEnv: "DEEPSEEK_API_KEY", protocol: "chat-completions", maxOutputTokens: 16_384 },
    },
    models: {
      "deepseek-v4-flash": { providerKey: "deepseek", providerModel: "deepseek-v4-flash", displayName: "DeepSeek v4 Flash", maxOutputTokens: 16_384 },
      "kimi-2.6": { providerKey: "deepseek", providerModel: "Kimi-K2.6", displayName: "Kimi 2.6" },
      "gpt-5.6-terra": { providerKey: "openai", providerModel: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" },
    },
  }, "bootstrap-config", "model-route-bootstrap");
  assert.equal(seeded?.state, "draft");
  assert.deepEqual((await models.list()).map((model) => ({ key: model.key, defaultModel: model.defaultModel, protocol: model.protocol })), [
    { key: "deepseek-v4-flash", defaultModel: true, protocol: "chat-completions" },
    { key: "gpt-5.6-terra", defaultModel: false, protocol: "responses" },
    { key: "kimi-2.6", defaultModel: false, protocol: "chat-completions" },
  ]);
  assert.equal((await models.list()).find((model) => model.key === "kimi-2.6")?.maxOutputTokens, 16_384);
  assert.equal(await models.seedFromProviderConfiguration({ providers: {}, models: {} }, "bootstrap-config", "duplicate-bootstrap"), undefined);
  await database.close();
});

test("the checked-in multi-runtime provider document imports all configured models", async () => {
  const database = new AppDatabase(":memory:");
  await migrateControlPlane(database);
  const store = new SqlControlPlaneStore(database);
  const models = new ModelCatalogApplicationService(store, new ReleaseApplicationService(store));
  const configPath = fileURLToPath(new URL("../../config/llm-providers.json", import.meta.url));
  await models.seedFromProviderConfiguration(JSON.parse(await readFile(configPath, "utf8")), "bootstrap-config", "model-route-bootstrap");
  assert.deepEqual((await models.list()).map((model) => model.key), ["deepseek-v4-flash", "deepseek-v4-flash-2", "gpt-5.6-terra", "kimi-2.6"]);
  await database.close();
});
