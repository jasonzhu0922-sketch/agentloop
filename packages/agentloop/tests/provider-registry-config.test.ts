import assert from "node:assert/strict";
import test from "node:test";
import { LlmProviderRegistry } from "../src/runtime/provider-registry.ts";

const minimalConfig = {
  defaultProvider: "deepseek",
  providers: {
    deepseek: {
      kind: "openai-compatible",
      baseUrl: "https://api.example.com",
      apiKeyEnv: "SMOKE_MODEL_KEY",
      defaultModel: "demo-chat",
    },
  },
};

test("fromConfigObject builds an equivalent registry from an in-memory object", () => {
  const registry = LlmProviderRegistry.fromConfigObject(minimalConfig, { SMOKE_MODEL_KEY: "secret" });

  assert.equal(registry.defaultProviderKey, "deepseek");
  assert.deepEqual(registry.modelKeys(), ["demo-chat"]);
  const model = registry.create();
  assert.equal(typeof model.complete, "function");
});

test("fromConfigObject resolves secrets from the injected environment lookup", () => {
  const registry = LlmProviderRegistry.fromConfigObject(minimalConfig, {});
  // Missing key surfaces as the kernel's explicit configuration error, not a crash.
  assert.throws(() => registry.create(), /not configured/);
});

test("fromConfigObject accepts a directly configured local apiKey", () => {
  const registry = LlmProviderRegistry.fromConfigObject({
    defaultProvider: "local",
    defaultModelKey: "local-model",
    providers: {
      local: {
        kind: "openai-compatible",
        baseUrl: "https://api.example.com",
        apiKey: "local-test-secret",
        defaultModel: "local-model",
      },
    },
    models: { "local-model": { providerKey: "local", providerModel: "local-model" } },
  });
  assert.equal(registry.defaultModelKey, "local-model");
  assert.equal(typeof registry.create().complete, "function");
});

test("provider credentials require exactly one of apiKey or apiKeyEnv", () => {
  const base = { kind: "openai-compatible", baseUrl: "https://api.example.com", defaultModel: "demo-chat" };
  assert.throws(() => LlmProviderRegistry.fromConfigObject({ providers: { local: { ...base } } }), /exactly one of apiKey or apiKeyEnv/);
  assert.throws(() => LlmProviderRegistry.fromConfigObject({ providers: { local: { ...base, apiKey: "local-test-secret", apiKeyEnv: "MODEL_KEY" } } }), /exactly one of apiKey or apiKeyEnv/);
});

test("fromConfigObject derives the legacy default provider when defaultProvider is omitted", () => {
  const registry = LlmProviderRegistry.fromConfigObject({
    defaultModelKey: "demo-chat",
    providers: {
      deepseek: {
        kind: "openai-compatible",
        baseUrl: "https://api.example.com",
        apiKeyEnv: "SMOKE_MODEL_KEY",
        defaultModel: "demo-chat",
      },
    },
    models: {
      "demo-chat": { providerKey: "deepseek", providerModel: "demo-chat", displayName: "Demo Chat" },
    },
  }, { SMOKE_MODEL_KEY: "secret" });

  assert.equal(registry.defaultProviderKey, "deepseek");
  assert.equal(registry.defaultModelKey, "demo-chat");
});

test("fromConfigObject rejects invalid documents with a labeled error", () => {
  assert.throws(
    () => LlmProviderRegistry.fromConfigObject({ unexpected: true }),
    /LLM provider configuration object/,
  );
});
