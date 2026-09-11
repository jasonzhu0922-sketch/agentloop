import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FileAttachmentBroker } from "../src/attachments/attachment-broker.ts";
import { SharedFilesystemAttachmentBroker } from "../src/attachments/shared-filesystem-attachment-broker.ts";
import { MultiRuntimeRouter, RuntimeCapacityError } from "../src/control-plane/router.ts";
import { AgentLoopRuntimeHost } from "../src/runtime/runtime-host.ts";
import { HttpResourceImporter } from "../src/runtime/http-resource-importer.ts";
import {
  mergeSkillDirectories,
  loadSkillDirectoriesConfig,
  loadStepExecutionStrategyProfileConfig,
  parseMultiRuntimeConfig,
  parseSkillDirectoriesConfig,
  parseStepExecutionStrategyProfileConfig,
  resolveSkillDirectoriesConfig,
} from "../src/config/config.ts";
import { assertRuntimeDispatchEnvelope } from "../src/runtime/runtime-host.ts";
import { assignmentIdFromPath, bindRouterEvents, streamEvents, taskFromRequest, webOriginMatches } from "../src/http/router-http.ts";
import { cancellationTarget, persistedCancellableAssistant } from "../web/cancellation-target.js";
import { EventEmitter } from "node:events";
import { AppDatabase } from "@zhujun/agentloop";
import { ControlPlaneStore, RuntimeCapacityError as PersistentRuntimeCapacityError } from "../src/control-plane/control-plane-store.ts";
import { PersistentMultiRuntimeRouter } from "../src/control-plane/persistent-router.ts";
import { HostDispatchStore } from "../src/runtime/host-dispatch-store.ts";
import { stateDatabaseConfigFromEnvironment } from "../src/storage/state-database.ts";
import type { RuntimeDispatchEnvelope, RuntimeEndpoint, RuntimeInstance } from "../src/domain/contracts.ts";
import { hasIncompleteCompletedPlan, mergeRuntimeEvents, projectAssistantEvent, replayAssistantEvents } from "../web/assistant-event-projection.js";
import { createCoalescedUpdater } from "../web/live-update-scheduler.js";
import { persistSessions } from "../web/session-persistence.js";
import { renderMarkdown } from "../web/markdown-renderer.js";
// @ts-expect-error The Web server is a plain Node module and is intentionally tested without a build step.
import { runtimeConfigScript } from "../web/server.mjs";

function runtime(id: string, overrides: Partial<RuntimeInstance> = {}): RuntimeInstance {
  return {
    id,
    profile: "general",
    capabilities: ["document"],
    maxConcurrentRuns: 1,
    activeRunCount: 0,
    status: "ready",
    ...overrides,
  };
}

async function localModuleClosure(entry: string, files = new Set<string>()): Promise<Set<string>> {
  if (files.has(entry)) return files;
  files.add(entry);
  const source = await readFile(entry, "utf8");
  const imports = source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g);
  for (const match of imports) {
    const specifier = match[1];
    if (specifier === undefined || !specifier.startsWith(".")) continue;
    await localModuleClosure(resolve(dirname(entry), specifier), files);
  }
  return files;
}

test("shared state configuration switches between local SQLite and PostgreSQL without changing Host code", () => {
  assert.deepEqual(stateDatabaseConfigFromEnvironment({
    environment: {}, appRoot: "/application", sqliteFallbackPath: "./data/legacy.db",
  }), { driver: "sqlite", databasePath: "/application/data/legacy.db" });
  assert.deepEqual(stateDatabaseConfigFromEnvironment({
    environment: { AGENTLOOP_STATE_DRIVER: "sqlite", AGENTLOOP_STATE_SQLITE_PATH: "./data/shared.db" },
    appRoot: "/application", sqliteFallbackPath: "./data/legacy.db",
  }), { driver: "sqlite", databasePath: "/application/data/shared.db" });
  assert.deepEqual(stateDatabaseConfigFromEnvironment({
    environment: {
      AGENTLOOP_STATE_DRIVER: "postgres",
      AGENTLOOP_STATE_DATABASE_URL: "postgresql://agentloop@db/agentloop",
      AGENTLOOP_STATE_POOL_SIZE: "8",
    },
    appRoot: "/application", sqliteFallbackPath: "./data/legacy.db",
  }), { driver: "postgres", connectionString: "postgresql://agentloop@db/agentloop", poolSize: 8 });
  assert.throws(
    () => stateDatabaseConfigFromEnvironment({ environment: { AGENTLOOP_STATE_DRIVER: "postgres" }, appRoot: "/application", sqliteFallbackPath: "./data/legacy.db" }),
    /AGENTLOOP_STATE_DATABASE_URL/,
  );
});

test("Router and Runtime Host remain isolated deployment dependency closures", async () => {
  const routerFiles = await localModuleClosure(fileURLToPath(new URL("../src/entrypoints/router-main.ts", import.meta.url)));
  const hostFiles = await localModuleClosure(fileURLToPath(new URL("../src/entrypoints/runtime-host-main.ts", import.meta.url)));
  assert.equal([...routerFiles].some((path) => path.includes("/src/runtime/")), false, "Router must not import Runtime Host execution");
  assert.equal([...hostFiles].some((path) => path.includes("/src/control-plane/") || path.endsWith("/src/http/router-http.ts")), false, "Runtime Host must not import Router control-plane code");
});

test("Web runtime config preserves the launcher-selected Router URL", () => {
  const script = runtimeConfigScript("http://127.0.0.1:9888/");
  assert.match(script, /AGENTLOOP_ROUTER_URL/);
  assert.ok(script.includes('"http://127.0.0.1:9888/"'));
  assert.doesNotMatch(script, /8788/);
});

test("Web source disables caching so Router and browser protocol changes deploy together", async () => {
  const server = await readFile(new URL("../web/server.mjs", import.meta.url), "utf8");
  assert.match(server, /response\.setHeader\("cache-control", "no-store"\)/);
});

test("Web leaves conversation classification to the Runtime", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /conversationIntent/);
});

test("Web uses the shared format-aware preview component instead of text-only artifact output", async () => {
  const [html, app, server, overrides] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /artifact-preview\.js/);
  assert.match(app, /import \{ openArtifactPreview \} from "\.\/artifact-preview\.js"/);
  assert.match(app, /fetchStructuredPreview/);
  assert.match(app, /fetchBytes/);
  assert.doesNotMatch(app, /function previewText\(/);
  assert.match(server, /packages\/agentloop-artifact-preview\/dist\/index\.js/);
  assert.match(overrides, /\.preview-backdrop/);
  assert.match(overrides, /\.preview-slide-canvas/);
});

test("Runtime Hosts load only an explicit built-in step execution profile", async () => {
  const configured = parseStepExecutionStrategyProfileConfig(JSON.stringify({
    schema: "agentloop.stepExecutionStrategyConfig/v1",
    profile: "action-aware",
    projection: { diagnosticProjectionCharacters: 3000 },
  }));
  assert.equal(configured.profile, "action-aware");
  assert.equal(configured.projection.diagnosticProjectionCharacters, 3000);
  assert.throws(
    () => parseStepExecutionStrategyProfileConfig(JSON.stringify({
      schema: "agentloop.stepExecutionStrategyConfig/v1",
      profile: "action-aware",
      module: "./untrusted-strategy.mjs",
    })),
    /unsupported step execution strategy config field: module/,
  );

  const directory = await mkdtemp(join(tmpdir(), "agentloop-step-execution-"));
  const configPath = join(directory, "step-execution-strategy.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schema: "agentloop.stepExecutionStrategyConfig/v1",
      profile: "action-aware",
      projection: { terminalPreviewCharacters: 600 },
    }), "utf8");
    const loaded = await loadStepExecutionStrategyProfileConfig(configPath);
    assert.equal(loaded.profile, "action-aware");
    assert.equal(loaded.projection.terminalPreviewCharacters, 600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("execution details reserve the side panel for observable execution evidence", async () => {
  const [html, app, overrides] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(html, /details-reasoning|<h3>模型思考<\/h3>/);
  assert.doesNotMatch(app, /details-reasoning/);
  assert.match(app, /const reasoning = isLive && message\.reasoning/);
  assert.match(app, /assistant\.reasoning = ""/);
  assert.match(app, /class="live-step-toggle"/);
  assert.match(app, /data-plan-toggle/);
  assert.doesNotMatch(app, /class="turn-planner"/);
  assert.doesNotMatch(overrides, /\.turn-planner/);
});

test("execution-details pane owns overflow instead of flex-shrinking long artifact sections", async () => {
  const [baseStyles, overrides] = await Promise.all([
    readFile(new URL("../web/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.match(baseStyles, /\.workspace\{flex:1;min-height:0;display:grid/);
  assert.match(overrides, /\.app-shell\s*\{\s*grid-template-rows:\s*minmax\(0, 1fr\)/);
  assert.match(overrides, /\.main,\s*\.workspace,\s*\.details\s*\{\s*min-height:\s*0/);
  assert.match(overrides, /\.details\s*\{\s*display:\s*block;\s*overflow-y:\s*auto/);
  assert.doesNotMatch(overrides, /\.details\s*\{\s*display:\s*flex/);
});

test("Web projects durable Plan transitions, formats final Markdown, and preserves mixed tool outcomes", async () => {
  const [app, overrides] = await Promise.all([
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /replayPersistedRunEvents/);
  assert.match(app, /function projectPlanStatuses\(plan, events\)/);
  assert.match(app, /projectAssistantEvent\(assistant, event\)/);
  assert.match(app, /mergeRuntimeEvents\(assistant\.events, \[event\]\)/);
  assert.match(app, /message\.status === "completed" \? renderMarkdown\(message\.text\) : formatText\(message\.text\)/);
  assert.match(app, /function renderRecovery\(message\)/);
  assert.match(app, /recovery\/advance/);
  assert.match(app, /recovery\/resume/);
  assert.match(app, /import \{ renderMarkdown \} from "\.\/markdown-renderer\.js"/);
  assert.match(app, /function toolOutcomeLabel\(tool\)/);
  assert.match(app, /completedCalls: 0, rejectedCalls: 0, failedCalls: 0, runningCalls: 0/);
  assert.match(app, /\$\{tool\.rejectedCalls\} 次被拒绝/);
  assert.match(overrides, /\.tool-tag\.partial \.tool-status-dot/);
});

test("completed-message Markdown renders screenshot-style GFM tables as structured HTML", () => {
  const html = renderMarkdown([
    "其余相关接口及参数如下：",
    "",
    "| 接口 | API ID | 入参 |",
    "|---|---|---|",
    "| 员工画像标签人员查询2 | `M_ADS_FACT_MDYG_USER_TRIP_LABEL.D_A_BSTAMDYG_CL0021` | `countNum`、`sql`（均非必填） |",
  ].join("\n"));
  assert.match(html, /<div class="md-table-wrap"><table>/);
  assert.match(html, /<th>接口<\/th>/);
  assert.match(html, /<code class="md-inline">M_ADS_FACT_MDYG_USER_TRIP_LABEL\.D_A_BSTAMDYG_CL0021<\/code>/);
  assert.doesNotMatch(html, /<p>\| 接口 \| API ID \| 入参 \|/);
});

test("Web recovery replays Host Plan events instead of leaving a completed card with a running step", () => {
  const assistant = {
    status: "completed",
    text: "final output",
    reasoning: "",
    events: [{ seq: 66, type: "plan.step.started", data: { stepId: "extract" }, createdAt: 66 }],
    plan: [
      { id: "extract", objective: "extract", status: "running" },
      { id: "deliver", objective: "deliver", status: "pending" },
    ],
  };
  assert.equal(hasIncompleteCompletedPlan(assistant), true);
  const terminal = replayAssistantEvents(assistant, [
    { seq: 65, type: "plan.admitted", data: { steps: [{ id: "extract", objective: "extract", status: "pending" }, { id: "deliver", objective: "deliver", status: "pending" }] }, createdAt: 65 },
    { seq: 66, type: "plan.step.started", data: { stepId: "extract" }, createdAt: 66 },
    { seq: 126, type: "plan.step.completed", data: { stepId: "extract" }, createdAt: 126 },
    { seq: 127, type: "plan.step.started", data: { stepId: "deliver" }, createdAt: 127 },
    { seq: 156, type: "plan.step.completed", data: { stepId: "deliver" }, createdAt: 156 },
    { seq: 158, type: "run.completed", data: { output: "final output" }, createdAt: 158 },
  ]);
  assert.equal(terminal, true);
  assert.equal(assistant.status, "completed");
  assert.deepEqual(assistant.plan.map((step) => step.status), ["completed", "completed"]);
  assert.equal(hasIncompleteCompletedPlan(assistant), false);
});

test("Web projects the persisted Human-in-the-Loop request from its waiting event", () => {
  const assistant = { status: "running", text: "", reasoning: "", events: [], plan: [], humanLoop: undefined as unknown };
  const request = {
    id: "hil-choice", runId: "run-choice", status: "open", revision: 1, kind: "selection",
    title: "Choose a company", prompt: "Select one candidate.", rationale: "Candidates differ.", evidenceRefs: [],
    responseSchema: { type: "select", minSelections: 1, maxSelections: 1, options: [{ id: "company-a", label: "Company A" }] },
    resume: { mode: "continue_step" }, createdAt: 1,
  };
  assert.equal(projectAssistantEvent(assistant, {
    seq: 7, type: "run.waiting_user", data: { runId: "run-choice", requestId: request.id, kind: request.kind, request }, createdAt: 7,
  }), false);
  assert.deepEqual(assistant.humanLoop, request);
});

test("Web projects a durable recovery boundary without treating it as a terminal failure", () => {
  const assistant = { status: "running", text: "", reasoning: "", events: [], plan: [], recovery: undefined as unknown };
  assert.equal(projectAssistantEvent(assistant, {
    seq: 9,
    type: "run.recovery_required",
    data: {
      runId: "run-recovery",
      actionId: "action-recovery",
      failedBoundary: { stepId: "lookup", missingEvidenceKinds: ["source_summary", "explicit_caveats"] },
    },
    createdAt: 9,
  }), false);
  assert.deepEqual(assistant.recovery, {
    status: "required",
    runId: "run-recovery",
    actionId: "action-recovery",
    failedBoundary: { stepId: "lookup", missingEvidenceKinds: ["source_summary", "explicit_caveats"] },
  });
  assert.equal(assistant.status, "running");
});

test("Web bounds persisted event payloads without truncating the live assistant projection", () => {
  const fullText = "x".repeat(20_000);
  const assistant = { status: "running", text: "", reasoning: "", events: [], plan: [] };
  replayAssistantEvents(assistant, [{ seq: 1, type: "assistant.streaming", data: { content: fullText }, createdAt: 1 }]);
  assert.equal(assistant.text.length, fullText.length);
  const streamingEvent = { seq: 1, type: "assistant.streaming", data: { content: fullText }, createdAt: 1 };
  const compactStreamingEvents = mergeRuntimeEvents([streamingEvent].slice(0, 0), [streamingEvent]);
  assert.ok(String(compactStreamingEvents[0]?.data.content).length < fullText.length);

  const incomingEvents = Array.from({ length: 200 }, (_, seq) => ({ seq, type: "tool.completed", data: { result: JSON.stringify({ stdout: fullText }) }, createdAt: seq }));
  const events = mergeRuntimeEvents(incomingEvents.slice(0, 0), incomingEvents);
  assert.equal(events.length, 160);
  assert.equal(events[0]?.seq, 40);
  assert.ok(String(events.at(-1)?.data?.result).length < fullText.length);
});

test("Web session persistence falls back to a bounded recovery snapshot when localStorage quota is exhausted", () => {
  let stored = "";
  const attemptedLengths: number[] = [];
  const storage = {
    setItem(_key: string, value: string) {
      attemptedLengths.push(value.length);
      if (value.length > 10_000) throw new DOMException("quota exceeded", "QuotaExceededError");
      stored = value;
    },
    removeItem() { stored = ""; },
  };
  const oversized = "x".repeat(30_000);
  const sessions = Array.from({ length: 20 }, (_, conversationIndex) => ({
    id: `conversation-${conversationIndex}`,
    title: oversized,
    createdAt: conversationIndex,
    updatedAt: conversationIndex,
    messages: Array.from({ length: 24 }, (_, messageIndex) => messageIndex % 2 === 0
      ? { id: `user-${messageIndex}`, role: "user", text: oversized, createdAt: messageIndex }
      : {
        id: `assistant-${messageIndex}`,
        role: "assistant",
        text: oversized,
        reasoning: oversized,
        status: "running",
        assignmentId: "assignment-recoverable",
        events: Array.from({ length: 160 }, (_, seq) => ({ seq, type: "tool.completed", data: { result: oversized }, createdAt: seq })),
        createdAt: messageIndex,
      }),
  }));

  const result = persistSessions(storage, sessions);
  assert.equal(result.persisted, true);
  assert.ok(attemptedLengths.some((length) => length > 10_000));
  assert.ok(stored.length > 0 && stored.length <= 10_000);
  const recovered = JSON.parse(stored) as Array<{ messages: Array<{ assignmentId?: string; events?: unknown[] }> }>;
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.messages.some((message) => message.assignmentId === "assignment-recoverable"), true);
  assert.equal(recovered[0]?.messages.every((message) => (message.events?.length ?? 0) <= 4), true);
});

test("Web session persistence never turns an unavailable localStorage into a thrown submission error", () => {
  const storage = {
    setItem() { throw new DOMException("quota exceeded", "QuotaExceededError"); },
    removeItem() { throw new DOMException("quota exceeded", "QuotaExceededError"); },
  };
  assert.doesNotThrow(() => persistSessions(storage, [{ id: "conversation", messages: [] }]));
  assert.equal(persistSessions(storage, [{ id: "conversation", messages: [] }]).persisted, false);
});

test("Web batches high-frequency event rendering and persistence but flushes a terminal update", () => {
  let frame: (() => void) | undefined;
  let timer: (() => void) | undefined;
  let renders = 0;
  let persists = 0;
  const updater = createCoalescedUpdater({
    render: () => { renders += 1; },
    persist: () => { persists += 1; },
    requestFrame: (callback) => { frame = callback; return 1; },
    cancelFrame: () => { frame = undefined; },
    setTimer: (callback) => { timer = callback; return 2; },
    clearTimer: () => { timer = undefined; },
  });
  for (let index = 0; index < 100; index += 1) updater.request();
  assert.equal(renders, 0);
  assert.equal(persists, 0);
  assert.ok(frame);
  frame();
  assert.ok(timer);
  timer();
  assert.equal(renders, 1);
  assert.equal(persists, 1);

  updater.request();
  updater.flush();
  assert.equal(renders, 2);
  assert.equal(persists, 2);
});

test("Web tracks active Runs by conversation instead of imposing one global Run lock", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(app, /const activeRunsByConversation = new Map\(\)/);
  assert.match(app, /activeRunsByConversation\.has\(conversation\.id\)/);
  assert.match(app, /activeRunsByConversation\.get\(conversation\.id\)/);
  assert.match(app, /void reconcilePersistedRuns\(\)/);
  assert.match(app, /function applyRecoveredRunState\(assistant, run\)/);
  assert.match(app, /当前会话仍在发起或执行；请等待或点击停止/);
  assert.match(app, /文件仍在上传，请稍候再发送/);
  assert.match(app, /submitAbortController: new AbortController\(\)/);
  assert.match(app, /发起会话超时，请重试/);
  assert.match(app, /SSE 在收到 Run 终态前关闭/);
  assert.match(app, /catch \{ continue; \}/);
  assert.match(app, /activeRun\.assistant\.status = "cancelled"/);
  assert.match(app, /cancellationTarget\(activeRunsByConversation\.get\(conversation\.id\), conversation\.messages\)/);
  assert.match(app, /停止失败：/);
  assert.doesNotMatch(app, /let activeAssignmentId|let streamAbort/);
});

test("Web recovers the Router cancellation target from a persisted running message", () => {
  const persisted = { role: "assistant", status: "running", assignmentId: "assignment-persisted" };
  const messages = [{ role: "user", text: "first" }, persisted, { role: "assistant", status: "completed", assignmentId: "assignment-old" }];
  assert.equal(persistedCancellableAssistant(messages), persisted);
  assert.deepEqual(cancellationTarget(undefined, messages), {
    activeRun: undefined,
    assistant: persisted,
    assignmentId: "assignment-persisted",
    canCancel: true,
  });
});

test("Web keeps uploaded attachment records removable until send and snapshots them into the user message", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="pending-attachments"/);
  assert.match(html, /id="upload-file"/);
  assert.match(html, /accept="\.txt,\.md,\.csv,\.json,\.html,\.htm,\.pdf,\.doc,\.docx,\.xlsx,\.pptx"/);
  assert.match(app, /async function uploadAttachments\(fileList\)/);
  assert.match(app, /conversation\.pendingAttachments = \[\.\.\.pendingAttachments\(conversation\), attachment\]/);
  assert.match(app, /function removePendingAttachment\(conversation, attachmentId\)/);
  assert.match(app, /attachmentIds: attachments\.map\(\(attachment\) => attachment\.id\)/);
  assert.match(app, /const submittedAt = Date\.now\(\)/);
  assert.match(app, /const userMessage = \{[^\n]+attachments, createdAt: submittedAt \}/);
  assert.match(app, /\$\("submit"\)\.disabled = activeRun !== undefined \|\| uploadCount\(conversation\.id\) > 0/);
  assert.match(app, /msg-source-row" aria-label="本轮上传文件"/);
});

test("Web persists question and terminal-response timing for the conversation stream", async () => {
  const [app, overrides] = await Promise.all([
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /const submittedAt = Date\.now\(\)/);
  assert.match(app, /createdAt: submittedAt/);
  assert.match(app, /function completeAssistantMessage\(assistant, event\)/);
  assert.match(app, /assistant\.completedAt = numberValue\(event\?\.createdAt\) \?\? Date\.now\(\)/);
  assert.match(app, /function formatMessageTime\(timestamp\)/);
  assert.match(app, /回答结束于 \$\{completedAt\}/);
  assert.match(app, /耗时 \$\{duration\}/);
  assert.match(app, /提问于 \$\{askedAt\}/);
  assert.match(overrides, /\.message-timing/);
});

test("router distributes independent user tasks by available Runtime capacity", async () => {
  const router = new MultiRuntimeRouter();
  router.register(runtime("runtime-a"), endpoint("run-a"));
  router.register(runtime("runtime-b"), endpoint("run-b"));

  const first = await router.submit(task("user-a", "message-a"));
  const second = await router.submit(task("user-b", "message-b"));

  assert.equal(first.runtimeId, "runtime-a");
  assert.equal(second.runtimeId, "runtime-b");
});

test("router retries one user message through one Assignment", async () => {
  const router = new MultiRuntimeRouter();
  let dispatches = 0;
  router.register(runtime("runtime-a", { maxConcurrentRuns: 2 }), {
    async dispatch(envelope) {
      dispatches += 1;
      return { remoteRunId: `run-${envelope.dispatchKey}` };
    },
  });
  const input = task("user-a", "message-a");
  const [first, second] = await Promise.all([router.submit(input), router.submit(input)]);
  assert.equal(first.id, second.id);
  assert.equal(dispatches, 1);
});

test("router rejects cloud visible directory input", () => {
  const router = new MultiRuntimeRouter();
  router.register(runtime("runtime-a"), endpoint("run-a"));
  assert.throws(() => router.submit({ ...task("user-a", "message-a"), visibleDirectories: ["/Users/test"] } as never), /visibleDirectories/);
});

test("router fails closed when no Runtime has remaining capacity", async () => {
  const router = new MultiRuntimeRouter();
  router.register(runtime("runtime-a"), endpoint("run-a"));
  await router.submit(task("user-a", "message-a"));
  await assert.rejects(() => router.submit(task("user-b", "message-b")), RuntimeCapacityError);
});

test("router permits a retry after dispatch fails before a Run is accepted", async () => {
  const router = new MultiRuntimeRouter();
  let attempts = 0;
  router.register(runtime("runtime-a"), {
    async dispatch() {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary network failure");
      return { remoteRunId: "run-after-retry" };
    },
  });
  const input = task("user-a", "message-a");
  await assert.rejects(() => router.submit(input), /temporary network failure/);
  const accepted = await router.submit(input);
  assert.equal(accepted.remoteRunId, "run-after-retry");
  assert.equal(attempts, 2);
});

test("Runtime Host imports resources once and reuses its dispatch key", async () => {
  let imports = 0;
  let starts = 0;
  let ensured: { ownerUserId: string; conversationId: string; input: string } | undefined;
  const host = new AgentLoopRuntimeHost({
    async ensureConversation(ownerUserId, conversationId, input) {
      ensured = { ownerUserId, conversationId, input };
    },
    async startConversation() {
      starts += 1;
      return { id: "remote-run-1" } as never;
    },
    async get() {
      return { id: "remote-run-1", status: "completed", output: "done" } as never;
    },
  }, {
    async importForRun() {
      imports += 1;
      return ["src_local"];
    },
  });
  const envelope: RuntimeDispatchEnvelope = {
    schema: "agentloop.runtimeDispatch/v1",
    assignmentId: "assignment-1",
    dispatchKey: "dispatch-1",
    subject: { tenantId: "tenant", userId: "user" },
    conversationId: "conversation",
    input: "summarize the attachment",
    allowDangerousTools: false,
    resourceRefs: [],
  };
  const [first, second] = await Promise.all([host.dispatch(envelope), host.dispatch(envelope)]);
  assert.deepEqual(first, { remoteRunId: "remote-run-1" });
  assert.deepEqual(second, first);
  assert.equal(imports, 1);
  assert.equal(starts, 1);
  assert.deepEqual(ensured, { ownerUserId: "user", conversationId: "conversation", input: "summarize the attachment" });
  assert.deepEqual(await host.getRun("remote-run-1"), {
    remoteRunId: "remote-run-1",
    status: "completed",
    output: "done",
  });
});

test("resource importer stops unsupported Sources before they can be bound to a Run", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer router-token");
    return new Response("legacy document");
  };
  try {
    const importer = new HttpResourceImporter({
      async uploadSource() {
        return {
          id: "src_legacy",
          originalName: "授权委托书.doc",
          mimeType: "application/msword",
          extension: ".doc",
          byteSize: 15,
          sha256: "a".repeat(64),
          status: "unsupported",
          chunkCount: 0,
          truncated: false,
        };
      },
    } as never, "router-token");
    await assert.rejects(
      () => importer.importForRun({
        subject: { tenantId: "tenant", userId: "user" },
        conversationId: "conversation",
        resources: [{
          attachmentId: "attachment-legacy",
          uri: "http://router.test/v1/internal/attachments/attachment-legacy",
          sha256: createHash("sha256").update("legacy document").digest("hex"),
          mediaType: "application/msword",
          originalName: "授权委托书.doc",
          byteSize: 15,
        }],
      }),
      /附件「授权委托书\.doc」：该格式暂不支持（\.doc）/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloud runtime configuration accepts deployable Hosts but rejects desktop and local-directory settings", () => {
  const config = parseMultiRuntimeConfig(JSON.stringify({
    schema: "agentloop.multiRuntimeConfig/v1",
    runtimes: [{
      id: "general-01",
      endpoint: "http://runtime-general-01:8790",
      profile: "general",
      capabilities: ["document"],
      maxConcurrentRuns: 4,
    }],
  }));
  assert.equal(config.runtimes[0]?.id, "general-01");
  assert.throws(() => parseMultiRuntimeConfig(JSON.stringify({
    schema: "agentloop.multiRuntimeConfig/v1",
    runtimes: [{ ...config.runtimes[0], profile: "desktop" }],
  })), /not allowed/);
  assert.throws(() => parseMultiRuntimeConfig(JSON.stringify({
    schema: "agentloop.multiRuntimeConfig/v1",
    runtimes: [{ ...config.runtimes[0], visibleDirectories: ["/Users/test"] }],
  })), /visibleDirectories/);
});

test("Runtime Hosts merge app-configured custom Skill roots with bundled Skills", () => {
  const appRoot = "/srv/agentloop/apps/agentloop-multi-runtime";
  const customDirectories = resolveSkillDirectoriesConfig(parseSkillDirectoriesConfig(JSON.stringify({
    schema: "agentloop.skillDirectories/v1",
    customSkillDirectories: ["./custom-skills", "/opt/team-skills", "./custom-skills"],
  })), appRoot);

  assert.deepEqual(customDirectories, [
    "/srv/agentloop/apps/agentloop-multi-runtime/custom-skills",
    "/opt/team-skills",
  ]);
  assert.deepEqual(mergeSkillDirectories(["/packages/bundled-skills"], customDirectories), [
    "/packages/bundled-skills",
    "/srv/agentloop/apps/agentloop-multi-runtime/custom-skills",
    "/opt/team-skills",
  ]);
  assert.throws(() => parseSkillDirectoriesConfig("{}"), /schema/);
  assert.throws(() => parseSkillDirectoriesConfig(JSON.stringify({
    schema: "agentloop.skillDirectories/v1",
    customSkillDirectories: [""],
  })), /non-empty strings/);
});

test("Skill directory config resolves relative paths from the multi-runtime application root", async () => {
  const configRoot = await mkdtemp(join(tmpdir(), "agentloop-skill-config-"));
  const configPath = join(configRoot, "skill-directories.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schema: "agentloop.skillDirectories/v1",
      customSkillDirectories: ["./custom-skills"],
    }));
    assert.deepEqual(await loadSkillDirectoriesConfig({
      appRoot: "/srv/agentloop/apps/agentloop-multi-runtime",
      configPath,
    }), ["/srv/agentloop/apps/agentloop-multi-runtime/custom-skills"]);
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
});

test("Runtime Host rejects a dispatch carrying application-owned intent or visible directory data", () => {
  assert.throws(() => assertRuntimeDispatchEnvelope({
    schema: "agentloop.runtimeDispatch/v1",
    visibleDirectories: ["/Users/test"],
  }), /visibleDirectories/);
  assert.throws(() => assertRuntimeDispatchEnvelope({
    schema: "agentloop.runtimeDispatch/v1",
    assignmentId: "assignment-1",
    dispatchKey: "dispatch-1",
    subject: { tenantId: "tenant", userId: "user" },
    conversationId: "conversation-1",
    input: "hello",
    allowDangerousTools: false,
    conversationIntent: "auto",
  }), /conversationIntent is Runtime-owned/);
  assert.throws(() => assertRuntimeDispatchEnvelope({ schema: "unexpected" }), /unsupported runtime dispatch schema/);
});

test("Router converts owned attachment IDs and never accepts browser resource references", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-multi-runtime-test-"));
  const attachments = new FileAttachmentBroker(root, "http://router.test");
  try {
    const attachment = await attachments.upload({
      tenantId: "tenant",
      ownerUserId: "user",
      conversationId: "conversation-user",
      originalName: "brief.txt",
      mediaType: "text/plain",
      content: Buffer.from("hello router attachment"),
    });
    const dispatched = await taskFromRequest({
      tenantId: "tenant",
      ownerUserId: "user",
      conversationId: "conversation-user",
      clientMessageId: "message-1",
      input: "summarize attachment",
      attachmentIds: [attachment.id],
    }, undefined, undefined, attachments);
    assert.equal(dispatched.allowDangerousTools, true);
    assert.equal((await taskFromRequest({
      tenantId: "tenant",
      ownerUserId: "user",
      conversationId: "conversation-user",
      clientMessageId: "message-1-disabled",
      input: "summarize attachment",
      allowDangerousTools: false,
    }, undefined, undefined, attachments)).allowDangerousTools, false);
    assert.equal(dispatched.resourceRefs?.[0]?.originalName, "brief.txt");
    assert.equal(dispatched.resourceRefs?.[0]?.byteSize, "hello router attachment".length);
    await assert.rejects(taskFromRequest({ ...task("user", "message-intent"), conversationIntent: "auto" }, undefined, undefined, attachments), /conversationIntent is Runtime-owned/);
    await assert.rejects(taskFromRequest({ ...task("user", "message-2"), resourceRefs: [] }, undefined, undefined, attachments), /resourceRefs are Router-owned/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared attachment metadata is visible to another Router replica", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-multi-runtime-attachments-"));
  const database = new AppDatabase(join(root, "state.db"));
  const first = new SharedFilesystemAttachmentBroker(database, join(root, "attachments"), "http://router.test");
  const second = new SharedFilesystemAttachmentBroker(database, join(root, "attachments"), "http://router.test");
  try {
    await Promise.all([first.ready(), second.ready()]);
    const attachment = await first.upload({
      tenantId: "tenant", ownerUserId: "user", conversationId: "conversation-user",
      originalName: "shared.txt", mediaType: "text/plain", content: Buffer.from("available to both routers"),
    });
    const [reference] = await second.resolveForTask({
      tenantId: "tenant", ownerUserId: "user", conversationId: "conversation-user", attachmentIds: [attachment.id],
    });
    assert.equal(reference?.attachmentId, attachment.id);
    assert.equal((await second.readForRuntime(attachment.id)).content.toString("utf8"), "available to both routers");
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Router permits only configured Web origins for local development", () => {
  const configured = "http://localhost:5174,http://127.0.0.1:5174";
  assert.equal(webOriginMatches("http://localhost:5174", configured), true);
  assert.equal(webOriginMatches("http://127.0.0.1:5174", configured), true);
  assert.equal(webOriginMatches("http://localhost:5175", configured), false);
  assert.equal(webOriginMatches("https://example.invalid", configured), false);
});

test("Router reserves assignment lookup for its exact path so the SSE subroute remains reachable", () => {
  assert.equal(assignmentIdFromPath("/v1/assignments/assignment-1"), "assignment-1");
  assert.equal(assignmentIdFromPath("/v1/assignments/assignment-1/events"), undefined);
  assert.equal(assignmentIdFromPath("/v1/assignments/assignment-1/events/stream"), undefined);
});

test("Router SSE polling retains the Router receiver for persistent event projections", async () => {
  const router = {
    marker: "durable-router",
    async events(this: { readonly marker: string }, assignmentId: string, afterSeq: number) {
      assert.equal(this.marker, "durable-router");
      assert.equal(assignmentId, "assignment-1");
      assert.equal(afterSeq, 7);
      return { assignment: { tenantId: "tenant", ownerUserId: "user" }, events: [] };
    },
  };
  const projection = await bindRouterEvents(router)("assignment-1", 7);
  assert.deepEqual(projection, { assignment: { tenantId: "tenant", ownerUserId: "user" }, events: [] });
});

test("Router SSE keeps polling after the GET request is complete and stops only when its response closes", async () => {
  const request = new EventEmitter();
  const response = new EventEmitter() as EventEmitter & {
    statusCode?: number;
    setHeader(name: string, value: string): void;
    flushHeaders(): void;
    write(chunk: string): void;
    end(): void;
  };
  const writes: string[] = [];
  response.setHeader = () => {};
  response.flushHeaders = () => {};
  response.write = (chunk) => { writes.push(chunk); };
  response.end = () => {};
  let polls = 0;
  streamEvents(
    request as never,
    response as never,
    async () => {
      polls += 1;
      return {
        assignment: { tenantId: "tenant", ownerUserId: "user" },
        events: polls === 1 ? [{ seq: 2, type: "assistant.streaming", data: { reasoningContent: "still streaming" }, createdAt: 2 }] : [],
      };
    },
    "assignment-1",
    [{ seq: 1, type: "run.started", data: {}, createdAt: 1 }],
  );
  request.emit("close");
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal(polls, 1);
  assert.match(writes.join(""), /assistant\.streaming/);
  response.emit("close");
});

test("Router projects a terminal Host event durably and never regresses it to running", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-terminal"), endpoint: "http://runtime-terminal" }], 100);
  await store.heartbeat({ runtimeId: "runtime-terminal", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const router = new PersistentMultiRuntimeRouter({
    store,
    heartbeatTtlMs: 1_000,
    now: () => 200,
    endpointFactory: () => ({
      async dispatch() { return { remoteRunId: "terminal-run" }; },
      async events() { return [{ seq: 1, type: "run.completed", data: { output: "done" }, createdAt: 200 }]; },
    }),
  });
  const assignment = await router.submit(task("user-terminal", "message-terminal"));
  const observed = await router.events(assignment.id, 0);
  assert.equal(observed?.assignment.status, "completed");
  await store.observeRun(assignment.id, { remoteRunId: "terminal-run", status: "running" }, 201);
  assert.equal((await store.assignment(assignment.id))?.status, "completed");
  await database.close();
});

test("Router preserves Host round-limit failures for browser replay and recovery", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-round-limit"), endpoint: "http://runtime-round-limit" }], 100);
  await store.heartbeat({ runtimeId: "runtime-round-limit", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const router = new PersistentMultiRuntimeRouter({
    store,
    heartbeatTtlMs: 1_000,
    now: () => 200,
    endpointFactory: () => ({
      async dispatch() { return { remoteRunId: "round-limit-run" }; },
      async getRun() { return { remoteRunId: "round-limit-run", status: "failed" as const, errorCode: "RUN_LIMIT_EXCEEDED" }; },
      async events() {
        return [{
          seq: 7,
          type: "run.failed",
          data: {
            code: "RUN_LIMIT_EXCEEDED",
            message: "Run exceeded its 12-step limit while required evidence remained missing.",
          },
          createdAt: 200,
        }];
      },
    }),
  });
  const assignment = await router.submit(task("user-round-limit", "message-round-limit"));
  const observed = await router.events(assignment.id, 0);
  assert.equal(observed?.assignment.status, "failed");
  assert.equal(observed?.assignment.errorCode, "RUN_LIMIT_EXCEEDED");
  assert.match(observed?.assignment.errorMessage ?? "", /12-step limit/);

  const recovered = await router.assignment(assignment.id);
  assert.equal(recovered?.run?.errorCode, "RUN_LIMIT_EXCEEDED");
  assert.match(recovered?.run?.errorMessage ?? "", /required evidence remained missing/);

  const assistant: { status: string; text: string; reasoning: string; error?: string; events: never[]; plan: never[] } = {
    status: "running", text: "", reasoning: "still working", events: [], plan: [],
  };
  assert.equal(projectAssistantEvent(assistant, observed?.events[0] as unknown as Record<string, unknown>), true);
  assert.equal(assistant.status, "failed");
  assert.match(assistant.error ?? "", /执行轮次已耗尽/);
  assert.match(assistant.text, /12-step limit/);
  await database.close();
});

test("persistent Router dispatches only heartbeating Hosts and reuses the durable Assignment", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([
    { ...runtime("runtime-a", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-a" },
    { ...runtime("runtime-b", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-b" },
  ], 100);
  await store.heartbeat({ runtimeId: "runtime-b", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  let dispatches = 0;
  const router = new PersistentMultiRuntimeRouter({
    store,
    heartbeatTtlMs: 1_000,
    now: () => 200,
    endpointFactory: () => ({
      async dispatch() {
        dispatches += 1;
        return { remoteRunId: "remote-run-b" };
      },
    }),
  });
  const first = await router.submit(task("user-a", "message-a"));
  const duplicate = await router.submit(task("user-a", "message-a"));
  assert.equal(first.runtimeId, "runtime-b");
  assert.equal(duplicate.id, first.id);
  assert.equal(dispatches, 1);
  await database.close();
});

test("Router Runtime catalog exposes concrete statically registered Runtime IDs", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([
    { ...runtime("runtime-general"), endpoint: "http://runtime-general" },
    { ...runtime("runtime-artifact", { profile: "artifact" }), endpoint: "http://runtime-artifact" },
  ], 100);
  const router = new PersistentMultiRuntimeRouter({ store, endpointFactory: () => endpoint("unused") });
  assert.deepEqual((await router.runtimes()).map((runtime) => ({ ...runtime })), [
    { id: "runtime-artifact", profile: "artifact" },
    { id: "runtime-general", profile: "general" },
  ]);
  await database.close();
});

test("explicit Runtime selection uses that Host and rejects an unregistered ID", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([
    { ...runtime("general-01"), endpoint: "http://general-01" },
    { ...runtime("general-02"), endpoint: "http://general-02" },
  ], 100);
  await store.heartbeat({ runtimeId: "general-01", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  await store.heartbeat({ runtimeId: "general-02", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const router = new PersistentMultiRuntimeRouter({
    store,
    now: () => 200,
    endpointFactory: () => ({ async dispatch() { return { remoteRunId: "remote-run" }; } }),
  });
  const assigned = await router.submit({ ...task("user-a", "message-a"), requestedRuntimeId: "general-02" });
  assert.equal(assigned.runtimeId, "general-02");
  await assert.rejects(
    () => router.submit({ ...task("user-b", "message-b"), requestedRuntimeId: "missing-runtime" }),
    /Runtime "missing-runtime" is not registered/,
  );
  await database.close();
});

test("persistent Router keeps a conversation on its original Runtime Host", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([
    { ...runtime("runtime-a", { maxConcurrentRuns: 3 }), endpoint: "http://runtime-a" },
    { ...runtime("runtime-b", { maxConcurrentRuns: 3 }), endpoint: "http://runtime-b" },
  ], 100);
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  await store.heartbeat({ runtimeId: "runtime-b", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const router = new PersistentMultiRuntimeRouter({
    store,
    now: () => 200,
    endpointFactory: (endpoint) => ({ async dispatch() { return { remoteRunId: `${endpoint}-run` }; } }),
  });
  const first = await router.submit(task("user-a", "message-a", "conversation-sticky"));
  const second = await router.submit(task("user-a", "message-b", "conversation-sticky"));
  assert.equal(second.runtimeId, first.runtimeId);
  await database.close();
});

test("a stale preferred Runtime does not block the next conversation Run from using a healthy Host", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([
    { ...runtime("runtime-a", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-a" },
    { ...runtime("runtime-b", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-b" },
  ], 100);
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  await store.heartbeat({ runtimeId: "runtime-b", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });

  const first = await store.reserve(task("user-a", "message-first", "conversation-migrated"), {
    heartbeatTtlMs: 1_000,
    reservationTtlMs: 1_000,
    now: 200,
  });
  assert.equal(first.runtimeId, "runtime-a");
  await store.markAccepted(first.id, "run-on-a", 201);

  // runtime-a has missed its heartbeat, while runtime-b remains healthy.
  await store.heartbeat({ runtimeId: "runtime-b", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 1_300 });
  const next = await store.reserve(task("user-a", "message-next", "conversation-migrated"), {
    heartbeatTtlMs: 1_000,
    reservationTtlMs: 1_000,
    now: 1_300,
  });
  assert.equal(next.runtimeId, "runtime-b");
  const migration = await database.prepare(`
    SELECT previous_runtime_id, selected_runtime_id, reason
    FROM mr_conversation_runtime_migrations WHERE assignment_id = ?
  `).get(next.id) as { previous_runtime_id: string; selected_runtime_id: string; reason: string };
  assert.equal(migration.previous_runtime_id, "runtime-a");
  assert.equal(migration.selected_runtime_id, "runtime-b");
  assert.equal(migration.reason, "preferred_runtime_unavailable_or_at_capacity");
  await database.close();
});

test("a dispatch reservation does not bind a conversation before its Host starts the Run", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([
    { ...runtime("runtime-a", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-a" },
    { ...runtime("runtime-b", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-b" },
  ], 100);
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  await store.heartbeat({ runtimeId: "runtime-b", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });

  // The first submission is only a Router reservation: no Host has returned
  // a remote Run id yet. A later message in the conversation must therefore
  // still use normal load balancing instead of inheriting runtime-a.
  await store.reserve({ ...task("user-a", "message-reserved", "conversation-pending"), requestedRuntimeId: "runtime-a" }, {
    heartbeatTtlMs: 1_000,
    reservationTtlMs: 1_000,
    now: 200,
  });
  const next = await store.reserve(task("user-a", "message-balanced", "conversation-pending"), {
    heartbeatTtlMs: 1_000,
    reservationTtlMs: 1_000,
    now: 201,
  });
  assert.equal(next.runtimeId, "runtime-b");
  await database.close();
});

test("persistent capacity uses heartbeat load, reservations, and terminal release", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-a"), endpoint: "http://runtime-a" }], 100);
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const first = await store.reserve(task("user-a", "message-a"), { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 200 });
  await assert.rejects(
    () => store.reserve(task("user-b", "message-b"), { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 200 }),
    PersistentRuntimeCapacityError,
  );
  await store.markAccepted(first.id, "remote-a", 201);
  await store.observeRun(first.id, { remoteRunId: "remote-a", status: "completed" }, 202);
  const next = await store.reserve(task("user-b", "message-b"), { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 203 });
  assert.equal(next.runtimeId, "runtime-a");
  await database.close();
});

test("automatic routing honors the concurrency limit enforced by each Runtime Host", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  // The static inventory is deliberately more optimistic than the two Hosts.
  // Their heartbeats must be authoritative, otherwise a fresh conversation can
  // be dispatched to a Host that will reject it as already full.
  await store.seedRuntimes([
    { ...runtime("runtime-busy", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-busy" },
    { ...runtime("runtime-idle", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-idle" },
  ], 100);
  await store.heartbeat({ runtimeId: "runtime-busy", status: "ready", activeRunCount: 1, queuedRunCount: 0, maxConcurrentRuns: 1, observedAt: 100 });
  await store.heartbeat({ runtimeId: "runtime-idle", status: "ready", activeRunCount: 0, queuedRunCount: 0, maxConcurrentRuns: 1, observedAt: 100 });

  const router = new PersistentMultiRuntimeRouter({
    store,
    now: () => 200,
    endpointFactory: (endpoint) => ({ async dispatch() { return { remoteRunId: `${endpoint}-run` }; } }),
  });
  const assignment = await router.submit(task("user-new-conversation", "message-new-conversation", "conversation-new"));
  assert.equal(assignment.runtimeId, "runtime-idle");

  await store.heartbeat({ runtimeId: "runtime-idle", status: "ready", activeRunCount: 1, queuedRunCount: 0, maxConcurrentRuns: 1, observedAt: 300 });
  await assert.rejects(
    () => store.reserve(task("user-next-conversation", "message-next-conversation", "conversation-next"), { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 301 }),
    PersistentRuntimeCapacityError,
  );
  await database.close();
});

test("a fresh Host heartbeat releases stale accepted assignment occupancy", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-a"), endpoint: "http://runtime-a" }], 100);
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const first = await store.reserve(task("user-a", "message-a"), { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 200 });
  await store.markAccepted(first.id, "remote-a", 201);
  await assert.rejects(
    () => store.reserve(task("user-b", "message-b"), { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 202 }),
    PersistentRuntimeCapacityError,
  );
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 300 });
  const next = await store.reserve(task("user-b", "message-b"), { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 301 });
  assert.equal(next.runtimeId, "runtime-a");
  await database.close();
});

test("expired dispatch reservation is recoverable without duplicating the task", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-a", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-a" }], 100);
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const initial = await store.reserve(task("user-a", "message-a"), { heartbeatTtlMs: 1_000, reservationTtlMs: 10, now: 200 });
  const retry = await store.reserve(task("user-a", "message-a"), { heartbeatTtlMs: 1_000, reservationTtlMs: 10, now: 211 });
  assert.notEqual(retry.id, initial.id);
  assert.equal(retry.runtimeId, "runtime-a");
  await database.close();
});

test("Host persists dispatch idempotency across a process restart", async () => {
  const database = new AppDatabase(":memory:");
  const dispatchStore = new HostDispatchStore(database);
  await dispatchStore.ready();
  let starts = 0;
  const runs = {
    async ensureConversation() {},
    async startConversation() {
      starts += 1;
      return { id: "durable-run" } as never;
    },
    async get() {
      return { id: "durable-run", status: "running" } as never;
    },
  };
  const firstHost = new AgentLoopRuntimeHost(runs, { async importForRun() { return []; } }, undefined, dispatchStore);
  const envelope: RuntimeDispatchEnvelope = {
    schema: "agentloop.runtimeDispatch/v1",
    assignmentId: "assignment-durable",
    dispatchKey: "dispatch-durable",
    subject: { tenantId: "tenant", userId: "user" },
    conversationId: "conversation",
    input: "durable task",
    allowDangerousTools: false,
    resourceRefs: [],
  };
  assert.deepEqual(await firstHost.dispatch(envelope), { remoteRunId: "durable-run" });
  const restartedHost = new AgentLoopRuntimeHost(runs, { async importForRun() { return []; } }, undefined, dispatchStore);
  assert.deepEqual(await restartedHost.dispatch(envelope), { remoteRunId: "durable-run" });
  assert.equal(starts, 1);
  assert.equal((await restartedHost.getRun("durable-run")).status, "running");
  await database.close();
});

test("a shared state database reports active Runs only to their accepting Host", async () => {
  const database = new AppDatabase(":memory:");
  const hostA = new HostDispatchStore(database, "runtime-a");
  const hostB = new HostDispatchStore(database, "runtime-b");
  await hostA.ready();
  await hostB.ready();
  await database.prepare(`
    INSERT INTO runs(id, owner_user_id, conversation_id, parent_run_id, depth, allow_dangerous_tools, model_key, status, input, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("shared-run-a", "user-a", null, null, 0, 0, null, "running", "task", 100);
  assert.deepEqual(await hostA.claim({ dispatchKey: "dispatch-shared-a", assignmentId: "assignment-shared-a", ownerUserId: "user-a", now: 100, leaseMs: 1_000 }), { kind: "claimed" });
  await hostA.accept("dispatch-shared-a", "shared-run-a", 101);
  assert.equal(await hostA.activeRunCount(), 1);
  assert.equal(await hostB.activeRunCount(), 0);

  await database.prepare(`
    INSERT INTO runtime_actions(
      id, run_id, plan_id, step_id, kind, state, attempt, max_attempts,
      replay_policy, deadline_at, lease_until, fence, revision, metadata_json,
      result_ref, error_code, created_at, updated_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "recovery-action-a", "shared-run-a", null, null, "recovery_review", "recovery_required", 0, 0,
    "unsafe", null, null, 0, 1, "{}", null, null, 102, 102, null,
  );
  await database.prepare(`
    INSERT INTO run_recovery_states(run_id, state, action_id, question, updated_at)
    VALUES (?, 'waiting_recovery', ?, NULL, ?)
  `).run("shared-run-a", "recovery-action-a", 102);

  // The Run is recoverable but no executor is running. It must release the
  // Host admission slot until recovery resumes and removes this state.
  assert.equal(await hostA.activeRunCount(), 0);
  await database.close();
});

test("persistent Router forwards cancellation to the assigned Host and persists terminal state", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-a"), endpoint: "http://runtime-a" }], 100);
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const router = new PersistentMultiRuntimeRouter({
    store,
    now: () => 200,
    heartbeatTtlMs: 1_000,
    endpointFactory: () => ({
      async dispatch() { return { remoteRunId: "run-a" }; },
      async cancelRun() { return { remoteRunId: "run-a", status: "cancelled" }; },
    }),
  });
  const assignment = await router.submit(task("user-a", "message-a"));
  const cancelled = await router.cancel(assignment.id);
  assert.equal(cancelled.run.status, "cancelled");
  assert.equal(cancelled.assignment.status, "cancelled");
  await database.close();
});

test("persistent Router forwards recovery advance and resume to the assigned Host", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-recovery"), endpoint: "http://runtime-recovery" }], 100);
  await store.heartbeat({ runtimeId: "runtime-recovery", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const calls: string[] = [];
  const router = new PersistentMultiRuntimeRouter({
    store,
    now: () => 200,
    heartbeatTtlMs: 1_000,
    endpointFactory: () => ({
      async dispatch() { return { remoteRunId: "run-recovery" }; },
      async advanceRecovery(remoteRunId) {
        calls.push(`advance:${remoteRunId}`);
        return {
          state: { runId: remoteRunId, actionId: "action-recovery", state: "ready_to_resume", updatedAt: 200 },
          decisions: [], planRevisionAssessments: [], userResponses: [],
        };
      },
      async resumeRecovery(remoteRunId) {
        calls.push(`resume:${remoteRunId}`);
        return { remoteRunId, status: "running" as const };
      },
    }),
  });
  const assignment = await router.submit(task("user-recovery", "message-recovery"));
  const advanced = await router.advanceRecovery(assignment.id);
  assert.equal(advanced?.recovery.state?.state, "ready_to_resume");
  const resumed = await router.resumeRecovery(assignment.id);
  assert.equal(resumed?.run.status, "running");
  assert.deepEqual(calls, ["advance:run-recovery", "resume:run-recovery"]);
  await database.close();
});

test("Host capacity gate rejects an over-capacity dispatch before creating a Run", async () => {
  let starts = 0;
  const host = new AgentLoopRuntimeHost({
    async ensureConversation() {},
    async startConversation() { starts += 1; return { id: "should-not-start" } as never; },
    async get() { return { id: "should-not-start", status: "running" } as never; },
  }, { async importForRun() { return []; } }, {
    maxConcurrentRuns: 1,
    async activeRunCount() { return 1; },
  });
  await assert.rejects(() => host.dispatch({
    schema: "agentloop.runtimeDispatch/v1",
    assignmentId: "assignment-full",
    dispatchKey: "dispatch-full",
    subject: { tenantId: "tenant", userId: "user" },
    conversationId: "conversation",
    input: "over capacity",
    allowDangerousTools: false,
    resourceRefs: [],
  }), /no remaining capacity/);
  assert.equal(starts, 0);
});

function endpoint(remoteRunId: string): RuntimeEndpoint {
  return { async dispatch(): Promise<{ remoteRunId: string }> { return { remoteRunId }; } };
}

function task(ownerUserId: string, clientMessageId: string, conversationId = `conversation-${ownerUserId}`) {
  return {
    tenantId: "tenant",
    ownerUserId,
    conversationId,
    clientMessageId,
    input: "summarize this task",
    requiredCapabilities: ["document"],
  };
}
