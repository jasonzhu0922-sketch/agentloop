import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts"
import { BatchService } from "@zhujun/agentloop";
import { createAgentLoopServer } from "../src/http/server.ts"
import type { ModelAdapter, ModelInvocation, ModelResponse } from "@zhujun/agentloop";
import { LlmProviderRegistry } from "@zhujun/agentloop";
import { RunEventHub, type LiveRunEvent } from "@zhujun/agentloop";
import { RunService } from "@zhujun/agentloop";
import { SkillService } from "@zhujun/agentloop";
import { AppDatabase } from "@zhujun/agentloop";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";
import type { RuntimeTool } from "@zhujun/agentloop";

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
    const owner = await auth.register("stream@example.com", "stream secure password");
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => new StaticCompletionModel(),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.start(owner.user.id, "do it");
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

test("RunService persists model.retry events reported by the provider adapter", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("retry@example.com", "retry secure password");
    const runs = new RunService({
      database,
      skills,
      modelFactory: (onRetry) => ({
        limits: TEST_MODEL_LIMITS,
        async complete() {
          await onRetry?.({ attempt: 1, maxAttempts: 3, status: 400, delayMs: 250 });
          return { content: "done", finishReason: "stop", toolCalls: [] };
        },
      }),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });
    const run = await runs.execute(owner.user.id, "retry once");
    const retries = (await runs.events(owner.user.id, run.id)).filter((event) => event.type === "model.retry");
    assert.equal(retries.length, 1);
    assert.deepEqual(retries[0].data, { attempt: 1, maxAttempts: 3, status: 400, delayMs: 250 });
  } finally {
    database.close();
  }
});

test("RunService projects large tool arguments to refs before durable event storage", async () => {
  const database = new AppDatabase(":memory:");
  const workspaceRoot = await mkdtemp(join(tmpdir(), "agentloop-tool-args-ref-"));
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("large-args@example.com", "large args secure password");
    const largeContent = "BEGIN-" + "x".repeat(16_000) + "-END";
    let executedContent = "";
    const tool: RuntimeTool<unknown> = {
      name: "record_large_arg",
      description: "Record a large argument",
      inputSchema: { type: "object" },
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => value,
      execute: async (_context, value) => {
        executedContent = String((value as { content?: unknown }).content ?? "");
        return "recorded";
      },
    };
    const runs = new RunService({
      database,
      skills,
      workspaceRoot,
      modelFactory: () => new LargeArgumentModel({ path: "report.md", content: largeContent }),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
      tools: [tool],
    });

    const run = await runs.execute(owner.user.id, "record the payload");
    assert.equal(executedContent, largeContent);

    const rows = (await database.prepare("SELECT type, payload_json FROM run_events WHERE run_id = ? ORDER BY seq").all(run.id)) as Array<{
      type: string;
      payload_json: string;
    }>;
    assert.equal(rows.some((row) => row.payload_json.includes("-END")), false);
    const plannedRow = rows.find((row) => row.type === "tool.planned");
    assert.notEqual(plannedRow, undefined);
    assert.equal(plannedRow!.payload_json.length < 2_500, true);

    const events = await runs.events(owner.user.id, run.id);
    const planned = events.find((event) => event.type === "tool.planned");
    assert.equal(typeof planned?.data.argumentsRef, "object");
    const plannedArgs = planned?.data.arguments as { path?: string; content?: { schema?: string; preview?: string } };
    assert.equal(plannedArgs.path, "report.md");
    assert.equal(plannedArgs.content?.schema, "agentloop.toolArgumentTextProjection/v1");
    assert.equal(plannedArgs.content?.preview?.startsWith("BEGIN-"), true);

    const committed = events.find((event) => event.type === "assistant.committed");
    const committedCalls = committed?.data.toolCalls as Array<{ argumentsRef?: unknown }> | undefined;
    assert.equal(typeof committedCalls?.[0]?.argumentsRef, "object");

    const full = await runs.readToolArguments(owner.user.id, run.id, "large-arg-call");
    assert.deepEqual(full.arguments, { path: "report.md", content: largeContent });
    assert.equal(full.content.includes("-END"), true);
    assert.equal(full.path?.startsWith(".agentloop/tool-arguments/"), true);
  } finally {
    database.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("RunService binds each Run to an admitted model key", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("models@example.com", "models secure password");
    const seenModelKeys: Array<string | undefined> = [];
    const runs = new RunService({
      database,
      skills,
      defaultModelKey: "deepseek-v4-pro",
      modelKeys: ["deepseek-v4-pro", "deepseek-v4-flash"],
      modelFactory: (_onRetry, modelKey) => {
        seenModelKeys.push(modelKey);
        return new StaticCompletionModel();
      },
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    const defaultRun = await runs.execute(owner.user.id, "use default model");
    const flashRun = await runs.execute(owner.user.id, "use flash model", { modelKey: "deepseek-v4-flash" });

    assert.equal(defaultRun.modelKey, "deepseek-v4-pro");
    assert.equal(flashRun.modelKey, "deepseek-v4-flash");
    assert.deepEqual(seenModelKeys, ["deepseek-v4-pro", "deepseek-v4-flash"]);
    assert.equal(
      (await runs.events(owner.user.id, flashRun.id)).find((event) => event.type === "run.started")?.data.modelKey,
      "deepseek-v4-flash",
    );
    await assert.rejects(
      () => runs.execute(owner.user.id, "bad model", { modelKey: "unknown-model" }),
      /Unknown modelKey: unknown-model/,
    );
  } finally {
    database.close();
  }
});

test("RunService writes safe terminal summaries for durable run events when configured", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("terminal-log@example.com", "terminal log secure password");
    const lines: string[] = [];
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => ({
        limits: TEST_MODEL_LIMITS,
        async complete() {
          return {
            content: "done",
            finishReason: "stop",
            toolCalls: [],
            usage: { inputTokens: 11, outputTokens: 3 },
          };
        },
      }),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
      runEventLogSink: (line) => lines.push(line),
    });

    const run = await runs.execute(owner.user.id, "do not print this private task");

    assert.equal(lines.some((line) => line.includes(`run=${run.id.slice(0, 8)}`)), true);
    assert.equal(lines.some((line) => line.includes("event=run.started")), true);
    assert.equal(lines.some((line) => line.includes("event=plan.admitted") && line.includes("steps=1")), true);
    assert.equal(lines.some((line) => line.includes("event=assistant.committed") && line.includes("finish=\"stop\"") && line.includes("inputTokens=11") && line.includes("outputTokens=3")), true);
    assert.equal(lines.some((line) => line.includes("event=run.completed")), true);
    assert.equal(lines.some((line) => line.includes("do not print this private task")), false);
  } finally {
    database.close();
  }
});

test("RunService keeps provider reasoning continuation out of public events", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("reasoning-events@example.com", "reasoning events secure password");
    let releaseModel: (() => void) | undefined;
    const modelStarted = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => ({
        limits: TEST_MODEL_LIMITS,
        async complete() {
          await modelStarted;
          return {
            content: "done",
            finishReason: "stop",
            toolCalls: [],
            reasoningContent: "opaque-thinking-state",
          };
        },
      }),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.start(owner.user.id, "keep provider state private");
    const liveEvents: LiveRunEvent[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for run completion")), 5_000);
      const unsubscribe = runs.subscribeRunEvents(run.id, (event) => {
        liveEvents.push(event);
        if (event.type === "run.completed") {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });
    releaseModel?.();
    await completed;

    const storedCommitted = (await runs.events(owner.user.id, run.id)).find((event) => event.type === "assistant.committed");
    const liveCommitted = liveEvents.find((event) => event.type === "assistant.committed");
    assert.equal(storedCommitted?.data.reasoningContent, undefined);
    assert.equal(liveCommitted?.data.reasoningContent, undefined);
    assert.deepEqual(storedCommitted?.data.privateReasoning, {
      schema: "agentloop.privateReasoningProjection/v1",
      redacted: true,
      characters: "opaque-thinking-state".length,
    });
    assert.deepEqual(liveCommitted?.data.privateReasoning, storedCommitted?.data.privateReasoning);
  } finally {
    database.close();
  }
});

test("SSE endpoint streams catch-up and live events over HTTP", async () => {
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const providers = testProviders();
  const runs = new RunService({
    database,
    skills,
    modelFactory: () => new StaticCompletionModel(),
    plannerFactory: () => singleStepTestPlanner(),
    assessorFactory: () => approvingTestAssessor(),
  });
  const batches = new BatchService(database, runs);
  const server = createAgentLoopServer({ auth, skills, runs, batches, providers });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const registered = await auth.register("sse-http@example.com", "sse http secure password");
    const token = registered.token;

    const runBody = await postJson(base, "/v1/runs/async", token, {
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

test("HTTP run intake accepts only configured model keys", async () => {
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const providers = testProviders();
  const seenModelKeys: Array<string | undefined> = [];
  const runs = new RunService({
    database,
    skills,
    defaultModelKey: providers.defaultModelKey,
    modelKeys: providers.modelKeys(),
    modelFactory: (_onRetry, modelKey) => {
      seenModelKeys.push(modelKey);
      return new StaticCompletionModel();
    },
    plannerFactory: () => singleStepTestPlanner(),
    assessorFactory: () => approvingTestAssessor(),
  });
  const batches = new BatchService(database, runs);
  const server = createAgentLoopServer({ auth, skills, runs, batches, providers });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const registered = await auth.register("http-models@example.com", "http models secure password");
    const token = registered.token;

    const catalog = await getJson(base, "/v1/providers", token) as {
      defaultModelKey: string;
      models: Array<{ key: string; displayName: string }>;
    };
    assert.equal(catalog.defaultModelKey, "sse-model");
    assert.deepEqual(catalog.models, [{
      key: "sse-model",
      displayName: "sse-model",
      providerKey: "sse-provider",
      providerModel: "sse-model",
      kind: "openai-compatible",
    }]);

    const accepted = await postJson(base, "/v1/runs", token, {
      input: "use sse model",
      modelKey: "sse-model",
    });
    assert.equal((accepted as { run: { modelKey?: string } }).run.modelKey, "sse-model");
    assert.deepEqual(seenModelKeys, ["sse-model"]);

    const rejected = await fetch(base + "/v1/runs/async", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ input: "bad", modelKey: "unknown-model" }),
    });
    assert.equal(rejected.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  }
});

test("GET /v1/runs lists a user's top-level runs most-recent-first", async () => {
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const providers = testProviders();
  const runs = new RunService({
    database,
    skills,
    modelFactory: () => new StaticCompletionModel(),
    plannerFactory: () => singleStepTestPlanner(),
    assessorFactory: () => approvingTestAssessor(),
  });
  const batches = new BatchService(database, runs);
  const server = createAgentLoopServer({ auth, skills, runs, batches, providers });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const registered = await auth.register("list-runs@example.com", "list runs secure password");
    const token = registered.token;

    const first = await postJson(base, "/v1/runs/async", token, { input: "first task" });
    const second = await postJson(base, "/v1/runs/async", token, { input: "second task" });
    const firstId = (first as { run: { id: string } }).run.id;
    const secondId = (second as { run: { id: string } }).run.id;

    const listBody = await getJson(base, "/v1/runs", token);
    const ids = (listBody as { runs: Array<{ id: string }> }).runs.map((run) => run.id);
    assert.equal(ids.includes(firstId), true);
    assert.equal(ids.includes(secondId), true);
    assert.equal(ids.indexOf(secondId), 0);
    assert.equal(ids.indexOf(firstId), 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  }
});

test("follow-up runs receive prior conversation turns in planner context", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("conv@example.com", "conv secure password");
    const plannerHistory: Array<Array<{ role: string; content: string }>> = [];
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => new StaticCompletionModel(),
      plannerFactory: () => ({
        plan: async (task) => {
          plannerHistory.push((task.conversationHistory ?? []).map((message) => ({
            role: message.role,
            content: message.content,
          })));
          return singleStepTestPlanner().plan(task);
        },
      }),
      assessorFactory: () => approvingTestAssessor(),
    });

    const first = await runs.execute(owner.user.id, "first task");
    assert.equal(typeof first.conversationId, "string");
    const second = await runs.execute(owner.user.id, "second task", {
      allowDangerousTools: false,
      conversationId: first.conversationId,
    });
    assert.equal(second.conversationId, first.conversationId);

    assert.equal(plannerHistory.length, 2);
    assert.equal(plannerHistory[0].length, 0);
    assert.equal(plannerHistory[1].length, 2);
    assert.deepEqual(plannerHistory[1][0], { role: "user", content: "first task" });
    assert.equal(plannerHistory[1][1].role, "assistant");
    assert.equal(plannerHistory[1][1].content, "done");
  } finally {
    database.close();
  }
});

test("an informational follow-up does not inherit Skills or execution Tools from prior work", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("intent@example.com", "intent secure password");
    await skills.create(owner.user.id, {
      name: "pptx",
      description: "Create PowerPoint presentations",
      instructions: "Use the presentation workflow.",
    });
    const model = new ConversationIntentModel();
    const plannerInputs: Array<{ responseOnly?: boolean; skillCount: number; toolNames: string[] }> = [];
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async (task) => {
          plannerInputs.push({
            responseOnly: task.responseOnly,
            skillCount: task.availableSkills.length,
            toolNames: [...task.availableToolNames],
          });
          return {
            goal: task.input,
            selectedSkillIds: [],
            steps: [{
              id: "answer",
              objective: "Answer the latest user message",
              dependencies: [],
              skillIds: [],
              recommendedToolNames: [],
              successCriteria: [{ id: "answered", description: "Return a direct answer", source: "task" }],
            }],
          };
        },
      }),
      assessorFactory: () => approvingTestAssessor(),
    });

    const first = await runs.execute(owner.user.id, "Create a PowerPoint presentation", {
      allowDangerousTools: true,
    });
    const second = await runs.execute(owner.user.id, "Which Skill did you use to complete it?", {
      allowDangerousTools: false,
      conversationId: first.conversationId,
      conversationIntent: "auto",
    });

    assert.equal(second.output, "No Skill was loaded; the presentation was produced with generic file and command tools.");
    assert.deepEqual(plannerInputs[1], { responseOnly: true, skillCount: 0, toolNames: [] });
    const events = await runs.events(owner.user.id, second.id);
    assert.deepEqual(events.find((event) => event.type === "conversation.intent.classified")?.data, { kind: "reply" });
    assert.equal(events.some((event) => event.type === "planning.skills.selected"), false);
    assert.equal(events.some((event) => event.type === "skill.activated"), false);
    assert.equal(events.some((event) => event.type.startsWith("tool.")), false);
    assert.equal(model.classifierSawSkillCatalog, false);
    assert.equal(model.executionToolCounts[1], 0);
  } finally {
    database.close();
  }
});

test("a textual request that needs local file state is execution, not response-only", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("file-intent@example.com", "file intent secure password");
    const model = new ConversationIntentModel();
    const plannerInputs: Array<{ responseOnly?: boolean; toolNames: string[] }> = [];
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async (task) => {
          plannerInputs.push({
            responseOnly: task.responseOnly,
            toolNames: [...task.availableToolNames],
          });
          return {
            goal: task.input,
            selectedSkillIds: [],
            steps: [{
              id: "inspect-file",
              objective: "Inspect the referenced local file and describe its behavior.",
              dependencies: [],
              skillIds: [],
              recommendedToolNames: [],
              successCriteria: [{ id: "classified-for-execution", description: "The planner received the execution tool catalog", source: "task" }],
            }],
          };
        },
      }),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.execute(
      owner.user.id,
      "分析一下 ~/coding/codex-switch.sh 文件，描述一下这个文件的功能",
      { allowDangerousTools: true, conversationIntent: "auto" },
    );

    assert.equal(run.status, "completed");
    assert.equal(model.classifierCalls, 0);
    assert.equal(plannerInputs.length, 1);
    assert.equal(plannerInputs[0].responseOnly, undefined);
    assert.equal(plannerInputs[0].toolNames.includes("computer_read_file"), true);
    assert.equal(plannerInputs[0].toolNames.includes("computer_run_command"), true);
    const events = await runs.events(owner.user.id, run.id);
    assert.deepEqual(events.find((event) => event.type === "conversation.intent.classified")?.data, { kind: "execute" });
  } finally {
    database.close();
  }
});

test("conversations group multiple turns over HTTP", async () => {
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const providers = testProviders();
  const model = new ConversationIntentModel();
  const runs = new RunService({
    database,
    skills,
    modelFactory: () => model,
    plannerFactory: () => singleStepTestPlanner(),
    assessorFactory: () => approvingTestAssessor(),
  });
  const batches = new BatchService(database, runs);
  const server = createAgentLoopServer({ auth, skills, runs, batches, providers });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const registered = await auth.register("conv-http@example.com", "conv http secure password");
    const token = registered.token;

    const first = await postJson(base, "/v1/runs/async", token, { input: "turn one" });
    const firstRun = (first as { run: { id: string; conversationId?: string } }).run;
    assert.equal(typeof firstRun.conversationId, "string");

    const second = await postJson(base, "/v1/runs", token, {
      input: "Which Skill did you use?",
      conversationId: firstRun.conversationId,
      conversationIntent: "auto",
    });
    const secondRun = (second as { run: { id: string; conversationId?: string } }).run;
    assert.equal(secondRun.conversationId, firstRun.conversationId);
    assert.deepEqual(
      (await runs.events(registered.user.id, secondRun.id))
        .find((event) => event.type === "conversation.intent.classified")?.data,
      { kind: "reply" },
    );

    const conversationsBody = await getJson(base, "/v1/conversations", token);
    const conversations = (conversationsBody as { conversations: Array<{ id: string; runCount: number }> }).conversations;
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].id, firstRun.conversationId);
    assert.equal(conversations[0].runCount, 2);

    const detailBody = await getJson(base, `/v1/conversations/${firstRun.conversationId}`, token);
    const detail = detailBody as {
      conversation: { runCount: number; lastStatus: string | null };
      runs: Array<{ id: string }>;
    };
    assert.equal(detail.conversation.runCount, 2);
    assert.equal(detail.conversation.lastStatus, "completed");
    assert.equal(detail.runs.length, 2);
    assert.equal(detail.runs[0].id, firstRun.id);
    assert.equal(detail.runs[1].id, secondRun.id);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  }
});

test("GET /v1/conversations paginates newest conversations first", async () => {
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const providers = testProviders();
  const runs = new RunService({
    database,
    skills,
    modelFactory: () => new StaticCompletionModel(),
    plannerFactory: () => singleStepTestPlanner(),
    assessorFactory: () => approvingTestAssessor(),
  });
  const batches = new BatchService(database, runs);
  const server = createAgentLoopServer({ auth, skills, runs, batches, providers });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const registered = await auth.register("conv-page@example.com", "conv page secure password");
    const token = registered.token;
    const now = Date.now();
    for (let i = 0; i < 25; i++) {
      await database.prepare(`
        INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(`conversation-${String(i).padStart(2, "0")}`, registered.user.id, `Conversation ${i}`, now + i, now + i);
    }

    const firstBody = await getJson(base, "/v1/conversations", token) as {
      conversations: Array<{ id: string }>;
      hasMore: boolean;
      nextOffset?: number;
    };
    assert.equal(firstBody.conversations.length, 20);
    assert.equal(firstBody.conversations[0].id, "conversation-24");
    assert.equal(firstBody.conversations[19].id, "conversation-05");
    assert.equal(firstBody.hasMore, true);
    assert.equal(firstBody.nextOffset, 20);

    const secondBody = await getJson(base, "/v1/conversations?limit=20&offset=20", token) as {
      conversations: Array<{ id: string }>;
      hasMore: boolean;
      nextOffset?: number;
    };
    assert.deepEqual(secondBody.conversations.map((conversation) => conversation.id), [
      "conversation-04",
      "conversation-03",
      "conversation-02",
      "conversation-01",
      "conversation-00",
    ]);
    assert.equal(secondBody.hasMore, false);
    assert.equal(secondBody.nextOffset, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  }
});

test("Host protocol exposes a stable sidecar Run projection over HTTP", async () => {
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const providers = testProviders();
  const runs = new RunService({
    database,
    skills,
    modelFactory: () => new StaticCompletionModel(),
    plannerFactory: () => singleStepTestPlanner(),
    assessorFactory: () => approvingTestAssessor(),
  });
  const batches = new BatchService(database, runs);
  const server = createAgentLoopServer({ auth, skills, runs, batches, providers });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const registered = await auth.register("host-protocol@example.com", "host protocol secure password");
    const token = registered.token;

    const protocol = await getJson(base, "/v1/host/protocol", token) as {
      schema: string;
      contracts: { run: string; outcome: string; event: string };
    };
    assert.equal(protocol.schema, "agentloop.hostProtocol/v1");
    assert.equal(protocol.contracts.run, "agentloop.hostRun/v1");
    assert.equal(protocol.contracts.outcome, "agentloop.hostOutcome/v1");

    const created = await postJson(base, "/v1/host/runs", token, { input: "complete through host protocol" }) as {
      schema: string;
      run: {
        schema: string;
        run: { id: string; status: string; output?: string };
        outcome?: { schema: string; status: string; reasonCode: string; output?: string };
        plan: { state: string; status: string; assessmentCount: number; approvedAssessmentCount: number; steps: Array<{ status: string }> };
        eventCursor: { lastSeq: number };
      };
    };
    assert.equal(created.schema, "agentloop.hostRunStart/v1");
    assert.equal(created.run.schema, "agentloop.hostRun/v1");
    assert.equal(created.run.run.status, "completed");
    assert.equal(created.run.outcome?.schema, "agentloop.hostOutcome/v1");
    assert.equal(created.run.outcome?.status, "completed");
    assert.equal(created.run.outcome?.reasonCode, "plan_assessed_and_completed");
    assert.equal(created.run.outcome?.output, "done");
    assert.equal(created.run.plan.state, "available");
    assert.equal(created.run.plan.status, "completed");
    assert.equal(created.run.plan.steps[0]?.status, "completed");
    assert.equal(created.run.plan.assessmentCount, 1);
    assert.equal(created.run.plan.approvedAssessmentCount, 1);
    assert.equal(created.run.eventCursor.lastSeq > 0, true);

    const queried = await getJson(base, `/v1/host/runs/${encodeURIComponent(created.run.run.id)}`, token) as {
      run: { schema: string; outcome?: { output?: string }; eventCursor: { lastSeq: number } };
    };
    assert.equal(queried.run.schema, "agentloop.hostRun/v1");
    assert.equal(queried.run.outcome?.output, "done");
    assert.equal(queried.run.eventCursor.lastSeq, created.run.eventCursor.lastSeq);

    const listedEvents = await getJson(base, `/v1/host/runs/${encodeURIComponent(created.run.run.id)}/events`, token) as {
      schema: string;
      events: Array<{ schema: string; type: string }>;
    };
    assert.equal(listedEvents.schema, "agentloop.hostRunEvents/v1");
    assert.equal(listedEvents.events.every((event) => event.schema === "agentloop.hostRunEvent/v1"), true);
    assert.equal(listedEvents.events.some((event) => event.type === "run.completed"), true);
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

class LargeArgumentModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;
  private readonly argumentsValue: Record<string, unknown>;

  constructor(argumentsValue: Record<string, unknown>) {
    this.argumentsValue = argumentsValue;
  }

  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "large-arg-call",
          name: "record_large_arg",
          arguments: this.argumentsValue,
        }],
      };
    }
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }
}

class ConversationIntentModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  readonly executionToolCounts: number[] = [];
  classifierSawSkillCatalog = false;
  classifierCalls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.tools[0]?.name === "classify_conversation_intent") {
      this.classifierCalls += 1;
      this.classifierSawSkillCatalog = /pptx|presentation workflow/i.test(request.systemPrompt);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "intent",
          name: "classify_conversation_intent",
          arguments: { kind: "reply" },
        }],
      };
    }
    this.executionToolCounts.push(request.tools.length);
    return {
      content: "No Skill was loaded; the presentation was produced with generic file and command tools.",
      finishReason: "stop",
      toolCalls: [],
    };
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

async function getJson(base: string, path: string, token: string): Promise<unknown> {
  const response = await fetch(base + path, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200, `GET ${path} failed with ${response.status}`);
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
