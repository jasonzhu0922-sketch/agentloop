import assert from "node:assert/strict";
import test from "node:test";
import { reconstructRecoveryTranscript } from "../src/runtime/recovery-transcript.ts";
import type { RecoveryEvent } from "../src/runtime/recovery-transcript.ts";

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
