import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LlmProviderRegistry } from "@zhujun/agentloop";

const example = JSON.parse(await readFile(new URL("../config/llm-providers.example.json", import.meta.url), "utf8"));
const invocation = {
  runId: "data-agent-model-configuration", phase: "execution" as const, systemPrompt: "Test",
  messages: [{ role: "user" as const, content: "OK" }], tools: [],
};

test("the shipped configuration uses native Alibaba SDK reasoning for hosted DeepSeek too", async t => {
  const sent: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }] });
  });
  assert.equal(example.providers[example.defaultProvider].kind, "alibaba");
  assert.equal(example.models[example.defaultModelKey].reasoning, "none");
  for (const model of ["qwen-plus", "deepseek-v4-pro", "deepseek-v4.1-flash"]) {
    for (const reasoning of ["none", "medium", "provider-default"]) {
      const config = structuredClone(example);
      Object.assign(config.models[config.defaultModelKey], { providerModel: model, reasoning });
      const registry = LlmProviderRegistry.fromConfigObject(config, { DATA_AGENT_LLM_API_KEY: "test-secret" });
      assert.equal((await registry.create().complete(invocation)).content, "OK");
      const body = sent.at(-1)!;
      assert.equal(body.model, model);
      assert.equal(body.enable_thinking, reasoning === "provider-default" ? undefined : reasoning !== "none");
      if (reasoning === "medium") assert.ok(Number(body.thinking_budget) > 0);
      else assert.equal(body.thinking_budget, undefined);
      assert.equal(body.reasoning_effort, undefined);
      assert.equal(body.providerOptions, undefined);
    }
  }
});

test("native configuration rejects legacy thinking controls at both configuration levels", () => {
  for (const level of ["provider", "model"]) {
    for (const legacy of [{ enableThinking: false }, { thinkingMode: "disabled" }, { thinkingEffort: "low" }, { planningThinkingMode: "disabled" }]) {
      const config = structuredClone(example);
      Object.assign(level === "provider" ? config.providers[config.defaultProvider] : config.models[config.defaultModelKey], legacy);
      assert.throws(() => LlmProviderRegistry.fromConfigObject(config), /native SDK options|cannot be combined with legacy/);
    }
  }
});
