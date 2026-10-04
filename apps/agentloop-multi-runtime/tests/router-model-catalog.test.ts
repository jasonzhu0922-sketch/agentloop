import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { RouterModelCatalog, installRouterModelCatalogSchema } from "../src/router/model-catalog/model-catalog.ts";

test("Router model catalog persists nested Providers and Models as the runtime source", async () => {
  const database = new AppDatabase(":memory:");
  await installRouterModelCatalogSchema(database);
  const catalog = new RouterModelCatalog(database);
  await catalog.upsertProvider({ providerKey: "deepseek", baseUrl: "https://models.example.test/v1", apiKey: "router-secret", protocol: "chat-completions", defaultProvider: true });
  const first = await catalog.upsertModel({ modelKey: "deepseek-v4-flash", displayName: "DeepSeek v4 Flash", providerKey: "deepseek", providerModel: "deepseek-v4-flash", defaultModel: true, parameters: { thinkingMode: "disabled" } });
  await catalog.upsertModel({ modelKey: "kimi-2.6", displayName: "Kimi 2.6", providerKey: "deepseek", providerModel: "Kimi-K2.6" });
  const view = await catalog.view();
  assert.equal(view.revision, first.revision + 1);
  assert.deepEqual(view.providers.map((provider) => ({ key: provider.key, models: provider.models.map((model) => model.key) })), [{ key: "deepseek", models: ["deepseek-v4-flash", "kimi-2.6"] }]);
  const configuration = await catalog.configuration();
  const provider = (configuration.providerConfiguration.providers as Record<string, Record<string, unknown>>).deepseek;
  assert.equal(provider.apiKey, "router-secret");
  assert.deepEqual(Object.keys(provider.models as Record<string, unknown>), ["deepseek-v4-flash", "kimi-2.6"]);
  await database.close();
});

test("Router permits an empty Provider during editing but never exposes it as a runtime configuration", async () => {
  const database = new AppDatabase(":memory:");
  await installRouterModelCatalogSchema(database);
  const catalog = new RouterModelCatalog(database);
  const view = await catalog.upsertProvider({ providerKey: "openai", baseUrl: "https://models.example.test/v1", apiKey: "router-secret", protocol: "responses" });
  assert.deepEqual(view.providers.map((provider) => ({ key: provider.key, models: provider.models.length })), [{ key: "openai", models: 0 }]);
  await assert.rejects(() => catalog.configuration(), /no configured models/);
  const updated = await catalog.upsertProvider({ providerKey: "openai", baseUrl: "https://models.example.test/v2", protocol: "responses" });
  assert.equal(updated.providers[0]?.baseUrl, "https://models.example.test/v2");
  assert.equal(updated.providers[0]?.apiKeyConfigured, true);
  await database.close();
});
