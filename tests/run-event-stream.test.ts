import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AgentService } from "../src/agents/agent-service.ts";
import { AuthService } from "../src/auth/auth-service.ts";
import { BatchService } from "../src/batch/batch-service.ts";
import { createAgentLoopServer } from "../src/http/server.ts";
import type { ModelAdapter, ModelResponse } from "../src/runtime/contracts.ts";
import { LlmProviderRegistry } from "../src/runtime/provider-registry.ts";
import { RunEventHub, type LiveRunEvent } from "../src/runtime/run-event-hub.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

test("RunEventHub delivers to subscribers and stops after unsubscribe", () => {
  const hub = new RunEventHub();
  const received: LiveRunEvent[] = [];
  const unsubscribe = hub.subscribe("run-1", (event) => received.push(event));
  hub.publish("run-1", { seq: 1, type: "a", data: {}, createdAt: 1 });
  hub.publish("run-2", { seq: 1, type: "other", data: {}, createdAt: 2 }); // different run
  assert.deepEqual(received.map((event) => event.type), ["a"]);
  unsubscribe();
  hub.publish("run-1", { seq: 2, type: "b", data: {}, createdAt: 3 });
  assert.deepEqual(received.map((event) => event.type), ["a"]);
});

test("RunService streams live events to a subscriber during an async run", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("stream@example.com", "stream secure password");
    const agent = agents.create(owner.user.id, {
      name: "streamer",
      systemPrompt: "Finish the step.",
      providerKey: "scenario",
    });
    const runs = new RunService({
      database,
      skills,
      agents,
      modelFactory: () => new StaticCompletionModel(),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.start(owner.user.id, agent.id, "do it");
    const collected: string[] = [];
    const terminal = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for terminal event")), 5_000);
      runs.subscribeRunEvents(run.id, (event) => {
        collected.push(event.type);
        if (event.type === "run.completed") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await terminal;
    // The raw hub does not replay; run.started is emitted before start() resolves,
    // but events emitted after subscription (plan, execution, completion) must arrive.
    assert.equal(collected.includes("run.started"), false);
    assert.equal(collected.includes("plan.admitted"), true);
    assert.equal(collected.includes("run.completed"), true);
  } finally {
    database.close();
  }
});

test("SSE endpoint streams catch-up and live events over HTTP", async () => {
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const providers = testProviders();
  const agents = new AgentService(database, skills, {
    allowedProviderKeys: providers.keys(),
    defaultProviderKey: providers.defaultProviderKey,
  });
  const runs = new RunService({
    database,
    skills,
    agents,
    modelFactory: () => new StaticCompletionModel(),
    plannerFactory: () => singleStepTestPlanner(),
    assessorFactory: () => approvingTestAssessor(),
  });
  const batches = new BatchService(database, agents, runs);
  const server = createAgentLoopServer({ auth, skills, agents, runs, batches, providers });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const registered = await auth.register("sse-http@example.com", "sse http secure password");
    const token = registered.token;

    const agentBody = await postJson(base, "/v1/agents", token, {
      name: "sse-http-agent",
      systemPrompt: "Finish the step.",
      providerKey: providers.defaultProviderKey,
    });
    const agentId = (agentBody as { agent: { id: string } }).agent.id;

    const runBody = await postJson(base, "/v1/runs/async", token, {
      agentId,
      input: "do it over http",
    });
    const runId = (runBody as { run: { id: string } }).run.id;

    const events = await readSseUntil(`${base}/v1/runs/${encodeURIComponent(runId)}/events/stream`, token, "run.completed");
    assert.equal(events.some((event) => event.type === "run.completed"), true);
    const planAdmitted = events.find((event) => event.type === "plan.admitted");
    assert.notEqual(planAdmitted, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  }
});

class StaticCompletionModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  async complete(): Promise<ModelResponse> {
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }
}

function testProviders(): LlmProviderRegistry {
  return LlmProviderRegistry.fromEnvironment({
    LLM_PROVIDERS_JSON: JSON.stringify({
      defaultProvider: "sse-provider",
      providers: {
        "sse-provider": {
          kind: "openai-compatible",
          baseUrl: "https://models.example.test/v1",
          apiKeyEnv: "SSE_PROVIDER_API_KEY",
          defaultModel: "sse-model",
        },
      },
    }),
    SSE_PROVIDER_API_KEY: "test-secret",
  });
}

async function postJson(base: string, path: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status < 300, true, `POST ${path} failed with ${response.status}`);
  return response.json();
}

async function readSseUntil(
  url: string,
  token: string,
  stopOnType: string,
): Promise<Array<{ seq: number; type: string; data: Record<string, unknown>; createdAt: number }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ seq: number; type: string; data: Record<string, unknown>; createdAt: number }> = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((item) => item.startsWith("data: "));
        if (line === undefined) continue;
        const event = JSON.parse(line.slice(6)) as { seq: number; type: string; data: Record<string, unknown>; createdAt: number };
        events.push(event);
        if (event.type === stopOnType) {
          controller.abort();
          return events;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  return events;
}
