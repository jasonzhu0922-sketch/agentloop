import assert from "node:assert/strict";
import test from "node:test";
import { reconstructRecoveryTranscript } from "../src/runtime/recovery-transcript.ts";
import type { RecoveryEvent } from "../src/runtime/recovery-transcript.ts";
import { createDecisionCommit } from "../src/runtime/decision-ledger.ts";

function events(...items: Array<[string, Record<string, unknown>]>): RecoveryEvent[] {
  return items.map(([type, data], index) => ({ seq: index + 1, type, data }));
}

test("repair ancestry replays disjoint Step exchanges with the exact committed Result identity", () => {
  const resultRef = { schema: "agentloop.resultRef/v1", resultId: "rr_11111111-1111-4111-8111-111111111111" };
  const history = events(
    ["plan.step.started", { stepId: "original" }],
    ["assistant.committed", { content: "", toolCalls: [{ id: "fetch", name: "webfetch", arguments: { url: "https://example.test" } }] }],
    ["tool.result_committed", { toolCallId: "fetch", resultRef }],
    ["tool.completed", { toolCallId: "fetch", result: '{"content":"actual source"}' }],
    ["assistant.committed", { content: "REJECTED_NAME", toolCalls: [] }],
    ["plan.step.started", { stepId: "repair" }],
    ["assistant.committed", { content: "", toolCalls: [{ id: "read", name: "read_result", arguments: { resultId: resultRef.resultId } }] }],
    ["tool.completed", { toolCallId: "read", result: '{"content":"continued source"}' }],
    ["plan.step.started", { stepId: "original", recovered: true }],
    ["assistant.committed", { content: "", toolCalls: [{ id: "resumed-read", name: "read_result", arguments: {} }] }],
    ["tool.completed", { toolCallId: "resumed-read", result: '{"content":"resumed original"}' }],
  );
  const original = reconstructRecoveryTranscript({ userInput: "verify", stepId: "original", events: history });
  const repair = reconstructRecoveryTranscript({ userInput: "verify", stepId: "repair", events: history });
  assert.deepEqual(original.toolEvidence.map((item) => item.toolCallId), ["fetch", "resumed-read"]);
  assert.deepEqual(repair.toolEvidence.map((item) => item.toolCallId), ["read"]);
  assert.deepEqual(original.toolEvidence[0]?.resultRef, resultRef);
  assert.deepEqual(JSON.parse(original.toolEvidence[0]!.result).resultRef, resultRef);
  assert.doesNotMatch(JSON.stringify(original.messages), /REJECTED_NAME|continued source/);
  assert.deepEqual(original.facts.candidateOutputs, ["REJECTED_NAME"]);
});

test("recovery preserves Step-scoped rejection decisions without replaying drafts as answers", () => {
  const transcript = reconstructRecoveryTranscript({
    userInput: "Answer the requested facts", stepId: "lookup",
    events: events(
      ["plan.step.started", { stepId: "lookup" }],
      ["candidate.rejected", { output: "Raw source table", feedback: "Synthesize the requested answer." }],
      ["plan.step.started", { stepId: "other" }],
      ["candidate.rejected", { output: "Other draft", feedback: "Other gap" }],
      ["plan.step.started", { stepId: "lookup", recovered: true }],
      ["candidate.rejected", { output: "Second draft", feedback: "Keep exact fields." }],
    ),
  });
  assert.deepEqual(transcript.facts.candidateRejections, [
    { output: "Raw source table", feedback: "Synthesize the requested answer." },
    { output: "Second draft", feedback: "Keep exact fields." },
  ]);
  assert.doesNotMatch(JSON.stringify(transcript.messages), /Raw source table|Second draft|Other draft/);
});

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

test("recovery preserves returned command operation failure separately from invocation completion", () => {
  const result = JSON.stringify({ exitCode: 2, stdout: "", stderr: "syntax error", fileChanges: [] });
  const transcript = reconstructRecoveryTranscript({
    userInput: "build the artifact",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["assistant.committed", {
        step: 1,
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "call-1", name: "computer_run_command", arguments: { command: "node" } }],
      }],
      ["tool.completed", {
        step: 1,
        toolCallId: "call-1",
        toolName: "computer_run_command",
        result,
        invocationStatus: "completed",
        operationStatus: "failed",
        exitCode: 2,
        isError: true,
        failurePhase: "operation",
      }],
    ),
  });

  assert.deepEqual(transcript.messages.at(-1), {
    role: "tool",
    toolCallId: "call-1",
    name: "computer_run_command",
    content: result,
    isError: true,
  });
  assert.deepEqual(transcript.toolEvidence, [{
    toolCallId: "call-1",
    toolName: "computer_run_command",
    result,
    invocationStatus: "completed",
    operationStatus: "failed",
    exitCode: 2,
    isError: true,
    failurePhase: "operation",
  }]);
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

test("recovery restores hidden provider reasoning from the private checkpoint field", () => {
  const transcript = reconstructRecoveryTranscript({
    userInput: "resume the tool call",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["assistant.committed", {
        step: 1,
        content: "",
        finishReason: "tool_calls",
        privateReasoningContent: "opaque-hidden-thinking-state",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "a.txt" } }],
      }],
      ["tool.completed", { step: 1, toolCallId: "call-1", toolName: "read_file", result: "hello" }],
    ),
  });

  assert.equal(transcript.messages[1]?.role, "assistant");
  assert.equal(
    (transcript.messages[1] as { reasoningContent?: string } | undefined)?.reasoningContent,
    "opaque-hidden-thinking-state",
  );
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
    {
      toolCallId: "call-prepare",
      toolName: "write_file",
      result: "invalid args",
      invocationStatus: "rejected",
      operationStatus: "unknown",
      isError: true,
      failurePhase: "prepare",
    },
    {
      toolCallId: "call-execute",
      toolName: "run_step",
      result: "spawn . EACCES",
      invocationStatus: "failed",
      operationStatus: "unknown",
      isError: true,
      failurePhase: "execute",
    },
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
    invocationStatus: "rejected",
    operationStatus: "unknown",
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

test("recovery restores the durable decision ledger without converting it into a mutable user turn", () => {
  const commit = createDecisionCommit({
    requestId: "request-1", requestRevision: 1, stepId: "step-1",
    selectedOptions: [{ id: "selected", label: "Selected", identityRefs: ["identity-1"] }],
  });
  const transcript = reconstructRecoveryTranscript({
    userInput: "do the thing",
    stepId: "step-1",
    events: events(
      ["plan.step.started", { stepId: "step-1" }],
      ["decision.committed", { commit }],
    ),
  });
  assert.deepEqual(transcript.facts.decisionLedger, [commit]);
});
