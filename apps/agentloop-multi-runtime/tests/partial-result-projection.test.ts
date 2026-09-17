import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { projectAssistantEvent, replayAssistantEvents } from "../web/assistant-event-projection.js";

const report = "任务未完成，以下仅为阶段性结果。\n\n已取得部分记录，但缺少结构预检证据。";
test("failed terminal event and replay retain partial output without implying success", () => {
  const event = { seq: 42, type: "run.failed", data: { code: "STEP_NOT_COMPLETED", message: "Evidence missing", output: report }, createdAt: 42 };
  const assistant = { status: "running", text: "rejected draft", error: undefined as string | undefined };
  assert.equal(projectAssistantEvent(assistant, event), true);
  assert.equal(assistant.status, "failed");
  assert.equal(assistant.text, report);
  assert.equal(assistant.error, "Evidence missing");
  const restored = { status: "running", text: "" };
  replayAssistantEvents(restored, [event]);
  assert.equal(restored.status, "failed");
  assert.equal(restored.text, report);
});

test("ordinary failed events never expose stale rejected drafts", () => {
  const assistant = { status: "running", text: "unverified draft" };
  projectAssistantEvent(assistant, { type: "run.failed", data: { message: "Failed" } });
  assert.equal(assistant.text, "Failed");
});

// Run the actual browser snapshot function without its DOM/bootstrap side effects.
test("browser reload uses persisted failed output while preserving terminal metadata", () => {
  const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function applyRecoveredRunState(");
  const end = source.indexOf("\nfunction recoveredFailureMessage", start);
  assert.ok(start >= 0 && end > start);
  const restore = runInNewContext(`(${source.slice(start, end).trim()})`, {
    recoveredFailureMessage: () => "Evidence missing",
    completeAssistantMessage: (message: Record<string, unknown>, event: { createdAt: number }) => { message.completedAt = event.createdAt; },
  });
  const assistant = { status: "running", text: "old", completedAt: undefined };
  restore(assistant, { status: "failed", output: report, finishedAt: 42 });
  assert.equal(assistant.status, "failed");
  assert.equal(assistant.text, report);
  assert.equal(assistant.completedAt, 42);
  assert.match(source, /class="partial-result"[\s\S]*?renderMarkdown\(message.text\)/);
});
