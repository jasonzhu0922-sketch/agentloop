import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { projectAssistantEvent, replayAssistantEvents } from "../web/assistant-event-projection.js";

const report = "任务未完成，以下仅为阶段性结果。\n\n已取得部分记录，但缺少结构预检证据。";
test("failed terminal event hides Runtime diagnostics and keeps only explicit partial output", () => {
  const event = { seq: 42, type: "run.failed", data: { code: "STEP_NOT_COMPLETED", message: "Evidence missing", output: report }, createdAt: 42 };
  const assistant: { status: string; text: string; error?: string; partialText?: string } = { status: "running", text: "rejected draft", error: undefined };
  assert.equal(projectAssistantEvent(assistant, event), true);
  assert.equal(assistant.status, "failed");
  assert.equal(assistant.text, "");
  assert.equal(assistant.partialText, undefined);
  assert.equal(assistant.error, "本次结果尚未完成最终确认，以下说明可供参考。");
  const restored: { status: string; text: string; error?: string; partialText?: string } = { status: "running", text: "" };
  replayAssistantEvents(restored, [event]);
  assert.equal(restored.status, "failed");
  assert.equal(restored.text, "");
  assert.equal(restored.partialText, undefined);
});

test("explicit partial output is retained without exposing backend messages", () => {
  const assistant: { status: string; text: string; error?: string; partialText?: string } = { status: "running", text: "unverified draft" };
  projectAssistantEvent(assistant, { type: "run.failed", data: { code: "TOOL_EXECUTION_ERROR", message: "secret backend detail", partialOutput: "已生成一个可查看的文件。" } });
  assert.equal(assistant.text, "");
  assert.equal(assistant.partialText, "已生成一个可查看的文件。");
  assert.equal(assistant.error, "部分处理未能继续完成，以下说明可供参考。");
});

// Run the actual browser snapshot function without its DOM/bootstrap side effects.
test("browser reload uses only Host-projected failed output while preserving terminal metadata", () => {
  const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function applyRecoveredRunState(");
  const end = source.indexOf("\nfunction recoveredFailureMessage", start);
  assert.ok(start >= 0 && end > start);
  const restore = runInNewContext(`(${source.slice(start, end).trim()})`, {
    recoveredFailureMessage: () => "Evidence missing",
    completeAssistantMessage: (message: Record<string, unknown>, event: { createdAt: number }) => { message.completedAt = event.createdAt; },
  });
  const assistant: { status: string; text: string; error?: string; partialText?: string; completedAt?: number } = { status: "running", text: "old", completedAt: undefined };
  restore(assistant, { status: "failed", output: "internal diagnostic", partialOutput: report, finishedAt: 42 });
  assert.equal(assistant.status, "failed");
  assert.equal(assistant.text, "");
  assert.equal(assistant.partialText, report);
  assert.equal(assistant.completedAt, 42);
  assert.match(source, /class="partial-result"[\s\S]*?renderMarkdown\(message\.partialText\)/);
});
