import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentService } from "../src/agents/agent-service.ts";
import { AuthService } from "../src/auth/auth-service.ts";
import { LlmProviderRegistry } from "../src/runtime/provider-registry.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";

const PROVIDER_CONFIG = {
  defaultProvider: "deepseek",
  providers: {
    deepseek: {
      kind: "openai-compatible",
      baseUrl: "https://models.example.test/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      defaultModel: "deepseek-chat",
      contextWindowTokens: 64_000,
      maxOutputTokens: 4_096,
      timeoutMs: 60_000,
      maxAttempts: 1,
      retryDelayMs: 0,
      toolChoiceMode: "constrained-as-auto",
    },
    local: {
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKeyEnv: "LOCAL_LLM_API_KEY",
      defaultModel: "qwen3",
      contextWindowTokens: 32_768,
      maxOutputTokens: 2_048,
      timeoutMs: 30_000,
      maxAttempts: 1,
      retryDelayMs: 0,
      toolChoiceMode: "native",
    },
  },
} as const;

test("the provider registry builds the selected server-configured model without exposing connection fields", async () => {
  const registry = LlmProviderRegistry.fromEnvironment({
    LLM_PROVIDERS_JSON: JSON.stringify(PROVIDER_CONFIG),
    DEEPSEEK_API_KEY: "deepseek-secret",
    LOCAL_LLM_API_KEY: "local-secret",
  });
  assert.equal(registry.defaultProviderKey, "deepseek");
  assert.deepEqual(registry.catalog(), [
    { key: "deepseek", kind: "openai-compatible", defaultModel: "deepseek-chat" },
    { key: "local", kind: "openai-compatible", defaultModel: "qwen3" },
  ]);

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; authorization: string; model: string }> = [];
  globalThis.fetch = async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as { model: string };
    requests.push({
      url: String(input),
      authorization: headers.authorization,
      model: body.model,
    });
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "configured" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const defaultModel = registry.create({ providerKey: "deepseek", modelId: "default" });
    const overrideModel = registry.create({ providerKey: "local", modelId: "qwen3-32b" });
    assert.deepEqual(defaultModel.limits, { contextWindowTokens: 64_000, maxOutputTokens: 4_096 });
    assert.deepEqual(overrideModel.limits, { contextWindowTokens: 32_768, maxOutputTokens: 2_048 });
    await defaultModel.complete({ runId: "provider-default", systemPrompt: "System", messages: [], tools: [] });
    await overrideModel.complete({ runId: "provider-override", systemPrompt: "System", messages: [], tools: [] });
    assert.deepEqual(requests, [
      {
        url: "https://models.example.test/v1/chat/completions",
        authorization: "Bearer deepseek-secret",
        model: "deepseek-chat",
      },
      {
        url: "http://127.0.0.1:11434/v1/chat/completions",
        authorization: "Bearer local-secret",
        model: "qwen3-32b",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the provider registry can be loaded from the ignored JSON configuration file", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-provider-config-"));
  const configPath = join(workspace, "llm-providers.json");
  try {
    await fs.writeFile(configPath, JSON.stringify(PROVIDER_CONFIG), "utf8");
    const registry = await LlmProviderRegistry.fromConfigFile(configPath, {
      DEEPSEEK_API_KEY: "deepseek-secret",
      LOCAL_LLM_API_KEY: "local-secret",
    });
    assert.deepEqual(registry.keys(), ["deepseek", "local"]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("the provider registry passes Runtime Context placement into the selected Adapter", async () => {
  const registry = LlmProviderRegistry.fromEnvironment({
    LLM_PROVIDERS_JSON: JSON.stringify({
      defaultProvider: "compatibility-gateway",
      providers: {
        "compatibility-gateway": {
          kind: "openai-compatible",
          baseUrl: "https://models.example.test/v1",
          apiKeyEnv: "GATEWAY_API_KEY",
          defaultModel: "gateway-model",
          runtimeContextPlacement: "user-envelope",
        },
      },
    }),
    GATEWAY_API_KEY: "gateway-secret",
  });
  const originalFetch = globalThis.fetch;
  let messages: unknown;
  globalThis.fetch = async (_input, init) => {
    messages = (JSON.parse(String(init?.body)) as { messages: unknown }).messages;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "configured" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const model = registry.create({ providerKey: "compatibility-gateway", modelId: "default" });
    await model.complete({
      runId: "provider-envelope",
      systemPrompt: "System",
      phase: "planning",
      runtimeContext: { id: "provider-envelope:1", phase: "planning", content: "server planning data" },
      messages: [{ role: "user", content: "Plan the task." }],
      tools: [],
    });
    const rows = messages as Array<{ role: string; content: string }>;
    assert.deepEqual(rows.map((row) => row.role), ["system", "user", "user"]);
    assert.equal(rows[1].content, "Plan the task.");
    assert.match(rows[2].content, /<runtime_context source="server" encoding="json"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider configuration fails closed for invalid declarations and unavailable secrets", () => {
  assert.throws(
    () => LlmProviderRegistry.fromEnvironment({}),
    /LLM_PROVIDERS_JSON must configure at least one server-side LLM provider/,
  );
  assert.throws(
    () => LlmProviderRegistry.fromEnvironment({
      LLM_PROVIDERS_JSON: JSON.stringify({
        defaultProvider: "invalid-placement",
        providers: {
          "invalid-placement": {
            kind: "openai-compatible",
            baseUrl: "https://models.example.test/v1",
            apiKeyEnv: "INVALID_PLACEMENT_KEY",
            defaultModel: "test",
            runtimeContextPlacement: "assistant",
          },
        },
      }),
    }),
    /runtimeContextPlacement must be system or user-envelope/,
  );
  assert.throws(
    () => LlmProviderRegistry.fromEnvironment({
      LLM_PROVIDERS_JSON: JSON.stringify({
        defaultProvider: "unknown",
        providers: PROVIDER_CONFIG.providers,
      }),
    }),
    /defaultProvider must name a configured provider/,
  );
  const registry = LlmProviderRegistry.fromEnvironment({
    LLM_PROVIDERS_JSON: JSON.stringify(PROVIDER_CONFIG),
  });
  assert.throws(
    () => registry.create({ providerKey: "missing", modelId: "default" }),
    (error: unknown) => hasAppError(error, "MODEL_ERROR", 400),
  );
  assert.throws(
    () => registry.create({ providerKey: "deepseek", modelId: "default" }),
    (error: unknown) => hasAppError(error, "MODEL_ERROR", 503),
  );
});

test("configured provider keys are enforced when an Agent is persisted", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const owner = await auth.register("provider-agent@example.com", "provider agent secure password");
    const agents = new AgentService(database, new SkillService(database), {
      allowedProviderKeys: ["deepseek", "local"],
      defaultProviderKey: "deepseek",
    });
    const defaulted = agents.create(owner.user.id, {
      name: "default-provider-agent",
      systemPrompt: "Use the configured provider.",
    });
    assert.equal(defaulted.providerKey, "deepseek");
    assert.throws(
      () => agents.create(owner.user.id, {
        name: "unknown-provider-agent",
        systemPrompt: "Use an unknown provider.",
        providerKey: "unconfigured",
      }),
      (error: unknown) => hasAppError(error, "BAD_REQUEST", 400),
    );
  } finally {
    database.close();
  }
});

function hasAppError(error: unknown, code: string, status: number): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && "status" in error
    && (error as { code: unknown }).code === code
    && (error as { status: unknown }).status === status;
}
