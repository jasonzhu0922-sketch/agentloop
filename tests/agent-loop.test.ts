import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import type {
  CapabilityGrant,
  ModelAdapter,
  ModelInvocation,
  ModelResponse,
  ModelStreamSink,
  RuntimeEvent,
} from "../src/runtime/contracts.ts";
import { ToolRegistry } from "../src/runtime/tool-registry.ts";
import type { RuntimeTool } from "../src/runtime/tool-registry.ts";
import { TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

test("parallel tools settle into model source order while completion events stay truthful", async () => {
  const model = new ParallelScenarioModel();
  const events: RuntimeEvent[] = [];
  const registry = new ToolRegistry([
    numberTool("slow_double", 20, (value) => value * 2),
    numberTool("fast_square", 1, (value) => value * value),
  ]);
  const grant = makeGrant(["slow_double", "fast_square"]);

  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Test agent",
    input: "calculate",
    model,
    tools: registry,
    grant,
    maxSteps: 4,
    emit: (event) => events.push(event),
  });

  assert.equal(result.output, "done");
  const toolMessages = result.messages.filter((message) => message.role === "tool");
  assert.deepEqual(toolMessages.map((message) => message.name), ["slow_double", "fast_square"]);
  assert.deepEqual(toolMessages.map((message) => message.content), ["6", "16"]);
  const completionNames = events
    .filter((event) => event.type === "tool.completed")
    .map((event) => event.data.toolName);
  assert.deepEqual(completionNames, ["fast_square", "slow_double"]);
});

test("tool calls from a length-truncated model response are never dispatched", async () => {
  let executions = 0;
  const tool: RuntimeTool<unknown> = {
    name: "unsafe_write",
    description: "A replay-unsafe effect",
    inputSchema: { type: "object" },
    executionMode: "exclusive",
    replaySafe: false,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return "written";
    },
  };
  const model = new TruncatedScenarioModel();
  const grant = makeGrant(["unsafe_write"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Test agent",
    input: "write",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 3,
  });
  assert.equal(result.output, "recovered");
  assert.equal(executions, 0);
  const toolMessage = result.messages.find((message) => message.role === "tool");
  assert.match(toolMessage?.content ?? "", /output limit/);
});

test("the runtime, not model prose, enforces the step budget", async () => {
  const tool: RuntimeTool<unknown> = {
    name: "read_only",
    description: "Read-only test tool",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => ({ ok: true }),
  };
  const grant = makeGrant(["read_only"]);
  const events: RuntimeEvent[] = [];
  await assert.rejects(
    () => runAgentLoop({
      runId: grant.runId,
      systemPrompt: "Never stop",
      input: "loop",
      model: new EndlessToolModel(),
      tools: new ToolRegistry([tool]),
      grant,
      maxSteps: 2,
      emit: (event) => events.push(event),
    }),
    (error: unknown) => error !== null
      && typeof error === "object"
      && "code" in error
      && (error as { code: unknown }).code === "RUN_LIMIT_EXCEEDED",
  );
  assert.equal(events.filter((event) => event.type === "tool.completed").length, 1);
  assert.equal(events.filter((event) => event.type === "loop.convergence_requested").length, 1);
  assert.equal(events.filter((event) => event.type === "tool.rejected").length, 1);
});

test("the final budgeted turn converges without tools and submits existing evidence for assessment", async () => {
  let executions = 0;
  const tool: RuntimeTool<unknown> = {
    name: "collect_evidence",
    description: "Collect canonical evidence",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return { artifact: "ready", qa: "passed" };
    },
  };
  const model = new ConvergenceScenarioModel();
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["collect_evidence"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Complete the admitted step.",
    input: "produce and verify the artifact",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 2,
    emit: (event) => events.push(event),
    evaluateCandidate: async (candidate) => ({
      approved: candidate.output.includes("artifact ready")
        && candidate.toolEvidence.some((item) => item.toolName === "collect_evidence" && !item.isError),
      feedback: "",
    }),
  });

  assert.equal(result.output, "artifact ready; QA passed; evidence: collect_evidence");
  assert.equal(executions, 1);
  assert.equal(model.calls, 2);
  assert.equal(events.filter((event) => event.type === "loop.convergence_requested").length, 1);
  assert.equal(events.filter((event) => event.type === "candidate.approved").length, 1);
  assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
});

test("streaming turns emit live deltas before the durable assistant checkpoint", async () => {
  const events: RuntimeEvent[] = [];
  const tool: RuntimeTool<unknown> = {
    name: "echo",
    description: "Echo a value",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, value) => (value as { value: number }).value,
  };
  const model = new StreamingScenarioModel();
  const grant = makeGrant(["echo"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Stream",
    input: "echo",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 3,
    emit: (event) => events.push(event),
  });

  assert.equal(result.output, "done");
  const streamingEvents = events.filter((event) => event.type === "assistant.streaming");
  assert.equal(streamingEvents.length >= 1, true);
  const committedIndex = events.findIndex((event) => event.type === "assistant.committed");
  assert.equal(committedIndex >= 0, true);
  // Every transient delta must precede the durable checkpoint for that turn.
  const streamingIndices = events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "assistant.streaming")
    .map(({ index }) => index);
  assert.equal(streamingIndices.every((index) => index < committedIndex), true);
  assert.equal(events.some((event) => event.type === "tool.completed"), true);
});

test("tool_call_ready dispatches the tool before the full assistant checkpoint", async () => {
  const events: RuntimeEvent[] = [];
  let executions = 0;
  const tool: RuntimeTool<unknown> = {
    name: "echo",
    description: "Echo a value",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, value) => {
      executions += 1;
      return (value as { value: number }).value;
    },
  };
  const model = new EarlyDispatchModel();
  const grant = makeGrant(["echo"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Early dispatch",
    input: "echo 7",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 3,
    emit: (event) => events.push(event),
  });

  assert.equal(result.output, "done");
  assert.equal(executions, 1);
  const committedIdx = events.findIndex((event) => event.type === "assistant.committed");
  const toolCallCommittedIdx = events.findIndex((event) => event.type === "assistant.tool_call.committed");
  const toolCompletedIdx = events.findIndex((event) => event.type === "tool.completed");
  assert.equal(toolCallCommittedIdx >= 0, true);
  assert.equal(toolCompletedIdx >= 0, true);
  // Per-call checkpoint precedes its effect, which precedes the full checkpoint.
  assert.equal(toolCallCommittedIdx < toolCompletedIdx, true);
  assert.equal(toolCompletedIdx < committedIdx, true);
  const perCallCommit = events[toolCallCommittedIdx];
  assert.equal(perCallCommit.data.toolCallId, "call-echo");
  assert.equal(perCallCommit.data.name, "echo");
  assert.deepEqual(perCallCommit.data.arguments, { value: 7 });
});

test("capability grants are immutable at runtime, not only in TypeScript", () => {
  const grant = createCapabilityGrant({
    actorUserId: "user-1",
    runId: "run-1",
    agentId: "agent-1",
    depth: 0,
    allowedToolNames: ["read"],
    allowedSkillIds: ["skill-1"],
    allowedChildAgentIds: [],
  });
  assert.equal(grant.allowedToolNames.has("read"), true);
  assert.equal("add" in grant.allowedToolNames, false);
  assert.throws(() => {
    (grant.allowedToolNames as unknown as { add(value: string): void }).add("admin");
  }, TypeError);
  assert.equal(grant.allowedToolNames.has("admin"), false);
});

class ParallelScenarioModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "call-slow", name: "slow_double", arguments: { value: 3 } },
          { id: "call-fast", name: "fast_square", arguments: { value: 4 } },
        ],
      };
    }
    const tools = request.messages.filter((message) => message.role === "tool");
    assert.deepEqual(tools.map((message) => message.name), ["slow_double", "fast_square"]);
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }
}

class TruncatedScenarioModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "length",
        toolCalls: [{ id: "call-unsafe", name: "unsafe_write", arguments: { partial: true } }],
      };
    }
    return { content: "recovered", finishReason: "stop", toolCalls: [] };
  }
}

class EndlessToolModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    return {
      content: "I should keep going",
      finishReason: "tool_calls",
      toolCalls: [{ id: `call-${this.calls}`, name: "read_only", arguments: {} }],
    };
  }
}

class ConvergenceScenarioModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["collect_evidence"]);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "collect-1", name: "collect_evidence", arguments: {} }],
      };
    }
    assert.deepEqual(request.tools, []);
    assert.match(request.runtimeContext?.content ?? "", /runtime_convergence/);
    const evidence = request.messages.find((message) => message.role === "tool" && message.name === "collect_evidence");
    assert.match(evidence?.content ?? "", /\"artifact\":\"ready\"/);
    return {
      content: "artifact ready; QA passed; evidence: collect_evidence",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class EarlyDispatchModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(): Promise<ModelResponse> {
    return this.next();
  }

  async streamComplete(_request: ModelInvocation, sink: ModelStreamSink): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      await sink({ type: "text_delta", text: "echoing" });
      await sink({ type: "tool_call_ready", index: 0, id: "call-echo", name: "echo", arguments: { value: 7 } });
      return {
        content: "echoing",
        finishReason: "tool_calls",
        toolCalls: [{ id: "call-echo", name: "echo", arguments: { value: 7 } }],
      };
    }
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }

  private next(): ModelResponse {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "call-echo", name: "echo", arguments: { value: 7 } }],
      };
    }
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }
}

class StreamingScenarioModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(): Promise<ModelResponse> {
    return this.next();
  }

  async streamComplete(
    _request: ModelInvocation,
    sink: (event: { type: "text_delta"; text: string } | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta: string }) => Promise<void> | void,
  ): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      await sink({ type: "text_delta", text: "echoing " });
      await sink({ type: "text_delta", text: "value" });
      await sink({ type: "tool_call_delta", index: 0, id: "call-echo", name: "echo", argumentsDelta: "{\"value\":7}" });
      return { content: "echoing value", finishReason: "tool_calls", toolCalls: [{ id: "call-echo", name: "echo", arguments: { value: 7 } }] };
    }
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }

  private next(): ModelResponse {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "call-echo", name: "echo", arguments: { value: 7 } }],
      };
    }
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }
}

function numberTool(
  name: string,
  delayMs: number,
  operation: (value: number) => number,
): RuntimeTool<unknown> {
  return {
    name,
    description: name,
    inputSchema: {
      type: "object",
      required: ["value"],
      properties: { value: { type: "number" } },
    },
    executionMode: "parallel",
    replaySafe: true,
    parse: (input) => {
      if (input === null || typeof input !== "object" || !("value" in input)) throw new Error("value is required");
      const value = (input as { value: unknown }).value;
      if (typeof value !== "number") throw new Error("value must be a number");
      return { value };
    },
    execute: async (_context, input) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return operation((input as { value: number }).value);
    },
  };
}

function makeGrant(toolNames: readonly string[]): CapabilityGrant {
  return {
    actorUserId: "user-1",
    runId: "run-1",
    agentId: "agent-1",
    depth: 0,
    allowedToolNames: new Set(toolNames),
    allowedSkillIds: new Set(),
    allowedChildAgentIds: new Set(),
  };
}
