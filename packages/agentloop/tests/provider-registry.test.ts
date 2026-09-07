import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LlmProviderRegistry } from "../src/runtime/provider-registry.ts";

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
  assert.equal(registry.defaultModelKey, "deepseek-chat");
  assert.deepEqual(registry.catalog(), [
    { key: "deepseek", kind: "openai-compatible", defaultModel: "deepseek-chat" },
    { key: "local", kind: "openai-compatible", defaultModel: "qwen3" },
  ]);
  assert.deepEqual(registry.modelCatalog(), [
    { key: "deepseek-chat", displayName: "deepseek-chat", providerKey: "deepseek", providerModel: "deepseek-chat", kind: "openai-compatible" },
    { key: "qwen3", displayName: "qwen3", providerKey: "local", providerModel: "qwen3", kind: "openai-compatible" },
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
    const defaultModel = registry.create();
    const localRegistry = LlmProviderRegistry.fromEnvironment({
      LLM_PROVIDERS_JSON: JSON.stringify({ ...PROVIDER_CONFIG, defaultProvider: "local" }),
      DEEPSEEK_API_KEY: "deepseek-secret",
      LOCAL_LLM_API_KEY: "local-secret",
    });
    const overrideModel = localRegistry.create();
    assert.deepEqual(defaultModel.limits, { contextWindowTokens: 64_000, maxOutputTokens: 4_096 });
    assert.deepEqual(overrideModel.limits, { contextWindowTokens: 32_768, maxOutputTokens: 2_048 });
    await defaultModel.complete({ runId: "provider-default", systemPrompt: "System", phase: "execution", messages: [], tools: [] });
    await overrideModel.complete({ runId: "provider-override", systemPrompt: "System", phase: "execution", messages: [], tools: [] });
    assert.deepEqual(requests, [
      {
        url: "https://models.example.test/v1/chat/completions",
        authorization: "Bearer deepseek-secret",
        model: "deepseek-chat",
      },
      {
        url: "http://127.0.0.1:11434/v1/chat/completions",
        authorization: "Bearer local-secret",
        model: "qwen3",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the provider registry routes user-visible model keys through server-owned model profiles", async () => {
  const registry = LlmProviderRegistry.fromEnvironment({
    LLM_PROVIDERS_JSON: JSON.stringify({
      defaultProvider: "deepseek",
      defaultModelKey: "deepseek-v4-pro",
      providers: {
        deepseek: {
          kind: "openai-compatible",
          baseUrl: "https://models.example.test/v1",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          defaultModel: "DeepSeek-v4-pro",
          contextWindowTokens: 128_000,
          maxOutputTokens: 16_384,
          timeoutMs: 60_000,
          maxAttempts: 1,
          retryDelayMs: 0,
          toolChoiceMode: "constrained-as-auto",
        },
      },
      models: {
        "deepseek-v4-pro": {
          providerKey: "deepseek",
          providerModel: "deepseek-v4-pro",
          displayName: "DeepSeek v4 Pro",
          maxOutputTokens: 16_384,
        },
        "deepseek-v4-flash": {
          providerKey: "deepseek",
          providerModel: "deepseek-v4-flash",
          displayName: "DeepSeek v4 Flash",
          maxOutputTokens: 8_192,
        },
      },
    }),
    DEEPSEEK_API_KEY: "deepseek-secret",
  });
  assert.equal(registry.defaultModelKey, "deepseek-v4-pro");
  assert.deepEqual(registry.modelKeys(), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.deepEqual(registry.modelCatalog(), [
    {
      key: "deepseek-v4-flash",
      displayName: "DeepSeek v4 Flash",
      providerKey: "deepseek",
      providerModel: "deepseek-v4-flash",
      kind: "openai-compatible",
    },
    {
      key: "deepseek-v4-pro",
      displayName: "DeepSeek v4 Pro",
      providerKey: "deepseek",
      providerModel: "deepseek-v4-pro",
      kind: "openai-compatible",
    },
  ]);

  const originalFetch = globalThis.fetch;
  const requestedModels: string[] = [];
  globalThis.fetch = async (_input, init) => {
    requestedModels.push((JSON.parse(String(init?.body)) as { model: string }).model);
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "configured" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await registry.create("deepseek-v4-flash").complete({
      runId: "flash",
      systemPrompt: "System",
      phase: "execution",
      messages: [],
      tools: [],
    });
    await registry.create().complete({
      runId: "default",
      systemPrompt: "System",
      phase: "execution",
      messages: [],
      tools: [],
    });
    assert.deepEqual(requestedModels, ["deepseek-v4-flash", "deepseek-v4-pro"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the provider registry routes GPT5.6 through the Responses protocol", async () => {
  const registry = LlmProviderRegistry.fromEnvironment({
    LLM_PROVIDERS_JSON: JSON.stringify({
      defaultProvider: "openai",
      defaultModelKey: "gpt-5.6",
      providers: {
        openai: {
          kind: "openai-compatible",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY",
          defaultModel: "gpt-5.6",
          contextWindowTokens: 400_000,
          maxOutputTokens: 32_768,
          timeoutMs: 180_000,
          maxAttempts: 1,
          retryDelayMs: 0,
          toolChoiceMode: "native",
          protocol: "responses",
        },
      },
      models: {
        "gpt-5.6": {
          providerKey: "openai",
          providerModel: "gpt-5.6",
          displayName: "GPT5.6",
          toolChoiceMode: "constrained-as-auto",
          reasoningSummary: "auto",
          protocol: "responses",
        },
      },
    }),
    OPENAI_API_KEY: "openai-secret",
  });
  assert.equal(registry.defaultModelKey, "gpt-5.6");
  assert.deepEqual(registry.modelKeys(), ["gpt-5.6"]);

  const originalFetch = globalThis.fetch;
  let captured: { url: string; authorization: string; body: Record<string, unknown> } | undefined;
  globalThis.fetch = async (input, init) => {
    captured = {
      url: String(input),
      authorization: (init?.headers as Record<string, string>).authorization,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return new Response(JSON.stringify({
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "configured" }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const model = registry.create("gpt-5.6");
    assert.deepEqual(model.limits, { contextWindowTokens: 400_000, maxOutputTokens: 32_768 });
    const result = await model.complete({
      runId: "gpt-5-6",
      systemPrompt: "System",
      phase: "execution",
      messages: [{ role: "user", content: "Check" }],
      tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
      toolChoice: { name: "lookup" },
    });
    assert.equal(result.content, "configured");
    assert.deepEqual(captured, {
      url: "https://api.openai.com/v1/responses",
      authorization: "Bearer openai-secret",
      body: {
        model: "gpt-5.6",
        instructions: "System",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Check" }] }],
        tools: [{
          type: "function",
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object" },
        }],
        tool_choice: "auto",
        reasoning: { summary: "auto" },
        max_output_tokens: 32_768,
        stream: true,
      },
    });
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

test("the provider registry passes named-as-required tool choice mode into Responses models", async () => {
  const registry = LlmProviderRegistry.fromEnvironment({
    LLM_PROVIDERS_JSON: JSON.stringify({
      defaultProvider: "openai",
      defaultModelKey: "planning-model",
      providers: {
        openai: {
          kind: "openai-compatible",
          baseUrl: "https://api.openai.test/v1",
          apiKeyEnv: "OPENAI_API_KEY",
          defaultModel: "planning-model",
          contextWindowTokens: 128_000,
          maxOutputTokens: 8_192,
          protocol: "responses",
          toolChoiceMode: "named-as-required",
        },
      },
      models: {
        "planning-model": {
          providerKey: "openai",
          providerModel: "planning-model",
          displayName: "Planning Model",
        },
      },
    }),
    OPENAI_API_KEY: "openai-secret",
  });
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      status: "completed",
      output: [{
        type: "function_call",
        id: "fc_plan",
        call_id: "call-plan",
        name: "submit_outcome_plan",
        arguments: "{}",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const model = registry.create();
    await model.complete({
      runId: "registry-named-as-required",
      systemPrompt: "System",
      phase: "planning",
      messages: [{ role: "user", content: "Plan" }],
      tools: [{ name: "submit_outcome_plan", description: "Submit plan", inputSchema: { type: "object" } }],
      toolChoice: { name: "submit_outcome_plan" },
    });
    assert.equal(capturedBody?.tool_choice, "required");
  } finally {
    globalThis.fetch = originalFetch;
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
    const model = registry.create();
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
    () => registry.create(),
    (error: unknown) => hasAppError(error, "MODEL_ERROR", 503),
  );
});

function hasAppError(error: unknown, code: string, status: number): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && "status" in error
    && (error as { code: unknown }).code === code
    && (error as { status: unknown }).status === status;
}
