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

test("fromConfigObject rejects invalid documents with a labeled error", () => {
  assert.throws(
    () => LlmProviderRegistry.fromConfigObject({ unexpected: true }),
    /LLM provider configuration object/,
  );
});
