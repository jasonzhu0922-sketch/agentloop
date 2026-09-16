import assert from "node:assert/strict";
import test from "node:test";
import { reconstructRecoveryTranscript } from "../src/runtime/recovery-transcript.ts";
import type { RecoveryEvent } from "../src/runtime/recovery-transcript.ts";
import { ContextAssembler, type ContextProjectionCheckpoint } from "../src/runtime/context-assembler.ts";
import type { ModelAdapter, ModelMessage, RuntimeEvent } from "../src/runtime/contracts.ts";

function events(...items: Array<[string, Record<string, unknown>]>): RecoveryEvent[] {
  return items.map(([type, data], index) => ({ seq: index + 1, type, data }));
}

test("recovery reconstructs early-dispatched tool calls whose turn never committed", () => {
  const transcript = reconstructRecoveryTranscript({
    userInput: "do the thing",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["assistant.tool_call.committed", { step: 1, toolCallId: "call-1", name: "read_file", arguments: { path: "a.txt" } }],
      ["tool.completed", { step: 1, toolCallId: "call-1", toolName: "read_file", result: "hello" }],
    ),
  });

  assert.deepEqual(transcript.messages, [
    { role: "user", content: "do the thing" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "a.txt" } }],
    },
    { role: "tool", toolCallId: "call-1", name: "read_file", content: "hello", isError: false },
  ]);
  assert.deepEqual(transcript.toolEvidence, [
    { toolCallId: "call-1", toolName: "read_file", result: "hello", isError: false },
  ]);
  assert.deepEqual(transcript.facts.unfinishedToolCalls, []);
});

test("recovery marks orphan early-dispatched tool calls without an outcome as unfinished", () => {
  const transcript = reconstructRecoveryTranscript({
    userInput: "do the thing",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["assistant.tool_call.committed", { step: 1, toolCallId: "call-1", name: "write_file", arguments: { path: "b.txt" } }],
    ),
  });

  assert.deepEqual(transcript.facts.unfinishedToolCalls, [
    { toolCallId: "call-1", toolName: "write_file" },
  ]);
  assert.equal(transcript.messages.length, 1); // only the user turn
});

test("recovery keeps the committed assistant path unchanged when the full checkpoint is present", () => {
  const transcript = reconstructRecoveryTranscript({
    userInput: "do the thing",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["assistant.committed", { step: 1, content: "", finishReason: "tool_calls", toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "a.txt" } }] }],
      ["tool.completed", { step: 1, toolCallId: "call-1", toolName: "read_file", result: "hello" }],
    ),
  });

  assert.deepEqual(transcript.messages, [
    { role: "user", content: "do the thing" },
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "a.txt" } }] },
    { role: "tool", toolCallId: "call-1", name: "read_file", content: "hello", isError: false },
  ]);
});

test("recovery preserves an oversized Tool result locator without rehydrating its full content", () => {
  const locator = "tool-result://11111111-1111-1111-1111-111111111111";
  const sha256 = "a".repeat(64);
  const transcript = reconstructRecoveryTranscript({
    userInput: "inspect the large result",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["assistant.committed", {
        step: 1,
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "call-1", name: "large_tool", arguments: {} }],
      }],
      ["tool.completed", {
        step: 1,
        toolCallId: "call-1",
        toolName: "large_tool",
        result: "HEAD\n… projected …\nTAIL",
        resultRef: { locator, sha256, characters: 2_000_000 },
      }],
    ),
  });

  const result = transcript.messages.at(-1);
  assert.equal(result?.role, "tool");
  assert.match(result?.role === "tool" ? result.content : "", /HEAD/);
  assert.deepEqual(result?.role === "tool" ? result.resultRef : undefined, {
    locator,
    sha256,
    characters: 2_000_000,
  });
  assert.doesNotMatch(result?.role === "tool" ? result.content : "", /x{1000}/);
});

test("recovery selects the latest durable Context Projection checkpoint", () => {
  const checkpoint = (revision: number, sourceEventSeq: number): ContextProjectionCheckpoint => ({
    schema: "agentloop.contextProjection/v1",
    runId: "run-1",
    sourceEventSeq,
    revision,
    contextEpoch: 1,
    firstKeptMessageIndex: 0,
    canonicalMessageCount: 1,
    canonicalPrefixSha256: "a".repeat(64),
    projectionSha256: "b".repeat(64),
    systemPromptSha256: "c".repeat(64),
    runtimeContextSha256: "d".repeat(64),
    toolCatalogSha256: "e".repeat(64),
    estimatedInputTokens: 100,
    projectedToolResults: [],
    activeSkillNames: [],
    expiredSkillNames: [],
  });
  const latest = checkpoint(2, 3);
  const transcript = reconstructRecoveryTranscript({
    userInput: "continue",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["context.projection.committed", { checkpoint: checkpoint(1, 2) }],
      ["context.projection.committed", { checkpoint: latest }],
    ),
  });

  assert.deepEqual(transcript.contextProjection, latest);
});

test("recovery rebuilds HIL and later no-tool assistant messages in event order and passes checkpoint validation", async () => {
  const hilMessage: ModelMessage = {
    role: "user",
    content: "Human-in-the-Loop response: [\"option-1\"]",
  };
  const canonical: ModelMessage[] = [
    { role: "user", content: "continue" },
    hilMessage,
    { role: "assistant", content: "candidate after the answer" },
  ];
  const emitted: RuntimeEvent[] = [];
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 32_000, maxOutputTokens: 2_000 },
    complete: async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
  };
  const options = {
    runId: "run-event-order",
    systemPrompt: "system",
    runtimeContext: { phase: "execution" as const, content: "runtime" },
    model,
  };
  await new ContextAssembler({ ...options, emit: (event) => { emitted.push(event); } }).assemble(canonical, []);
  const raw = emitted.find((event) => event.type === "context.projection.committed")?.data.checkpoint as ContextProjectionCheckpoint;
  const checkpoint = { ...raw, sourceEventSeq: 5 };
  const transcript = reconstructRecoveryTranscript({
    userInput: "continue",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["run.waiting_user", { requestId: "request-1" }],
      ["human_loop.answered", { requestId: "request-1", value: ["option-1"] }],
      ["assistant.committed", { content: "candidate after the answer", finishReason: "stop", toolCalls: [] }],
      ["context.projection.committed", { checkpoint }],
    ),
  });

  assert.deepEqual(transcript.messages, canonical);
  const restored = new ContextAssembler({ ...options, checkpoint: transcript.contextProjection });
  await restored.assemble(transcript.messages, []);
  assert.equal(restored.projectionRevision, 2);
});

test("recovery removes rejected no-tool candidates before a later checkpoint", () => {
  const transcript = reconstructRecoveryTranscript({
    userInput: "repair",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["assistant.committed", { content: "not good enough", finishReason: "stop", toolCalls: [] }],
      ["candidate.rejected", { output: "not good enough", feedback: "missing evidence" }],
    ),
  });
  assert.deepEqual(transcript.messages, [{ role: "user", content: "repair" }]);
  assert.deepEqual(transcript.facts.candidateOutputs, ["not good enough"]);
});

test("recovery rejects damaged, unsupported, or non-monotonic persisted checkpoints", () => {
  const base: ContextProjectionCheckpoint = {
    schema: "agentloop.contextProjection/v1",
    runId: "run-1",
    sourceEventSeq: 2,
    revision: 1,
    contextEpoch: 0,
    firstKeptMessageIndex: 0,
    canonicalMessageCount: 1,
    canonicalPrefixSha256: "a".repeat(64),
    projectionSha256: "b".repeat(64),
    systemPromptSha256: "c".repeat(64),
    runtimeContextSha256: "d".repeat(64),
    toolCatalogSha256: "e".repeat(64),
    estimatedInputTokens: 10,
    projectedToolResults: [],
    activeSkillNames: [],
    expiredSkillNames: [],
  };
  const run = (checkpointEvents: Array<[string, Record<string, unknown>]>) => reconstructRecoveryTranscript({
    userInput: "continue",
    stepId: "step-1",
    events: events(["plan.step.started", { stepId: "step-1" }], ...checkpointEvents),
  });

  assert.throws(
    () => run([["context.projection.committed", { checkpoint: { ...base, projectedToolResults: null } }]]),
    /projected Tool results are invalid/,
  );
  assert.throws(
    () => run([["context.projection.committed", { checkpoint: { ...base, schema: "agentloop.contextProjection/v2" } }]]),
    /schema is missing or unsupported/,
  );
  assert.throws(
    () => run([
      ["context.projection.committed", { checkpoint: base }],
      ["context.projection.committed", { checkpoint: { ...base, sourceEventSeq: 3 } }],
    ]),
    /revisions are not strictly increasing/,
  );
});

test("recovery preserves committed provider reasoning continuation", () => {
  const transcript = reconstructRecoveryTranscript({
    userInput: "repair the rejected candidate",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["assistant.committed", {
        step: 1,
        content: "",
        finishReason: "tool_calls",
        reasoningContent: "opaque-thinking-state",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "a.txt" } }],
      }],
      ["tool.completed", { step: 1, toolCallId: "call-1", toolName: "read_file", result: "hello" }],
    ),
  });

  assert.deepEqual(transcript.messages[1], {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "a.txt" } }],
    reasoningContent: "opaque-thinking-state",
  });
});

test("recovery preserves tool failure phase for prepare and execute failures", () => {
  const transcript = reconstructRecoveryTranscript({
    userInput: "do the thing",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["assistant.committed", {
        step: 1,
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "call-prepare", name: "write_file", arguments: { path: "a.txt" } },
          { id: "call-execute", name: "run_step", arguments: { action: "build" } },
        ],
      }],
      ["tool.rejected", { step: 1, toolCallId: "call-prepare", toolName: "write_file", reason: "invalid args", failurePhase: "prepare" }],
      ["tool.failed", { step: 1, toolCallId: "call-execute", toolName: "run_step", error: "spawn . EACCES" }],
    ),
  });

  assert.deepEqual(transcript.toolEvidence, [
    { toolCallId: "call-prepare", toolName: "write_file", result: "invalid args", isError: true, failurePhase: "prepare" },
    { toolCallId: "call-execute", toolName: "run_step", result: "spawn . EACCES", isError: true, failurePhase: "execute" },
  ]);
});

test("recovery keeps truncated or malformed tool calls out of the provider transcript", () => {
  const transcript = reconstructRecoveryTranscript({
    userInput: "build the deck",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["assistant.committed", {
        step: 1,
        content: "I will write the deck.",
        finishReason: "length",
        toolCalls: [{ id: "call-partial", name: "write_file", arguments: "{\"path\":\"deck.js\"" }],
        providerReplayableToolCallIds: [],
      }],
      ["tool.rejected", {
        step: 1,
        toolCallId: "call-partial",
        toolName: "write_file",
        reason: "Tool call was not executed because the model response hit its output limit",
        failurePhase: "runtime",
      }],
    ),
  });

  assert.deepEqual(transcript.messages, [{ role: "user", content: "build the deck" }]);
  assert.deepEqual(transcript.toolEvidence, [{
    toolCallId: "call-partial",
    toolName: "write_file",
    result: "Tool call was not executed because the model response hit its output limit",
    isError: true,
    failurePhase: "runtime",
  }]);
  assert.deepEqual(transcript.facts.unfinishedToolCalls, []);
});

test("recovery resolves selected HIL options from the persisted waiting-request snapshot", () => {
  const transcript = reconstructRecoveryTranscript({
    userInput: "查询企业信息",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["run.waiting_user", {
        requestId: "request-1",
        request: {
          schema: "agentloop.humanLoopRequest/v1",
          kind: "selection",
          title: "请选择企业",
          prompt: "请选择要继续查询的企业主体。",
          responseSchema: {
            type: "select",
            minSelections: 1,
            maxSelections: 1,
            options: [{
              id: "company-1",
              label: "中国平安保险（集团）股份有限公司",
              description: "统一社会信用代码：91440300100012316L",
              evidenceRefs: ["search-result-1"],
            }],
          },
        },
      }],
      ["human_loop.answered", { requestId: "request-1", value: ["company-1"] }],
    ),
  });

  assert.deepEqual(transcript.messages.at(-1), {
    role: "user",
    content: "Human-in-the-Loop resolution: " + JSON.stringify({
      schema: "agentloop.humanLoopResolution/v1",
      request: {
        kind: "selection",
        title: "请选择企业",
        prompt: "请选择要继续查询的企业主体。",
        responseSchema: { type: "select" },
      },
      value: ["company-1"],
      selectedOptions: [{
        id: "company-1",
        label: "中国平安保险（集团）股份有限公司",
        description: "统一社会信用代码：91440300100012316L",
        evidenceRefs: ["search-result-1"],
      }],
    }),
  });
});

test("recovery keeps the legacy raw HIL value when historical events lack a request snapshot", () => {
  const transcript = reconstructRecoveryTranscript({
    userInput: "do the thing",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["human_loop.answered", { requestId: "old-request", value: ["option-1"] }],
    ),
  });

  assert.deepEqual(transcript.messages.at(-1), {
    role: "user",
    content: "Human-in-the-Loop response: [\"option-1\"]",
  });
});
