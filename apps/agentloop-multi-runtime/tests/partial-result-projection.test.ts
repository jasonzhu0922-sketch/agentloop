import { artifactVerificationLabel, isFinalDeliveryArtifact } from "../web/client/presentation/artifact-display.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { projectAssistantEvent, replayAssistantEvents } from "../web/client/projections/assistant-event-projection.js";
import { assistantMessagePresentation } from "../web/client/presentation/assistant-message-presentation.js";

const report = "已提取 12 条记录，但其中 3 条缺少日期，暂时无法计算月度趋势。";
test("failed terminal event keeps its persisted final report separate from the failure status", () => {
  const event = { seq: 42, type: "run.failed", data: { code: "STEP_NOT_COMPLETED", message: "Evidence missing", output: report }, createdAt: 42 };
  const assistant: { status: string; text: string; error?: string; partialText?: string } = { status: "running", text: "rejected draft", error: undefined };
  assert.equal(projectAssistantEvent(assistant, event), true);
  assert.equal(assistant.status, "failed");
  assert.equal(assistant.text, "");
  assert.equal(assistant.partialText, report);
  assert.equal(assistant.error, "本次结果未通过最终验收。");
  const restored: { status: string; text: string; error?: string; partialText?: string } = { status: "running", text: "" };
  replayAssistantEvents(restored, [event]);
  assert.equal(restored.status, "failed");
  assert.equal(restored.text, "");
  assert.equal(restored.partialText, report);
});

test("explicit partial output is retained without exposing backend messages", () => {
  const assistant: { status: string; text: string; error?: string; partialText?: string } = { status: "running", text: "unverified draft" };
  projectAssistantEvent(assistant, { type: "run.failed", data: { code: "TOOL_EXECUTION_ERROR", message: "secret backend detail", partialOutput: "已生成一个可查看的文件。" } });
  assert.equal(assistant.text, "");
  assert.equal(assistant.partialText, "已生成一个可查看的文件。");
  assert.equal(assistant.error, "处理未能继续完成。");
});

// Run the actual browser snapshot function without its DOM/bootstrap side effects.
test("browser reload restores a failed Run's persisted final report", () => {
  const source = readFileSync(new URL("../web/client/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function applyRecoveredRunState(");
  const end = source.indexOf("\nfunction recoveredFailureMessage", start);
  assert.ok(start >= 0 && end > start);
  const restore = runInNewContext(`(${source.slice(start, end).trim()})`, {
    recoveredFailureMessage: () => "Evidence missing",
    completeAssistantMessage: (message: Record<string, unknown>, event: { createdAt: number }) => { message.completedAt = event.createdAt; },
  });
  const assistant: { status: string; text: string; error?: string; partialText?: string; completedAt?: number } = { status: "running", text: "old", completedAt: undefined };
  restore(assistant, { status: "failed", output: report, partialOutput: "fallback report", finishedAt: 42 });
  assert.equal(assistant.status, "failed");
  assert.equal(assistant.text, "");
  assert.equal(assistant.partialText, report);
  assert.equal(assistant.completedAt, 42);
});

test("failed message shows its report once with the failure status and no boilerplate wrappers", () => {
  const source = readFileSync(new URL("../web/client/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderMessage(");
  const end = source.indexOf("\nfunction renderRoundHistory", start);
  assert.ok(start >= 0 && end > start);
  const empty = () => "";
  const render = runInNewContext(`(${source.slice(start, end).trim()})`, {
    assistantMessagePresentation, selectedAssistantMessage: empty, activeConversation: empty,
    projectPlanStatuses: () => [], renderExecutionProvenance: empty, renderHumanLoop: empty,
    renderRecovery: () => '<button>查看恢复选项</button>', completedArtifactSummary: empty,
    renderMarkdown: (value: string) => `<p>${value}</p>`, formatText: String, escapeHtml: String,
    formatMessageTime: empty, formatConversationDuration: empty, renderLiveEventIndicator: empty,
    renderMessageFooter: empty, renderRoundHistory: empty, renderExecutionTrace: empty,
    renderInlineArtifacts: empty, renderSteerMessages: empty,
  });
  const message = { id: "failed-report", status: "failed", error: "通用错误说明", partialText: report };
  const html = render(message);
  assert.match(html, /assistant-state failed/);
  assert.match(html, /AgentLoop · 未完成/);
  assert.equal(html.split(report).length - 1, 1);
  assert.match(html, /查看恢复选项/);
  assert.doesNotMatch(html, /通用错误说明|failure-title|执行总结|阶段性说明|尚非成功交付/);
  for (const partialText of [undefined, "   "]) {
    const emptyHtml = render({ ...message, partialText });
    assert.match(emptyHtml, /class="failure-title">通用错误说明/);
    assert.doesNotMatch(emptyHtml, /class="partial-result"/);
  }
});


test("artifact cards disclose observed verification scope and retain stage-file actions", () => {
  const source = readFileSync(new URL("../web/client/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderArtifactCard(");
  const end = source.indexOf("\nfunction renderExecutionTrace", start);
  const render = runInNewContext(`(${source.slice(start, end).trim()})`, {
    escapeHtml: (value: unknown) => String(value).replaceAll("<", "&lt;"), formatBytes: (value: unknown) => `${value} B`,
    artifactVerificationLabel, isFinalDeliveryArtifact,
  });
  const stage = { id: "file", role: "process", name: "report.html", bytes: 20, previewable: true,
    verification: { file: "verified", result: "unverified", delivery: "uncommitted", limitations: ["Requested comparison is unverified"] } as const };
  const markup = render(stage, "assistant", "failed");
  assert.match(markup, /阶段产物/);
  assert.match(markup, /文件检查通过，结果尚未验收/);
  assert.match(markup, /Requested comparison is unverified/);
  assert.match(markup, /data-artifact-preview="file"/);
  assert.match(markup, /data-artifact-download="file"/);
  assert.equal(isFinalDeliveryArtifact({ ...stage, role: "final" }), false);
  assert.equal(isFinalDeliveryArtifact({ ...stage, role: "final", verification: { delivery: "committed" } }), true);
});
