import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse, ModelStreamSink, ModelToolCall, RuntimeEvent } from "../src/runtime/contracts.ts";
import { ResponsesModel, OpenAICompatibleModel } from "../src/runtime/models.ts";
import { OrderedExecutionScheduler } from "../src/shared/concurrency.ts";
import { ToolRegistry, type RuntimeTool } from "../src/tools/tool-registry.ts";
import { TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

const done: ModelResponse = { content: "done", finishReason: "stop", toolCalls: [] };
const grant = (names: string[]) => createCapabilityGrant({ actorUserId: "scheduler-test", runId: "scheduler-run",
  depth: 0, allowedToolNames: names, allowedSkillIds: [] });
const tool = (name: string, mode: "parallel" | "exclusive", execute: () => Promise<unknown>): RuntimeTool => ({
  name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: false },
  executionMode: mode, replaySafe: true, parse: (input) => input, execute,
});

for (const streaming of [false, true]) {
  test(`${streaming ? "streaming" : "ordinary"} dispatch shares bounded parallel groups and exclusive barriers`, { timeout: 4000 }, async () => {
    const names = ["read_a", "read_b", "read_c", "write_a", "write_b", "read_d", "read_e"];
    const modes = ["parallel", "parallel", "parallel", "exclusive", "exclusive", "parallel", "parallel"] as const;
    const gates = names.map(() => Promise.withResolvers<void>());
    const starts = names.map(() => Promise.withResolvers<void>());
    const events: RuntimeEvent[] = [];
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    let modelCalls = 0;
    let streamEnded = false;
    const calls: ModelToolCall[] = names.map((name) => ({ id: `call-${name}`, name, arguments: {} }));
    const tools = names.map((name, index) => tool(name, modes[index]!, async () => {
      if (modes[index] === "exclusive") assert.equal(active, 0, `${name} overlaps earlier work`);
      active += 1;
      peak = Math.max(peak, active);
      order.push(`start:${name}`);
      starts[index]!.resolve();
      await gates[index]!.promise;
      order.push(`end:${name}`);
      active -= 1;
      return name;
    }));
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async () => ++modelCalls === 1 ? { content: "", finishReason: "tool_calls", toolCalls: calls } : done,
      ...(streaming ? { streamComplete: async (_request: ModelInvocation, sink: ModelStreamSink): Promise<ModelResponse> => {
        if (++modelCalls > 1) return done;
        for (let index = 0; index < calls.length; index += 1) {
          await sink({ type: "tool_call_ready", index, ...calls[index]! });
        }
        // A blocked exclusive queue must not block consumption of later deltas.
        await sink({ type: "text_delta", text: "remaining stream consumed" });
        await starts[0]!.promise;
        assert.equal(streamEnded, false);
        streamEnded = true;
        return { content: "", finishReason: "tool_calls", toolCalls: calls };
      } } : {}),
    };
    const running = runAgentLoop({ runId: "scheduler-run", systemPrompt: "Test scheduling", input: "Run the calls",
      model, tools: new ToolRegistry(tools), grant: grant(names), maxSteps: 3, maxParallelToolCalls: 2,
      emit: (event) => { events.push(event); } });
    try {
      await Promise.all([starts[0]!.promise, starts[1]!.promise]);
      assert.deepEqual(order, ["start:read_a", "start:read_b"]);
      gates[1]!.resolve();
      await starts[2]!.promise;
      assert.equal(order.includes("start:write_a"), false);
      gates[2]!.resolve();
      gates[0]!.resolve();
      await starts[3]!.promise;
      assert.equal(order.includes("start:write_b"), false);
      assert.equal(order.includes("start:read_d"), false);
      gates[3]!.resolve();
      await starts[4]!.promise;
      assert.equal(order.includes("start:read_d"), false);
      gates[4]!.resolve();
      await Promise.all([starts[5]!.promise, starts[6]!.promise]);
      gates[6]!.resolve();
      gates[5]!.resolve();
      const result = await running;
      assert.equal(peak, 2);
      assert.deepEqual(result.messages.filter((message) => message.role === "tool").map((message) => message.name), names);
      for (const call of calls) {
        assert.equal(events.filter((event) => event.type === "tool.dispatched" && event.data.toolCallId === call.id).length, 1);
      }
      if (streaming) {
        const started = events.findIndex((event) => event.type === "tool.dispatched");
        const ended = events.findIndex((event) => event.type === "model.request.completed");
        assert.ok(started >= 0 && started < ended, "Tool must start before the provider stream completes");
      }
    } finally {
      for (const gate of gates) gate.resolve();
      await running;
    }
  });
}

test("scheduler releases exclusive barriers after failures and rejects invalid limits", async () => {
  assert.throws(() => new OrderedExecutionScheduler(0), /positive integer/);
  const scheduler = new OrderedExecutionScheduler(2);
  const order: string[] = [];
  const results = await Promise.allSettled([
    scheduler.schedule("parallel", async () => { order.push("read"); throw new Error("read failed"); }),
    scheduler.schedule("exclusive", async () => { order.push("write"); throw new Error("write failed"); }),
    scheduler.schedule("parallel", async () => { order.push("after"); return 3; }),
  ]);
  assert.deepEqual(order, ["read", "write", "after"]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected", "fulfilled"]);
});

test("slow preparation cannot let a later streamed exclusive call overtake its predecessor", { timeout: 4000 }, async () => {
  const planBlocked = Promise.withResolvers<void>();
  const releasePlan = Promise.withResolvers<void>();
  const allReady = Promise.withResolvers<void>();
  const order: string[] = [];
  const calls = ["first", "second"].map((name) => ({ id: name, name, arguments: {} }));
  let turns = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS, complete: async () => { throw new Error("stream expected"); },
    streamComplete: async (_request, sink) => {
      if (++turns > 1) return done;
      for (let index = 0; index < calls.length; index += 1) await sink({ type: "tool_call_ready", index, ...calls[index]! });
      // Duplicate readiness must not enqueue a second effect or consume quota.
      await sink({ type: "tool_call_ready", index: 0, ...calls[0]! });
      allReady.resolve();
      return { content: "", finishReason: "tool_calls", toolCalls: calls };
    },
  };
  const running = runAgentLoop({ runId: "scheduler-run", systemPrompt: "Test", input: "Run calls", model,
    tools: new ToolRegistry(calls.map(({ name }) => tool(name, "exclusive", async () => { order.push(name); return name; }))),
    grant: grant(calls.map(({ name }) => name)), maxSteps: 3, toolCallLimits: { first: 1, second: 1 },
    emit: async (event) => {
      if (event.type === "tool.planned" && event.data.toolCallId === "first") {
        planBlocked.resolve(); await releasePlan.promise;
      }
    } });
  try {
    await Promise.all([planBlocked.promise, allReady.promise]);
    assert.deepEqual(order, []);
  } finally { releasePlan.resolve(); }
  const result = await running;
  assert.equal(result.output, "done");
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(result.toolEvidence.length, 2);
});

test("aborting a queued streamed group prevents all later effects", { timeout: 4000 }, async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const effects: string[] = [];
  const calls = ["first", "later"].map((name) => ({ id: name, name, arguments: {} }));
  const running = runAgentLoop({ runId: "scheduler-run", systemPrompt: "Test", input: "Run calls", maxSteps: 3,
    signal: controller.signal, grant: grant(["first", "later"]), tools: new ToolRegistry([
      tool("first", "exclusive", async () => { effects.push("first"); started.resolve(); await release.promise; return "first"; }),
      tool("later", "parallel", async () => { effects.push("later"); return "later"; }),
    ]), model: { limits: TEST_MODEL_LIMITS, complete: async () => done, streamComplete: async (_request, sink) => {
      for (let index = 0; index < calls.length; index += 1) await sink({ type: "tool_call_ready", index, ...calls[index]! });
      return { content: "", finishReason: "tool_calls", toolCalls: calls };
    } } });
  const rejected = assert.rejects(running);
  await started.promise;
  controller.abort();
  release.resolve();
  await rejected;
  assert.deepEqual(effects, ["first"]);
});

const settings = { baseUrl: "https://scheduler.test/v1", apiKey: "test-key", model: "fixture", ...TEST_MODEL_LIMITS, maxAttempts: 1 };
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const callItem = (id: string, name: string) => ({ id: `item-${id}`, type: "function_call", call_id: id, name, arguments: "" });

test("Responses SSE starts Tools before terminal and holds an out-of-order completed call behind its exclusive predecessor", { timeout: 4000 }, async () => {
  const previousFetch = globalThis.fetch;
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondCompleted = Promise.withResolvers<void>();
  const order: string[] = [];
  const events: RuntimeEvent[] = [];
  let requests = 0;
  let terminalSent = false;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests > 1) return new Response(JSON.stringify({ id: "resp-final", status: "completed", output_text: "done" }),
      { headers: { "content-type": "application/json" } });
    return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      const send = (value: unknown) => controller.enqueue(new TextEncoder().encode(sse(value)));
      send({ type: "response.created", response: { id: "resp-scheduled", status: "in_progress", output: [] } });
      send({ type: "response.output_item.added", output_index: 0, item: callItem("write", "write") });
      send({ type: "response.function_call_arguments.delta", item_id: "item-write", output_index: 0, delta: "{" });
      send({ type: "response.output_item.added", output_index: 1, item: callItem("read", "read") });
      send({ type: "response.function_call_arguments.delta", item_id: "item-read", output_index: 1, delta: "{}" });
      send({ type: "response.function_call_arguments.done", item_id: "item-read", output_index: 1, arguments: "{}" });
      // The read is already complete, but the earlier write still owns the barrier.
      send({ type: "response.function_call_arguments.delta", item_id: "item-write", output_index: 0, delta: "}" });
      send({ type: "response.function_call_arguments.done", item_id: "item-write", output_index: 0, arguments: "{}" });
      await firstStarted.promise;
      assert.deepEqual(order, ["write:start"]);
      releaseFirst.resolve();
      await secondCompleted.promise;
      terminalSent = true;
      send({ type: "response.completed", response: { id: "resp-scheduled", status: "completed", output: [
        { ...callItem("write", "write"), arguments: "{}", status: "completed" },
        { ...callItem("read", "read"), arguments: "{}", status: "completed" },
      ] } });
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const result = await runAgentLoop({ runId: "scheduler-run", systemPrompt: "Test", input: "Write then read", maxSteps: 3,
      model: new ResponsesModel(settings), grant: grant(["write", "read"]),
      tools: new ToolRegistry([
        tool("write", "exclusive", async () => {
          assert.equal(terminalSent, false);
          order.push("write:start"); firstStarted.resolve();
          await releaseFirst.promise;
          order.push("write:end"); return "written";
        }),
        tool("read", "parallel", async () => {
          assert.equal(terminalSent, false);
          order.push("read"); secondCompleted.resolve(); return "read";
        }),
      ]), emit: (event) => { events.push(event); } });
    assert.equal(result.output, "done");
    assert.deepEqual(order, ["write:start", "write:end", "read"]);
    const end = events.findIndex((event) => event.type === "model.request.completed");
    for (const id of ["write", "read"]) {
      const starts = events.map((event, index) => ({ event, index })).filter(({ event }) =>
        event.type === "tool.dispatched" && event.data.toolCallId === id);
      assert.equal(starts.length, 1);
      assert.ok(starts[0]!.index < end);
    }
  } finally { releaseFirst.resolve(); globalThis.fetch = previousFetch; }
});

test("Chat Completions never dispatches a merely parseable call before the authoritative stream terminal", { timeout: 4000 }, async () => {
  const previousFetch = globalThis.fetch;
  let terminalSent = false;
  let executions = 0;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    const send = (delta: unknown, finish_reason: string | null) => controller.enqueue(new TextEncoder().encode(sse({
      id: "chat-scheduled", choices: [{ index: 0, delta, finish_reason }],
    })));
    send({ tool_calls: [{ index: 0, id: "lookup", type: "function", function: { name: "read", arguments: "{}" } }] }, null);
    // JSON completeness alone never proves that the provider finished authoring.
    assert.equal(executions, 0);
    send({}, "tool_calls");
    terminalSent = true;
    controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
  try {
    const response = await new OpenAICompatibleModel(settings).streamComplete({ runId: "scheduler-run", phase: "execution", systemPrompt: "Test", messages: [], tools: [
      { name: "read", description: "Read", inputSchema: { type: "object", properties: {} } },
    ] }, (event) => {
      if (event.type === "tool_call_ready") { assert.equal(terminalSent, true); executions += 1; }
    });
    assert.equal(executions, 1);
    assert.equal(response.toolCalls.length, 1);
  } finally { globalThis.fetch = previousFetch; }
});

test("Responses SSE overlaps bounded Tool work with a delayed stream tail", { timeout: 5000 }, async (t) => {
  const previousFetch = globalThis.fetch;
  const measurements: Array<{ mode: string; elapsedMs: number; firstDispatchMs: number; streamCompletedMs: number; peak: number }> = [];
  try {
    for (const early of [false, true]) {
      let requests = 0;
      let active = 0;
      let peak = 0;
      const names = ["lookup_a", "lookup_b", "lookup_c", "lookup_d"];
      globalThis.fetch = async () => {
        if (++requests > 1) return new Response(JSON.stringify({ id: "resp-final", status: "completed", output_text: "done" }),
          { headers: { "content-type": "application/json" } });
        return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
          const send = (value: unknown) => controller.enqueue(new TextEncoder().encode(sse(value)));
          send({ type: "response.created", response: { id: "resp-benchmark", status: "in_progress", output: [] } });
          for (const [index, name] of names.entries()) {
            send({ type: "response.output_item.added", output_index: index, item: callItem(name, name) });
            send({ type: "response.function_call_arguments.delta", item_id: `item-${name}`, output_index: index, delta: "{}" });
            send({ type: "response.function_call_arguments.done", item_id: `item-${name}`, output_index: index, arguments: "{}" });
          }
          // Controlled provider tail; execution is allowed to overlap these 250 ms.
          await new Promise((resolve) => setTimeout(resolve, 250));
          send({ type: "response.completed", response: { id: "resp-benchmark", status: "completed", output:
            names.map((name) => ({ ...callItem(name, name), arguments: "{}", status: "completed" })) } });
          controller.close();
        } }), { headers: { "content-type": "text/event-stream" } });
      };
      const adapter = new ResponsesModel(settings);
      // The complete-only path consumes the same SSE with no early Runtime sink.
      const model: ModelAdapter = early ? adapter : { limits: adapter.limits, complete: adapter.complete.bind(adapter) };
      const started = performance.now();
      let firstDispatchMs = -1;
      let streamCompletedMs = -1;
      const result = await runAgentLoop({ runId: "scheduler-run", systemPrompt: "Test", input: "Look up four independent records",
        model, tools: new ToolRegistry(names.map((name) => tool(name, "parallel", async () => {
          active += 1; peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 100));
          active -= 1; return name;
        }))), grant: grant(names), maxSteps: 3, maxParallelToolCalls: 2,
        emit: (event) => {
          if (event.type === "tool.dispatched" && firstDispatchMs < 0) firstDispatchMs = performance.now() - started;
          if (event.type === "model.request.completed" && streamCompletedMs < 0) streamCompletedMs = performance.now() - started;
        } });
      assert.equal(result.output, "done");
      assert.equal(peak, 2);
      assert.deepEqual(result.messages.filter((message) => message.role === "tool").map((message) => message.name), names);
      assert.equal(firstDispatchMs < streamCompletedMs, early);
      measurements.push({ mode: early ? "early" : "after_stream", elapsedMs: Math.round(performance.now() - started),
        firstDispatchMs: Math.round(firstDispatchMs), streamCompletedMs: Math.round(streamCompletedMs), peak });
    }
    t.diagnostic(`Controlled SSE: ${JSON.stringify(measurements)}`);
  } finally { globalThis.fetch = previousFetch; }
});
