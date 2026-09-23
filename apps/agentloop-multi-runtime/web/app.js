import { hasIncompleteCompletedPlan, mergeRuntimeEvents, projectAssistantEvent, replayAssistantEvents } from "./assistant-event-projection.js";
import { assistantMessagePresentation, terminalAwarePlanStepStatus } from "./assistant-message-presentation.js";
import { createCoalescedUpdater } from "./live-update-scheduler.js";
import { persistJson, persistSessions } from "./session-persistence.js";
import { openArtifactPreview, renderMarkdown } from "./artifact-preview.js";
import { artifactPreviewMode, renderBlobPreview, renderStructuredPreview } from "./artifact-preview.js";
import { isExecutionLogArtifact, isFinalDeliveryArtifact } from "./artifact-display.js";
import { cancellationTarget } from "./cancellation-target.js";
import { isNearBottom, nextScrollTop } from "./scroll-follow.js";
import { conversationMessagesFromTurns } from "./conversation-history.js";
import { commandToolCallIds, executionActivities } from "./execution-detail-projection.js";
import { observeAssignment } from "./assignment-stream.js";
import { autoResizeComposerInput, resetComposerInput, shouldSubmitComposerOnKeydown } from "./composer-input.js";

const api = String(globalThis.AGENTLOOP_ROUTER_URL || "http://127.0.0.1:8788").replace(/\/+$/, "");
const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "agentloop.multi-runtime.sessions.v1";
const IDENTITY_KEY = "agentloop.multi-runtime.identity.v1";
const WORKSPACE_WIDTH_KEY = "agentloop.multi-runtime.artifact-width.v1";
const MAX_PENDING_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const CONVERSATION_PAGE_SIZE = 30;
const ARTIFACT_PRODUCING_TOOLS = new Set([
  "computer_write_file",
  "computer_patch_file",
  "computer_run_command",
  "convert_artifact",
  "materialize_paginated_html",
  "verify_artifact_acceptance",
]);
const recoveredSessions = sortSessions(loadSessions());
let sessions = [];
let activeId;
let renderedConversationId;
let conversationVisibleLimit = CONVERSATION_PAGE_SIZE;
let conversationsNextOffset = 0;
let conversationsHasMore = false;
let conversationsLoadingMore = false;
const activeRunsByConversation = new Map();
const uploadingByConversation = new Map();
const cancellingAssignmentIds = new Set();
const hydratedDetailAssignmentIds = new Set();
let commandDetailSelection;
let inlineArtifactPreview;
let inlineArtifactPreviewUrl;
let artifactPanelOpen = false;
let artifactPanelWidth = loadArtifactPanelWidth();
let resizeState;
const liveUpdates = createCoalescedUpdater({ render, persist: saveSessions });

loadIdentity();
void loadConversationPage(true);
void loadModels();
void loadRuntimes();
render();
document.querySelectorAll("[data-suggest]").forEach((button) => button.addEventListener("click", () => { $("input").value = button.dataset.suggest || ""; autoResizeComposerInput($("input")); $("input").focus(); }));
$("theme-toggle")?.addEventListener("click", () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "" : "dark"; });

$("new-chat").addEventListener("click", () => { activeId = newConversation().id; resetArtifactWorkspace(); render(); $("input").focus(); });
$("composer").addEventListener("submit", (event) => { event.preventDefault(); void submit(); });
$("cancel").addEventListener("click", () => void cancelActive());
$("upload-file").addEventListener("click", () => $("attachment").click());
$("attachment").addEventListener("change", () => void uploadAttachments($("attachment").files));
$("workspace-resizer").addEventListener("pointerdown", beginWorkspaceResize);
$("workspace-resizer").addEventListener("keydown", handleWorkspaceResizeKeydown);
$("workspace-resizer").addEventListener("dblclick", resetArtifactPanelWidth);
$("artifact-panel-close").addEventListener("click", () => { resetArtifactWorkspace(); render(); });
$("artifact-fullscreen").addEventListener("click", () => void openSelectedArtifactFullscreen());
$("input").addEventListener("keydown", (event) => {
  if (shouldSubmitComposerOnKeydown(event)) { event.preventDefault(); void submit(); }
});
$("input").addEventListener("input", () => autoResizeComposerInput($("input")));
$("user-id").addEventListener("change", reloadConversationsForIdentity);
$("tenant-id").addEventListener("change", reloadConversationsForIdentity);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeCommandDetail();
});

function newConversation() {
  const conversation = { id: crypto.randomUUID(), title: "新对话", createdAt: Date.now(), updatedAt: Date.now(), messages: [], pendingAttachments: [] };
  sessions.unshift(conversation);
  saveSessions();
  return conversation;
}

function activeConversation() { return sessions.find((item) => item.id === activeId) ?? sessions[0]; }
function saveSessions() { persistSessions(localStorage, sessions); }
function loadSessions() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value.map((conversation) => {
      if (conversation === null || typeof conversation !== "object" || !Array.isArray(conversation.messages)) return conversation;
      return {
        ...conversation,
        messages: conversation.messages.map((message) => message?.role === "assistant" && Array.isArray(message.events)
          ? { ...message, events: mergeRuntimeEvents([], message.events) }
          : message),
      };
    });
  } catch {
    return [];
  }
}
function loadIdentity() { try { const value = JSON.parse(localStorage.getItem(IDENTITY_KEY) || "{}"); if (value.tenantId) $("tenant-id").value = value.tenantId; if (value.userId) $("user-id").value = value.userId; } catch {} }
function saveIdentity() { persistJson(localStorage, IDENTITY_KEY, { tenantId: $("tenant-id").value.trim(), userId: $("user-id").value.trim() }); }

function loadArtifactPanelWidth() {
  const stored = Number(localStorage.getItem(WORKSPACE_WIDTH_KEY));
  return Number.isFinite(stored) ? stored : 360;
}

function artifactPanelWidthBounds() {
  const workspace = $("workspace");
  const available = workspace?.getBoundingClientRect().width || window.innerWidth;
  return { min: 300, max: Math.max(420, Math.min(720, available * 0.62)), leftMin: 460 };
}

function clampArtifactPanelWidth(value) {
  const bounds = artifactPanelWidthBounds();
  const maxByLeft = Math.max(bounds.min, (($("workspace")?.getBoundingClientRect().width || window.innerWidth) - bounds.leftMin - 12));
  return Math.round(Math.min(Math.max(value, bounds.min), Math.min(bounds.max, maxByLeft)));
}

function applyArtifactPanelWidth() {
  artifactPanelWidth = clampArtifactPanelWidth(artifactPanelWidth);
  $("workspace")?.style.setProperty("--artifact-width", `${artifactPanelWidth}px`);
  const resizer = $("workspace-resizer");
  resizer?.setAttribute("aria-valuenow", String(artifactPanelWidth));
}

function beginWorkspaceResize(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  artifactPanelWidth = clampArtifactPanelWidth(artifactPanelWidth);
  resizeState = { startX: event.clientX, startWidth: artifactPanelWidth };
  document.body.classList.add("workspace-resizing");
  document.addEventListener("pointermove", updateWorkspaceResize);
  document.addEventListener("pointerup", finishWorkspaceResize, { once: true });
  document.addEventListener("pointercancel", finishWorkspaceResize, { once: true });
}

function updateWorkspaceResize(event) {
  if (!resizeState) return;
  artifactPanelWidth = clampArtifactPanelWidth(resizeState.startWidth + resizeState.startX - event.clientX);
  applyArtifactPanelWidth();
}

function finishWorkspaceResize() {
  if (!resizeState) return;
  resizeState = undefined;
  document.body.classList.remove("workspace-resizing");
  document.removeEventListener("pointermove", updateWorkspaceResize);
  persistJson(localStorage, WORKSPACE_WIDTH_KEY, artifactPanelWidth);
  render();
}

function handleWorkspaceResizeKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const bounds = artifactPanelWidthBounds();
  artifactPanelWidth = event.key === "Home" ? bounds.max : event.key === "End" ? bounds.min : artifactPanelWidth + (event.key === "ArrowLeft" ? 24 : -24);
  applyArtifactPanelWidth();
  persistJson(localStorage, WORKSPACE_WIDTH_KEY, artifactPanelWidth);
  render();
}

function resetArtifactPanelWidth() {
  artifactPanelWidth = 360;
  applyArtifactPanelWidth();
  persistJson(localStorage, WORKSPACE_WIDTH_KEY, artifactPanelWidth);
  render();
}

function reloadConversationsForIdentity() {
  saveIdentity();
  void loadConversationPage(true);
}

async function loadConversationPage(reset = false) {
  if (conversationsLoadingMore || (!reset && !conversationsHasMore)) return;
  const tenantId = $("tenant-id").value.trim();
  const userId = $("user-id").value.trim();
  if (!tenantId || !userId) return;
  const offset = reset ? 0 : conversationsNextOffset;
  conversationsLoadingMore = true;
  render();
  try {
    const response = await fetch(`${api}/v1/conversations?limit=${CONVERSATION_PAGE_SIZE}&offset=${offset}`, {
      headers: { "x-tenant-id": tenantId, "x-user-id": userId },
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok || !Array.isArray(body?.conversations)) throw new Error(body?.error || `HTTP ${response.status}`);
    mergeConversationSummaries(body.conversations, reset);
    if (reset) conversationVisibleLimit = CONVERSATION_PAGE_SIZE;
    else conversationVisibleLimit += CONVERSATION_PAGE_SIZE;
    conversationsHasMore = body.hasMore === true;
    conversationsNextOffset = Number.isSafeInteger(body.nextOffset) ? body.nextOffset : offset + body.conversations.length;
    activeId = activeConversation()?.id ?? newConversation().id;
    if (reset) void reconcilePersistedRuns();
  } catch (error) {
    if (reset && sessions.length === 0) {
      sessions = [...recoveredSessions];
      activeId = sessions[0]?.id ?? newConversation().id;
      setStatus("会话列表加载失败，已显示本地恢复缓存", "error");
    } else if (!reset) {
      setStatus(`加载更多对话失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  } finally {
    conversationsLoadingMore = false;
    render();
  }
}

function mergeConversationSummaries(summaries, reset = false) {
  const byId = new Map([...recoveredSessions, ...sessions].map((conversation) => [conversation.id, conversation]));
  const nextSessions = reset ? [...sessions] : sessions;
  for (const summary of summaries) {
    if (!summary || typeof summary.id !== "string") continue;
    const existing = byId.get(summary.id);
    if (existing) {
      existing.title = existing.title && existing.title !== "新对话" ? existing.title : String(summary.title || "新对话");
      existing.createdAt = finiteNumber(existing.createdAt, summary.createdAt);
      // Server activity time is authoritative, including downward corrections
      // after a stale observation polluted browser cache ordering.
      existing.updatedAt = activeRunsByConversation.has(existing.id)
        ? Math.max(finiteNumber(existing.updatedAt, 0), finiteNumber(summary.updatedAt, 0))
        : finiteNumber(summary.updatedAt, existing.updatedAt);
      existing.runCount = finiteNumber(summary.runCount, existing.runCount);
      existing.lastStatus = typeof summary.lastStatus === "string" ? summary.lastStatus : existing.lastStatus;
      if (!nextSessions.some((conversation) => conversation.id === existing.id)) nextSessions.push(existing);
      continue;
    }
    const conversation = {
      id: summary.id,
      title: String(summary.title || "新对话"),
      createdAt: finiteNumber(summary.createdAt, Date.now()),
      updatedAt: finiteNumber(summary.updatedAt, 0),
      runCount: finiteNumber(summary.runCount, 0),
      lastStatus: typeof summary.lastStatus === "string" ? summary.lastStatus : undefined,
      messages: [],
      pendingAttachments: [],
      historyLoaded: false,
    };
    nextSessions.push(conversation);
    byId.set(conversation.id, conversation);
  }
  sessions = sortSessions(nextSessions);
}

function sortSessions(values) {
  return [...values].sort((left, right) => finiteNumber(right?.updatedAt, 0) - finiteNumber(left?.updatedAt, 0) || String(right?.id || "").localeCompare(String(left?.id || "")));
}

function finiteNumber(value, fallback) { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }

async function selectConversation(conversationId) {
  const conversation = sessions.find((item) => item.id === conversationId);
  if (!conversation) return;
  resetArtifactWorkspace();
  activeId = conversation.id;
  render();
  void reconcilePersistedRuns();
  if (conversation.historyLoaded === true || conversation.historyLoading === true) return;
  if (conversation.historyLoaded !== false && conversation.messages.length > 0) return;
  if (finiteNumber(conversation.runCount, 0) === 0) { conversation.historyLoaded = true; return; }
  const tenantId = $("tenant-id").value.trim();
  const userId = $("user-id").value.trim();
  if (!tenantId || !userId) return;
  conversation.historyLoading = true;
  setStatus("正在加载会话内容", "running");
  render();
  try {
    const response = await fetch(`${api}/v1/conversations/${encodeURIComponent(conversation.id)}`, {
      headers: { "x-tenant-id": tenantId, "x-user-id": userId },
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok || !Array.isArray(body?.turns)) throw new Error(body?.error || `HTTP ${response.status}`);
    conversation.messages = conversationMessagesFromTurns(body.turns);
    render();
    await Promise.all(conversation.messages
      .filter((message) => message.role === "assistant" && typeof message.assignmentId === "string" && message.status === "running")
      .map((assistant) => hydratePersistedAssistant(assistant, tenantId, userId)));
    const selected = selectedAssistantMessage(conversation);
    if (selected?.assignmentId) {
      conversation.selectedAssistantId = selected.id;
      await hydrateCommandEvidence(selected, tenantId, userId);
      hydratedDetailAssignmentIds.add(selected.assignmentId);
    }
    conversation.historyLoaded = true;
    for (const message of conversation.messages) {
      if (message.role === "assistant" && message.status === "running" && message.assignmentId) resumeAssignmentObservation(conversation, message, tenantId, userId);
    }
    saveSessions();
    setStatus("会话内容已加载", "ok");
  } catch (error) {
    setStatus(`加载会话内容失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    conversation.historyLoading = false;
    render();
  }
}

function resetArtifactWorkspace() {
  artifactPanelOpen = false;
  inlineArtifactPreview = undefined;
  if (inlineArtifactPreviewUrl) {
    URL.revokeObjectURL(inlineArtifactPreviewUrl);
    inlineArtifactPreviewUrl = undefined;
  }
}

async function hydratePersistedAssistant(assistant, tenantId, userId, includeCommandEvidence = false) {
  let runLoaded = false;
  try {
    const response = await fetch(`${api}/v1/assignments/${encodeURIComponent(assistant.assignmentId)}`, {
      headers: { "x-tenant-id": tenantId, "x-user-id": userId },
    });
    if (response.ok) {
      const body = await response.json();
      runLoaded = body?.run !== undefined;
      applyRecoveredRunState(assistant, body?.run);
    }
  } catch {}
  const eventsLoaded = await replayPersistedRunEvents(assistant, tenantId, userId);
  if (!runLoaded && !eventsLoaded) throw new Error("无法读取该轮的 Runtime Run");
  // Artifact projection is independent from terminal Run status: a generated
  // product must survive reconnects and remain visible while the Run is live.
  await refreshArtifacts(assistant.assignmentId, assistant, tenantId, userId);
  if (assistant.status === "running") await refreshHumanLoop(assistant.assignmentId, assistant, tenantId, userId);
  if (includeCommandEvidence) await hydrateCommandEvidence(assistant, tenantId, userId);
}

async function reconcilePersistedRuns() {
  const tenantId = $("tenant-id").value.trim();
  const userId = $("user-id").value.trim();
  if (!tenantId || !userId) return;
  let changed = false;
  await Promise.all(sessions.flatMap((conversation) => (conversation.messages || []).map(async (message) => {
    if (message?.role !== "assistant" || typeof message.assignmentId !== "string" || activeRunsByConversation.has(conversation.id)) return;
    const confirmedTerminal = (message.events || []).some((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.type));
    if (message.status !== "running" && !(message.status === "failed" && !confirmedTerminal) && !hasIncompleteCompletedPlan(message)) return;
    if (message.status === "running") {
      resumeAssignmentObservation(conversation, message, tenantId, userId);
      return;
    }
    try {
      const response = await fetch(`${api}/v1/assignments/${encodeURIComponent(message.assignmentId)}`, { headers: { "x-tenant-id": tenantId, "x-user-id": userId } });
      if (!response.ok) return;
      const body = await response.json();
      if (applyRecoveredRunState(message, body?.run)) changed = true;
      if (await replayPersistedRunEvents(message, tenantId, userId)) changed = true;
      if (await refreshHumanLoop(message.assignmentId, message, tenantId, userId)) changed = true;
      if (message.status === "running") resumeAssignmentObservation(conversation, message, tenantId, userId);
    } catch {}
  })));
  if (changed) { saveSessions(); render(); }
}

function applyRecoveredRunState(assistant, run) {
  if (run?.status === "running") {
    if ((assistant.events || []).some((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.type))) return false;
    if (assistant.status === "failed") {
      // Repair old browser caches that recorded a transport error as a Run failure.
      assistant.status = "running"; assistant.error = undefined; assistant.text = ""; assistant.completedAt = undefined;
      return true;
    }
    return false;
  }
  if (!run || !["completed", "failed", "cancelled"].includes(run.status)) return false;
  assistant.status = run.status;
  assistant.connection = undefined;
  assistant.error = undefined;
  if (run.status === "completed" && typeof run.output === "string") assistant.text = run.output;
  if (run.status === "failed") {
    assistant.error = recoveredFailureMessage(run) || assistant.error || "本次未能形成可提交的最终结果，以下说明可供参考。";
    // Only the Host's explicit projection is eligible for this user-facing
    // section; never infer it from the generic Runtime `output` field here.
    if (typeof run.partialOutput === "string" && run.partialOutput.trim()) assistant.partialText = run.partialOutput;
    assistant.text = "";
  }
  assistant.reasoning = "";
  assistant.recovery = undefined;
  if (run.checkpoint?.id) assistant.checkpoint = { ...run.checkpoint, status: run.checkpoint.childRunId ? "started" : "available" };
  assistant.humanLoop = undefined;
  completeAssistantMessage(assistant, { createdAt: run.finishedAt });
  return true;
}

function recoveredFailureMessage(run) {
  switch (run?.errorCode) {
    case "RUN_LIMIT_EXCEEDED":
      return "本次处理时间较长，暂未形成最终结果；以下说明可供参考。";
    case "STEP_NOT_COMPLETED":
      return "本次结果尚未完成最终确认，以下说明可供参考。";
    case "ASSESSMENT_ERROR":
      return "系统正在核对结果，暂未形成最终结论；以下说明可供参考。";
    case "MODEL_ERROR":
      return "本次处理暂时未能完成，以下说明可供参考。";
    case "TOOL_EXECUTION_ERROR":
      return "部分处理未能继续完成，以下说明可供参考。";
    case "TOOL_POLICY_DENIED":
    case "FORBIDDEN":
      return "当前内容需要更多权限才能继续处理，以下说明可供参考。";
    default:
      return "本次未能形成可提交的最终结果，以下说明可供参考。";
  }
}

async function replayPersistedRunEvents(assistant, tenantId, userId) {
  try {
    const response = await fetch(`${api}/v1/assignments/${encodeURIComponent(assistant.assignmentId)}/events`, { headers: { "x-tenant-id": tenantId, "x-user-id": userId } });
    if (!response.ok) return false;
    const body = await response.json();
    const events = Array.isArray(body?.events) ? body.events : [];
    if (events.length === 0) return false;
    setVolatile(assistant, "detailEvents", events);
    const terminal = replayAssistantEvents(assistant, events);
    if (terminal) completeAssistantMessage(assistant, events.at(-1));
    return true;
  } catch {
    return false;
  }
}

async function hydrateCommandEvidence(assistant, tenantId, userId) {
  if (!assistant?.assignmentId) return;
  const events = assistant.detailEvents || assistant.events || [];
  const evidence = {};
  await Promise.all(commandToolCallIds(events).map(async (toolCallId) => {
    const base = `${api}/v1/assignments/${encodeURIComponent(assistant.assignmentId)}`;
    const headers = { "x-tenant-id": tenantId, "x-user-id": userId };
    const [argumentsResult, stdoutResult, stderrResult] = await Promise.allSettled([
      fetch(`${base}/tool-arguments/${encodeURIComponent(toolCallId)}`, { headers }).then(readJsonResponse),
      fetch(`${base}/commands/${encodeURIComponent(toolCallId)}/stdout`, { headers }).then(readJsonResponse),
      fetch(`${base}/commands/${encodeURIComponent(toolCallId)}/stderr`, { headers }).then(readJsonResponse),
    ]);
    evidence[toolCallId] = {
      ...(argumentsResult.status === "fulfilled" && recordValue(argumentsResult.value?.arguments?.arguments) ? { arguments: argumentsResult.value.arguments.arguments } : {}),
      ...(stdoutResult.status === "fulfilled" && typeof stdoutResult.value?.output?.content === "string" ? { stdout: stdoutResult.value.output.content } : {}),
      ...(stderrResult.status === "fulfilled" && typeof stderrResult.value?.output?.content === "string" ? { stderr: stderrResult.value.output.content } : {}),
    };
  }));
  setVolatile(assistant, "commandEvidence", evidence);
}

async function readJsonResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

function setVolatile(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: false });
}

function mergeDetailEvents(currentEvents, incomingEvents) {
  const bySequence = new Map();
  for (const event of [...(currentEvents || []), ...(incomingEvents || [])]) {
    if (event && Number.isSafeInteger(event.seq)) bySequence.set(event.seq, event);
  }
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}

async function loadModels() {
  try {
    const response = await fetch(`${api}/v1/models`);
    const body = await response.json();
    const models = Array.isArray(body.models) ? body.models : [];
    $("model-select").innerHTML = `<option value="">使用 Runtime 默认模型</option>` + models.map((model) => `<option value="${escapeHtml(model.key)}">${escapeHtml(model.displayName || model.key)}</option>`).join("");
    if (models[0]) setStatus(models[0].displayName || models[0].key, "ok");
  } catch { $("runtime-status").textContent = "模型目录暂不可用"; }
}

async function loadRuntimes() {
  try {
    const response = await fetch(`${api}/v1/runtimes`);
    const body = await response.json();
    const runtimes = Array.isArray(body.runtimes) ? body.runtimes.filter((runtime) => runtime && typeof runtime.id === "string" && runtime.id.length > 0) : [];
    $("runtime").innerHTML = `<option value="">自动</option>` + runtimes.map((runtime) => `<option value="${escapeHtml(runtime.id)}">${escapeHtml(runtime.id)}</option>`).join("");
  } catch {
    // Auto-routing remains a valid safe fallback when the optional catalog is unavailable.
  }
}

async function submit() {
  const input = $("input").value.trim();
  const conversation = activeConversation();
  if (!input || !conversation) return;
  if (activeRunsByConversation.has(conversation.id) || conversation.messages.some((message) => message.role === "assistant" && message.status === "running" && message.assignmentId)) { setStatus("当前会话仍在发起或执行；请等待或点击停止", "error"); return; }
  if (uploadCount(conversation.id) > 0) { setStatus("文件仍在上传，请稍候再发送", "error"); return; }
  const tenantId = $("tenant-id").value.trim();
  const ownerUserId = $("user-id").value.trim();
  if (!tenantId || !ownerUserId) { setStatus("请先填写用户和租户 ID", "error"); return; }
  saveIdentity();
  const attachments = pendingAttachments(conversation);
  const activeRun = { assignmentId: null, abortController: null, submitAbortController: new AbortController(), submitTimedOut: false, submitTimeout: null, assistant: null };
  activeRunsByConversation.set(conversation.id, activeRun);
  conversation.pendingAttachments = [];
  const submittedAt = Date.now();
  const userMessage = { id: crypto.randomUUID(), role: "user", text: input, attachments, createdAt: submittedAt };
  const assistantMessage = { id: crypto.randomUUID(), role: "assistant", text: "", reasoning: "", status: "running", events: [], plan: [], createdAt: submittedAt };
  setVolatile(assistantMessage, "detailEvents", []);
  conversation.messages.push(userMessage, assistantMessage);
  conversation.selectedAssistantId = assistantMessage.id;
  activeRun.assistant = assistantMessage;
  conversation.title = conversation.title === "新对话" ? input.slice(0, 36) : conversation.title;
  conversation.updatedAt = Date.now();
  saveSessions();
  $("input").value = "";
  resetComposerInput($("input"));
  render();
  setStatus("正在分配 Runtime…", "running");
  try {
    const payload = { conversationId: conversation.id, clientMessageId: userMessage.id, input, attachmentIds: attachments.map((attachment) => attachment.id), ...($("runtime").value ? { requestedRuntimeId: $("runtime").value } : {}), ...($("model-select").value ? { requestedModelKey: $("model-select").value } : {}) };
    activeRun.submitTimeout = setTimeout(() => { activeRun.submitTimedOut = true; activeRun.submitAbortController.abort(); }, 15_000);
    const body = await call("/v1/tasks", tenantId, ownerUserId, payload, activeRun.submitAbortController.signal);
    clearTimeout(activeRun.submitTimeout);
    activeRun.submitTimeout = null;
    activeRun.assignmentId = body.assignment.id;
    assistantMessage.assignmentId = activeRun.assignmentId;
    assistantMessage.runtimeId = body.assignment.runtimeId;
    setStatus(`已分配 ${body.assignment.runtimeId} · SSE 连接中`, "running");
    $("cancel").disabled = false;
    saveSessions();
    render();
    await streamAssignment(activeRun.assignmentId, conversation, assistantMessage, tenantId, ownerUserId, activeRun);
  } catch (error) {
    if (activeRun.assignmentId) {
      if (error?.name !== "AbortError") setStatus("观察连接中断，任务状态以 Runtime 为准；重新打开会话可继续同步", "error");
    } else if (error?.name !== "AbortError" || activeRun.submitTimedOut) { assistantMessage.status = "failed"; assistantMessage.text = activeRun.submitTimedOut ? "发起会话超时，请重试" : `提交失败：${error instanceof Error ? error.message : String(error)}`; completeAssistantMessage(assistantMessage); saveSessions(); render(); setStatus("任务失败", "error"); }
  } finally {
    if (activeRun.submitTimeout !== null) clearTimeout(activeRun.submitTimeout);
    if (activeRunsByConversation.get(conversation.id) === activeRun) activeRunsByConversation.delete(conversation.id);
    render();
  }
}

async function uploadAttachments(fileList) {
  const conversation = activeConversation();
  const tenantId = $("tenant-id").value.trim();
  const ownerUserId = $("user-id").value.trim();
  const selected = [...(fileList || [])].slice(0, Math.max(0, MAX_PENDING_ATTACHMENTS - pendingAttachments(conversation).length));
  $("attachment").value = "";
  if (!conversation || selected.length === 0 || activeRunsByConversation.has(conversation.id)) return;
  if (!tenantId || !ownerUserId) { setStatus("请先填写用户和租户 ID", "error"); return; }
  saveIdentity();
  const rejected = selected.filter((file) => file.size > MAX_ATTACHMENT_BYTES);
  const uploadable = selected.filter((file) => file.size <= MAX_ATTACHMENT_BYTES);
  const failures = rejected.map(attachmentSizeError);
  if (uploadable.length === 0) {
    setStatus(uploadFailureStatus(failures), "error");
    return;
  }
  changeUploadCount(conversation.id, uploadable.length);
  render();
  try {
    for (const file of uploadable) {
      try {
        const body = await call("/v1/attachments", tenantId, ownerUserId, {
          conversationId: conversation.id,
          originalName: file.name,
          mediaType: file.type || "application/octet-stream",
          contentBase64: await toBase64(file),
        });
        const attachment = body?.attachment;
        if (!attachment || typeof attachment.id !== "string" || typeof attachment.originalName !== "string" || typeof attachment.byteSize !== "number") {
          throw new Error("上传服务返回的附件无效");
        }
        conversation.pendingAttachments = [...pendingAttachments(conversation), attachment].slice(0, MAX_PENDING_ATTACHMENTS);
        saveSessions();
      } catch (error) {
        failures.push(uploadFailureMessage(file, error));
      } finally {
        changeUploadCount(conversation.id, -1);
        render();
      }
    }
  } finally {
    if (uploadCount(conversation.id) === 0 && !activeRunsByConversation.has(conversation.id)) {
      setStatus(failures.length > 0 ? uploadFailureStatus(failures) : "文件已准备好", failures.length > 0 ? "error" : "ok");
    }
  }
}

function attachmentSizeError(file, limit = MAX_ATTACHMENT_BYTES) {
  return `“${file.name}”为 ${formatBytes(file.size)}，超过单个文件 ${formatBytes(limit)} 上限（超出 ${formatBytes(file.size - limit)}），未上传`;
}

function uploadFailureMessage(file, error) {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^attachment exceeds (\d+) bytes$/.exec(message);
  return match === null ? `“${file.name}”上传失败：${message}` : attachmentSizeError(file, Number(match[1]));
}

function uploadFailureStatus(failures) {
  return failures.length === 1 ? failures[0] : `${failures[0]}；另有 ${failures.length - 1} 个文件未上传`;
}

function pendingAttachments(conversation) {
  return Array.isArray(conversation?.pendingAttachments) ? conversation.pendingAttachments : [];
}

function uploadCount(conversationId) {
  return uploadingByConversation.get(conversationId) || 0;
}

function changeUploadCount(conversationId, delta) {
  const next = Math.max(0, uploadCount(conversationId) + delta);
  if (next === 0) uploadingByConversation.delete(conversationId);
  else uploadingByConversation.set(conversationId, next);
}

function removePendingAttachment(conversation, attachmentId) {
  if (!conversation || activeRunsByConversation.has(conversation.id)) return;
  conversation.pendingAttachments = pendingAttachments(conversation).filter((attachment) => attachment.id !== attachmentId);
  saveSessions();
  render();
}

async function streamAssignment(assignmentId, conversation, assistant, tenantId, userId, activeRun) {
  activeRun.abortController = new AbortController();
  await observeAssignment({
    baseUrl: `${api}/v1/assignments/${encodeURIComponent(assignmentId)}`,
    headers: { "x-tenant-id": tenantId, "x-user-id": userId },
    signal: activeRun.abortController.signal,
    afterSeq: Math.max(0, ...(assistant.events || []).map((event) => Number.isSafeInteger(event.seq) ? event.seq : 0)),
    onEvent: (event) => onEvent(event, conversation, assistant),
    onRun: (run) => {
      applyRecoveredRunState(assistant, run);
      liveUpdates.flush();
      setStatus(run.status === "completed" ? "已完成" : run.status === "cancelled" ? "已停止" : "执行失败", run.status === "completed" ? "ok" : "error");
    },
    onConnection: (state, error) => {
      assistant.connection = state;
      setStatus(state === "connected" ? "已连接 Runtime 事件流" : `连接暂时中断，正在重连；尚未确认任务终态${error ? `：${error}` : ""}`, state === "connected" ? "running" : "error");
    },
  });
  if (["completed", "failed", "cancelled"].includes(assistant.status)) {
    await Promise.all([refreshArtifacts(assignmentId, assistant, tenantId, userId), hydrateCommandEvidence(assistant, tenantId, userId)]);
  }
}

function resumeAssignmentObservation(conversation, assistant, tenantId, userId) {
  if (activeRunsByConversation.has(conversation.id)) return;
  const activeRun = { assignmentId: assistant.assignmentId, abortController: null, assistant };
  activeRunsByConversation.set(conversation.id, activeRun);
  void streamAssignment(assistant.assignmentId, conversation, assistant, tenantId, userId, activeRun)
    .catch(() => { setStatus("观察连接中断，任务状态以 Runtime 为准", "error"); })
    .finally(() => {
      if (activeRunsByConversation.get(conversation.id) === activeRun) activeRunsByConversation.delete(conversation.id);
      saveSessions(); render();
    });
}

function onEvent(event, conversation, assistant) {
  if (!event || typeof event.type !== "string") return false;
  if (event.type === "error" || event.type === "stream.error") { setStatus("事件流暂时不可用，任务状态以 Runtime 为准", "error"); return false; }
  const terminal = projectAssistantEvent(assistant, event);
  assistant.events = mergeRuntimeEvents(assistant.events, [event]);
  setVolatile(assistant, "detailEvents", mergeDetailEvents(assistant.detailEvents, [event]));
  if (assistant.assignmentId && isArtifactProjectionEvent(event)) {
    void refreshArtifacts(assistant.assignmentId, assistant, $("tenant-id").value.trim(), $("user-id").value.trim());
  }
  if (terminal) { assistant.connection = undefined; completeAssistantMessage(assistant, event); }
  conversation.updatedAt = Math.max(finiteNumber(conversation.updatedAt, 0), finiteNumber(event.createdAt, 0));
  if (event.type === "run.waiting_user" && assistant.assignmentId) {
    void refreshHumanLoop(assistant.assignmentId, assistant, $("tenant-id").value.trim(), $("user-id").value.trim()).then((changed) => { if (changed) { saveSessions(); render(); } });
    setStatus("等待你的确认或补充信息", "running");
  }
  if (terminal) { liveUpdates.flush(); setStatus(event.type === "run.completed" ? "已完成" : event.type === "run.cancelled" ? "已停止" : "执行失败", assistant.status === "completed" ? "ok" : "error"); return true; }
  liveUpdates.request();
  return false;
}

function isArtifactProjectionEvent(event) {
  if (event?.type === "candidate.approved" || event?.type === "plan.step.completed" || event?.type === "terminal.delivery_committed" || event?.type === "run.completed") return true;
  if (event?.type !== "tool.completed") return false;
  const toolName = String(event.data?.toolName || "");
  if (!ARTIFACT_PRODUCING_TOOLS.has(toolName)) return false;
  if (toolName !== "computer_run_command") return true;
  try {
    const result = JSON.parse(typeof event.data?.result === "string" ? event.data.result : "{}");
    return (Array.isArray(result?.fileChanges) && result.fileChanges.some((change) => change?.changeType !== "deleted"))
      || (typeof result?.stdout === "string" && /\.(?:pdf|png|jpe?g|webp|gif|svg|html?|md|txt|csv|json|docx?|pptx|xlsx)\b/iu.test(result.stdout));
  } catch {
    return false;
  }
}

async function refreshArtifacts(assignmentId, assistant, tenantId, userId) {
  try {
    const response = await fetch(`${api}/v1/assignments/${encodeURIComponent(assignmentId)}/artifacts`, { headers: { "x-tenant-id": tenantId, "x-user-id": userId } });
    if (!response.ok) return;
    const body = await response.json();
    assistant.artifacts = Array.isArray(body.artifacts) ? body.artifacts : [];
    saveSessions();
    render();
  } catch {}
}

async function cancelActive() {
  const conversation = activeConversation();
  if (!conversation) return;
  const target = cancellationTarget(activeRunsByConversation.get(conversation.id), conversation.messages);
  if (!target.canCancel || !target.assistant) return;
  if (!target.assignmentId) {
    if (target.activeRun?.assistant) {
      target.activeRun.assistant.status = "cancelled";
      target.activeRun.assistant.text = "已停止发起会话";
      target.activeRun.assistant.reasoning = "";
      completeAssistantMessage(target.activeRun.assistant);
      saveSessions();
      render();
    }
    target.activeRun?.submitAbortController?.abort();
    setStatus("已停止发起会话", "error");
    return;
  }
  if (cancellingAssignmentIds.has(target.assignmentId)) return;
  cancellingAssignmentIds.add(target.assignmentId);
  render();
  try {
    const response = await fetch(`${api}/v1/assignments/${encodeURIComponent(target.assignmentId)}/cancel`, { method: "POST", headers: { "x-tenant-id": $("tenant-id").value.trim(), "x-user-id": $("user-id").value.trim() } });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    if (!applyRecoveredRunState(target.assistant, body?.run)) throw new Error("停止请求未返回可确认的终态");
    target.activeRun?.abortController?.abort();
    saveSessions();
    setStatus(body.run.status === "cancelled" ? "已停止" : body.run.status === "completed" ? "已完成" : "执行失败", body.run.status === "completed" ? "ok" : "error");
  } catch (error) {
    setStatus(`停止失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    cancellingAssignmentIds.delete(target.assignmentId);
    render();
  }
}

function render() {
  const conversation = activeConversation(); if (!conversation) return;
  applyArtifactPanelWidth();
  $("workspace")?.classList.toggle("artifact-open", artifactPanelOpen && inlineArtifactPreview !== undefined);
  const conversationScroll = $("conversation-scroll");
  const followConversation = renderedConversationId !== conversation.id || isNearBottom(conversationScroll);
  const previousReasoning = document.querySelector(".reasoning-body");
  const followReasoning = previousReasoning === null || isNearBottom(previousReasoning);
  const previousReasoningTop = previousReasoning?.scrollTop ?? 0;
  activeId = conversation.id; $("conversation-title").textContent = conversation.title; $("conversation-id").textContent = `conversation: ${conversation.id}`;
  const orderedSessions = sortSessions(sessions);
  const visibleSessions = orderedSessions.slice(0, conversationVisibleLimit);
  const canLoadMoreConversations = conversationsHasMore || orderedSessions.length > visibleSessions.length;
  $("sessions").innerHTML = visibleSessions.map((item) => `<div class="session-wrap"><button type="button" class="session ${item.id === activeId ? "active" : ""}" data-session="${item.id}"><span class="session-dot"></span><span class="session-body"><span class="session-title">${escapeHtml(item.title)}</span><span class="session-time">${conversationTurnLabel(item)}</span></span></button><button type="button" class="session-delete" data-delete-session="${item.id}" aria-label="删除会话">×</button></div>`).join("") + (canLoadMoreConversations ? `<button id="load-more-conversations" class="sessions-more" type="button" ${conversationsLoadingMore ? "disabled" : ""}>${conversationsLoadingMore ? "加载中…" : "加载更多对话"}</button>` : "");
  document.querySelectorAll("[data-session]").forEach((button) => button.addEventListener("click", () => void selectConversation(button.dataset.session)));
  $("load-more-conversations")?.addEventListener("click", () => {
    if (conversationsHasMore) void loadConversationPage(false);
    else { conversationVisibleLimit += CONVERSATION_PAGE_SIZE; render(); }
  });
  document.querySelectorAll("[data-delete-session]").forEach((button) => button.addEventListener("click", () => { sessions = sessions.filter((item) => item.id !== button.dataset.deleteSession); if (activeId === button.dataset.deleteSession) activeId = sessions[0]?.id ?? newConversation().id; saveSessions(); render(); }));
  const messages = conversation.messages || []; $("empty-state").hidden = messages.length > 0; $("messages").innerHTML = messages.map(renderMessage).join("");
  document.querySelectorAll("[data-assistant-message]").forEach((card) => {
    const select = () => void selectAssistantTurn(conversation, card.dataset.assistantMessage);
    card.addEventListener("click", (event) => { if (!event.target.closest("button, input, label, a")) select(); });
    card.addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && !event.target.closest("button, input, label, a")) { event.preventDefault(); select(); } });
  });
  document.querySelectorAll("[data-plan-toggle]").forEach((button) => button.addEventListener("click", () => {
    const assistant = messages.find((message) => message.id === button.dataset.planToggle);
    if (!assistant) return;
    assistant.planOpen = assistant.planOpen !== true;
    render();
  }));
  document.querySelectorAll("[data-trace-toggle]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const assistant = messages.find((message) => message.id === button.dataset.traceToggle);
    if (!assistant) return;
    assistant.traceOpen = assistant.traceOpen !== true;
    render();
  }));
  document.querySelectorAll("[data-other-artifacts-toggle]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const assistant = messages.find((message) => message.id === button.dataset.otherArtifactsToggle);
    if (!assistant) return;
    assistant.otherArtifactsOpen = assistant.otherArtifactsOpen !== true;
    render();
  }));
  document.querySelectorAll("[data-copy-message]").forEach((button) => button.addEventListener("click", () => {
    const message = messages.find((item) => item.id === button.dataset.copyMessage);
    if (message) void copyConversationMessage(message, button);
  }));
  document.querySelectorAll("[data-human-loop-submit]").forEach((button) => button.addEventListener("click", () => submitHumanLoop(button.dataset.humanLoopSubmit)));
  document.querySelectorAll("[data-human-loop-option]").forEach((input) => input.addEventListener("change", () => {
    rememberHumanLoopSelection(
      input.dataset.humanLoopMessage,
      input.dataset.humanLoopRequest,
      input.value,
      input.checked,
      Number(input.dataset.humanLoopMaxSelections),
    );
  }));
  document.querySelectorAll("[data-checkpoint-start]").forEach((button) => button.addEventListener("click", () => void startFromCheckpoint(button.dataset.checkpointStart)));
  const selectedAssistant = selectedAssistantMessage(conversation, messages);
  const activeRun = activeRunsByConversation.get(conversation.id);
  const cancelTarget = cancellationTarget(activeRun, messages);
  $("submit").disabled = activeRun !== undefined || uploadCount(conversation.id) > 0;
  $("cancel").disabled = !cancelTarget.canCancel || (cancelTarget.assignmentId !== undefined && cancellingAssignmentIds.has(cancelTarget.assignmentId));
  $("upload-file").disabled = activeRun !== undefined || uploadCount(conversation.id) > 0 || pendingAttachments(conversation).length >= MAX_PENDING_ATTACHMENTS;
  renderPendingAttachments(conversation);
  renderArtifacts(selectedAssistant);
  document.querySelectorAll("[data-artifact-card]").forEach((card) => card.addEventListener("click", (event) => {
    if (event.target.closest("button, a, input, select, textarea")) return;
    if (card.dataset.artifactPreviewable === "false") return;
    event.stopPropagation();
    void previewArtifact(card.dataset.artifactCard, card.dataset.artifactAssistant);
  }));
  document.querySelectorAll("[data-artifact-download]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    void downloadArtifact(button.dataset.artifactDownload, button.dataset.artifactAssistant);
  }));
  document.querySelectorAll("[data-artifact-preview]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    void previewArtifact(button.dataset.artifactPreview, button.dataset.artifactAssistant);
  }));
  conversationScroll.scrollTop = nextScrollTop(conversationScroll, followConversation, conversationScroll.scrollTop);
  const reasoningBody = document.querySelector(".reasoning-body");
  if (reasoningBody) reasoningBody.scrollTop = nextScrollTop(reasoningBody, followReasoning, previousReasoningTop);
  renderedConversationId = conversation.id;
}

function selectedAssistantMessage(conversation, messages = conversation?.messages || []) {
  const selected = messages.find((message) => message.role === "assistant" && message.id === conversation?.selectedAssistantId);
  return selected || [...messages].reverse().find((message) => message.role === "assistant");
}

function assistantTurnNumber(messages, assistant) {
  if (!assistant) return 0;
  return messages.filter((message) => message.role === "assistant").findIndex((message) => message.id === assistant.id) + 1;
}

async function selectAssistantTurn(conversation, messageId) {
  const assistant = (conversation?.messages || []).find((message) => message.role === "assistant" && message.id === messageId);
  if (!assistant) return;
  conversation.selectedAssistantId = assistant.id;
  saveSessions();
  render();
  if (!assistant.assignmentId || hydratedDetailAssignmentIds.has(assistant.assignmentId)) return;
  assistant.detailsLoading = true;
  render();
  try {
    await hydratePersistedAssistant(assistant, $("tenant-id").value.trim(), $("user-id").value.trim(), true);
    hydratedDetailAssignmentIds.add(assistant.assignmentId);
  } catch (error) {
    assistant.detailsError = error instanceof Error ? error.message : String(error);
  } finally {
    assistant.detailsLoading = false;
    saveSessions();
    render();
  }
}

function conversationTurnLabel(conversation) {
  if (conversation.messages?.length) return `${Math.ceil(conversation.messages.length / 2)} 轮`;
  if (finiteNumber(conversation.runCount, 0) > 0) return `${conversation.runCount} 轮`;
  return "空会话";
}

function renderMessage(message) {
  if (message.role === "user") {
    const attachments = Array.isArray(message.attachments) ? message.attachments : (message.files || []).map((name) => ({ originalName: name }));
    const askedAt = formatMessageTime(message.createdAt);
    return `<article class="msg user"><div class="msg-body"><div class="msg-bubble"><div class="msg-role">你</div>${attachments.length ? `<div class="msg-source-row" aria-label="本轮上传文件">${attachments.map(renderAttachmentChip).join("")}</div>` : ""}<div class="msg-text">${escapeHtml(message.text)}</div>${renderMessageFooter(message, askedAt ? `提问于 ${askedAt}` : "", "提问")}</div></div></article>`;
  }
  const presentation = assistantMessagePresentation(message.status);
  const isSelected = selectedAssistantMessage(activeConversation())?.id === message.id;
  const isLive = presentation.isLive;
  const plan = projectPlanStatuses(message.plan || [], message.events || [], message.status);
  const runtime = message.runtimeId ? ` · ${message.runtimeId}` : "";
  const reasoning = isLive && message.reasoning ? `<details class="live-reasoning" open><summary>模型思考</summary><div class="reasoning-body">${formatText(message.reasoning)}</div></details>` : "";
  const humanLoop = renderHumanLoop(message);
  const recovery = renderRecovery(message);
  const interimOutput = message.text ? (message.status === "completed" ? renderMarkdown(message.text) : formatText(message.text)) : "";
  // A pending Human-in-the-Loop request is the current actionable state. Keep
  // any useful interim model text, but never let it displace the response
  // controls the user needs in order to continue the Run.
  const projectedOutput = `${interimOutput}${humanLoop}${recovery}`;
  const emptyOutput = isLive ? `<span class="thinking"><i></i><i></i><i></i></span>` : `<span class="terminal-empty">${escapeHtml(presentation.emptyText)}</span>`;
  const output = message.status === "failed"
    ? `<div class="failure-title">${formatText(message.error || presentation.emptyText)}</div>${message.partialText ? `<div class="partial-result"><strong>本次处理说明</strong>${renderMarkdown(message.partialText)}</div>` : ""}${recovery}`
    : projectedOutput || emptyOutput;
  const stateLabel = message.humanLoop?.status === "open" ? "等待你的输入" : message.recovery?.status === "required" || message.recovery?.status === "advancing" ? "正在恢复" : presentation.label;
  const stateIcon = presentation.icon;
  const completedAt = formatMessageTime(message.completedAt);
  const duration = formatConversationDuration(message.createdAt, message.completedAt);
  const responseTiming = renderMessageFooter(message, completedAt ? `回答结束于 ${completedAt}${duration ? ` · 耗时 ${duration}` : ""}` : "", "回答");
  const hasPlan = plan.length;
  const planPanelId = `plan-${message.id}`;
  const stepToggle = hasPlan ? `<button type="button" class="live-step-toggle" data-plan-toggle="${message.id}" aria-expanded="${message.planOpen === true}" aria-controls="${planPanelId}">步骤 ${plan.filter((step) => step.status === "completed").length}/${plan.length}<span class="live-step-caret" aria-hidden="true">⌄</span></button>` : "";
  const planPanel = hasPlan && message.planOpen === true ? `<ol class="inline-plan-steps" id="${planPanelId}">${plan.map((step, index) => `<li><span class="step-dot ${step.status === "completed" ? "done" : step.status === "running" ? "running" : step.status === "failed" ? "error" : "pending"}"></span><span><b>${String(index + 1).padStart(2, "0")} ${escapeHtml(step.objective || step.id || "未命名步骤")}</b><small>${planStepLabel(step.status)}</small></span></li>`).join("")}</ol>` : "";
  const executionTrace = renderExecutionTrace(message);
  const liveEventIndicator = renderLiveEventIndicator(message);
  const inlineArtifacts = renderInlineArtifacts(message);
  return `<article class="msg assistant ${isLive ? "live" : "final"} ${isSelected ? "selected" : ""}" data-assistant-message="${escapeHtml(message.id)}" role="button" tabindex="0" aria-label="查看该轮执行详情" aria-pressed="${isSelected}"><div class="msg-avatar">A</div><div class="msg-body"><div class="live-card ${presentation.cardClass}"><div class="live-head"><span class="assistant-state ${message.status}">${stateIcon || (isLive ? `<span class="thinking"><i></i><i></i><i></i></span>` : "")}</span><span>AgentLoop${runtime} · ${stateLabel}</span>${liveEventIndicator}${stepToggle}</div>${planPanel}${reasoning}<div class="live-output-text md">${output}</div>${executionTrace}${inlineArtifacts}${responseTiming}</div></div></article>`;
}

function renderInlineArtifacts(assistant) {
  if (!assistant) return "";
  const artifacts = [...(Array.isArray(assistant.artifacts) ? assistant.artifacts : [])]
    .filter((artifact) => artifact && typeof artifact.id === "string" && !isExecutionLogArtifact(artifact))
    .sort((left, right) => (left.role === "final" ? -1 : 0) - (right.role === "final" ? -1 : 0));
  const finalArtifacts = artifacts.filter(isFinalDeliveryArtifact);
  const otherArtifacts = artifacts.filter((artifact) => !isFinalDeliveryArtifact(artifact));
  const events = assistant.detailEvents || assistant.events || [];
  const skills = executionActivities(events, assistant.commandEvidence).skills.filter((skill) => ["completed", "bound", "selected"].includes(skill.status));
  if (!finalArtifacts.length && !otherArtifacts.length && !skills.length) return "";
  const failed = assistant.status === "failed";
  const artifactBlock = finalArtifacts.length ? `<div class="inline-artifacts-head"><span>${failed ? "已生成文件" : "最终产物"}</span><small>${failed ? "尚未完成最终验收" : `${finalArtifacts.length} 个文件`}</small></div><div class="artifact-list">${finalArtifacts.map((artifact) => renderArtifactCard(artifact, assistant.id, assistant.status)).join("")}</div>` : "";
  const generatedBlock = assistant.status !== "completed" && otherArtifacts.length
    ? `<div class="inline-artifacts-head"><span>已生成产物</span><small>${failed ? "本轮部分结果" : `${otherArtifacts.length} 个文件`}</small></div><div class="artifact-list">${otherArtifacts.map((artifact) => renderArtifactCard(artifact, assistant.id, assistant.status)).join("")}</div>`
    : "";
  const otherBlock = assistant.status === "completed" && otherArtifacts.length ? `<button type="button" class="other-artifacts-toggle" data-other-artifacts-toggle="${escapeHtml(assistant.id)}" aria-expanded="${assistant.otherArtifactsOpen === true}">${assistant.otherArtifactsOpen === true ? "收起其他产物" : `查看其他产物 ${otherArtifacts.length} 个`}<span aria-hidden="true">⌄</span></button>${assistant.otherArtifactsOpen === true ? `<div class="artifact-list other-artifacts-list">${otherArtifacts.map((artifact) => renderArtifactCard(artifact, assistant.id, assistant.status)).join("")}</div>` : ""}` : "";
  const skillBlock = skills.length ? `<div class="inline-skill-summary"><span>本轮加载 Skill</span><div class="inline-skill-list">${skills.map((skill) => `<span class="inline-skill-chip">${escapeHtml(skill.name)}</span>`).join("")}</div></div>` : "";
  return `<section class="inline-artifacts" aria-label="本轮产物和 Skill">${artifactBlock}${generatedBlock}${otherBlock}${skillBlock}</section>`;
}

function renderArtifactCard(artifact, assistantId, assistantStatus = "completed") {
  const previewLabel = artifact.previewable === false ? "预览不可用" : "预览";
  const extension = String(artifact.name || artifact.path || "").split(".").pop()?.toUpperCase() || "FILE";
  const label = artifact.role === "final" ? "最终" : assistantStatus !== "completed" ? "已生成" : "过程";
  return `<article class="artifact-card" data-artifact-card="${escapeHtml(artifact.id)}" data-artifact-assistant="${escapeHtml(assistantId)}" data-artifact-previewable="${artifact.previewable === false ? "false" : "true"}"><div class="artifact-file-icon">${escapeHtml(extension.slice(0, 4))}</div><div class="artifact-card-main"><div class="artifact-head"><strong>${escapeHtml(artifact.name || artifact.path)}</strong><span class="artifact-role ${escapeHtml(artifact.role || "process")}">${label}</span></div><div class="artifact-meta">${escapeHtml(artifact.mimeType || "文件")} · ${formatBytes(artifact.bytes)}${artifact.previewable ? " · 可预览" : ""}</div></div><div class="artifact-actions"><button type="button" data-artifact-preview="${escapeHtml(artifact.id)}" data-artifact-assistant="${escapeHtml(assistantId)}" ${artifact.previewable === false ? "disabled" : ""}>${previewLabel}</button><button type="button" data-artifact-download="${escapeHtml(artifact.id)}" data-artifact-assistant="${escapeHtml(assistantId)}">下载</button></div></article>`;
}

function renderExecutionTrace(message) {
  const events = Array.isArray(message.detailEvents) && message.detailEvents.length ? message.detailEvents : (message.events || []);
  const activities = executionActivities(events, message.commandEvidence);
  const items = executionTraceItems(events, activities);
  if (!items.length) return "";
  const tools = items.filter((item) => item.kind === "tool");
  const latestTool = tools.filter((item) => item.active).at(-1) || tools.at(-1);
  const traceId = `trace-${message.id}`;
  const expanded = message.traceOpen === true;
  const rows = expanded && tools.length > 1 ? `<div class="execution-trace-list" id="${traceId}">${[...tools].reverse().map(renderExecutionTraceItem).join("")}</div>` : "";
  const toolBlock = latestTool ? `<div class="execution-tools" aria-label="工具执行"><div class="execution-trace-head"><div class="execution-trace-latest">${renderExecutionTraceItem(latestTool, true)}</div>${tools.length > 1 ? `<button type="button" class="execution-trace-toggle" data-trace-toggle="${escapeHtml(message.id)}" aria-expanded="${expanded}" aria-controls="${traceId}">${expanded ? "收起工具" : `查看工具 ${tools.length} 次`}<span aria-hidden="true">⌄</span></button>` : ""}</div>${rows}</div>` : "";
  return `<section class="execution-trace ${expanded ? "open" : ""}" aria-label="本轮工具执行状态">${toolBlock}</section>`;
}

function renderLiveEventIndicator(message) {
  const events = Array.isArray(message?.detailEvents) && message.detailEvents.length ? message.detailEvents : (message?.events || []);
  const latest = events.at(-1);
  const seq = numberValue(latest?.seq);
  const type = stringValue(latest?.type);
  if (seq === undefined && !type) return "";
  const running = ["running", "waiting"].includes(message?.status);
  return `<span class="live-event-indicator ${running ? "active" : ""}" data-event-seq="${escapeHtml(seq ?? "?")}" title="最新运行事件"><i class="live-event-pulse" aria-hidden="true"></i><span class="live-event-number">#${escapeHtml(seq ?? "?")}</span><small>${escapeHtml(type ? eventTypeLabel(type) : "runtime event")}</small></span>`;
}

function executionTraceItems(events, activities) {
  const commandsById = new Map(activities.commands.map((command) => [command.id, command]));
  const toolItems = new Map();
  const items = [];
  for (const [index, event] of (Array.isArray(events) ? events : []).entries()) {
    const data = recordValue(event?.data) || {};
    const type = stringValue(event?.type) || "runtime.event";
    const toolCallId = stringValue(data.toolCallId);
    const command = toolCallId ? commandsById.get(toolCallId) : undefined;
    const toolName = stringValue(data.toolName) || stringValue(data.name);
    const args = recordValue(data.arguments);
    if (toolCallId && toolName && (type.startsWith("tool.") || type === "assistant.tool_call.committed")) {
      const key = toolCallId || `tool-${index}`;
      const previous = toolItems.get(key);
      const item = previous || { id: key, seq: numberValue(event?.seq) ?? index, kind: "tool", active: false, title: toolName, parameters: "主要参数：-", result: "结果：等待执行" };
      item.seq = Math.max(item.seq, numberValue(event?.seq) ?? index);
      item.active = ["assistant.tool_call.committed", "tool.planned", "tool.effect_pending", "tool.dispatched"].includes(type);
      if (!previous || args) {
        item.title = toolName === "computer_run_command" ? stringValue(args?.command) || "computer_run_command" : toolName;
        item.parameters = `主要参数：${toolParameters(toolName, args)}`;
      }
      item.result = `结果：${toolResult(toolName, event, command)}`;
      toolItems.set(key, item);
      continue;
    }
    const seq = numberValue(event?.seq) ?? index;
    items.push({ id: `${seq}-${index}`, seq, kind: "event", title: `#${seq} · ${eventTypeLabel(type)}`, parameters: "", result: "" });
  }
  items.push(...toolItems.values());
  return items.map((item) => {
    const { title, parameters, result, kind, seq, id, active } = item;
    return { id, seq, kind, title, detail: parameters, result, active };
  }).sort((left, right) => left.seq - right.seq);
}

function eventTypeLabel(type) {
  return type.replaceAll(".", " ");
}

function toolParameters(toolName, args) {
  if (!args) return "-";
  if (toolName === "computer_run_command") {
    const command = stringValue(args.command) || "?";
    const commandArgs = Array.isArray(args.args) ? args.args.map((value) => String(value)).filter((value) => value !== "").join(" ") : "";
    return traceClip(`${command}${commandArgs ? ` ${commandArgs}` : ""}`, 120);
  }
  const entries = Object.entries(args).filter(([key]) => !["input", "content", "body"].includes(key));
  if (!entries.length) return "-";
  return traceClip(entries.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · "), 120);
}

function toolResult(toolName, event, command) {
  const type = stringValue(event?.type) || "";
  if (type === "tool.dispatched" || type === "tool.effect_pending") return "执行中";
  if (type === "tool.rejected") return traceClip(stringValue(event?.data?.reason) || "被拒绝", 120);
  if (type === "tool.failed") return traceClip(stringValue(event?.data?.error) || "执行失败", 120);
  if (command) {
    const status = commandTraceStatus(command);
    const output = command.status === "completed" && (command.stdout || command.stderr) ? traceClip(command.stdout || command.stderr, 80) : "";
    return output ? `${status} · ${output}` : status;
  }
  if (type === "tool.completed") {
    const result = recordValue(traceParseResult(event?.data?.result));
    if (result?.exitCode !== undefined) return result.exitCode === 0 ? "执行成功" : `退出码 ${result.exitCode}`;
    return "已完成";
  }
  return "等待执行";
}

function renderExecutionTraceItem(item, latest = false) {
  const result = item.result ? `<small class="execution-trace-result">${escapeHtml(item.result)}</small>` : "";
  return `<div class="execution-trace-item ${escapeHtml(item.kind)} ${latest ? "latest" : ""}"><span class="execution-trace-dot ${escapeHtml(item.kind)}"></span><span class="execution-trace-copy"><strong>${escapeHtml(item.title)}</strong>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ""}${result}</span>${item.kind === "event" ? "" : `<span class="execution-trace-seq">#${escapeHtml(item.seq)}</span>`}</div>`;
}

function commandTraceStatus(command) {
  if (command.status === "running") return "执行中";
  if (command.status === "completed") return command.exitCode === undefined ? "已完成" : `已完成 · 退出码 ${command.exitCode}`;
  if (command.status === "failed") return command.error || "执行失败";
  if (command.status === "rejected") return command.error || "被拒绝";
  return "等待执行";
}

function traceEventDetail(event) {
  const data = recordValue(event?.data) || {};
  if (stringValue(data.stepId)) return `step ${data.stepId}`;
  if (stringValue(data.message)) return data.message;
  if (stringValue(data.error)) return data.error;
  return "Runtime 流式事件";
}

function traceClip(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function traceParseResult(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function renderMessageFooter(message, timing, kind) {
  const label = `复制${kind}`;
  return `<div class="message-footer">${timing ? `<div class="message-timing">${timing}</div>` : ""}<button type="button" class="message-copy" data-copy-message="${escapeHtml(message.id)}" aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg></button></div>`;
}

async function copyConversationMessage(message, button) {
  const text = typeof message?.text === "string" ? message.text : "";
  const kind = message?.role === "user" ? "提问" : "回答";
  if (!text) { setStatus(`暂无可复制的${kind}内容`, "error"); return; }
  try {
    await copyText(text);
    showCopyFeedback(button, kind);
    setStatus(`已复制${kind}`, "ok");
  } catch {
    setStatus(`复制${kind}失败，请检查浏览器权限`, "error");
  }
}

function showCopyFeedback(button, kind) {
  if (!(button instanceof HTMLButtonElement)) return;
  if (button.copyFeedbackTimer) window.clearTimeout(button.copyFeedbackTimer);
  button.classList.add("copied");
  button.setAttribute("aria-label", `已复制${kind}`);
  button.title = `已复制${kind}`;
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>';
  button.copyFeedbackTimer = window.setTimeout(() => {
    button.classList.remove("copied");
    button.setAttribute("aria-label", `复制${kind}`);
    button.title = `复制${kind}`;
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>';
  }, 1600);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard copy was rejected");
}

async function refreshHumanLoop(assignmentId, assistant, tenantId, userId) {
  try {
    const response = await fetch(`${api}/v1/assignments/${encodeURIComponent(assignmentId)}/human-loop/current`, { headers: { "x-tenant-id": tenantId, "x-user-id": userId } });
    if (!response.ok) return false;
    const request = (await response.json())?.request;
    const next = request && request.status === "open" ? request : undefined;
    if (JSON.stringify(assistant.humanLoop) === JSON.stringify(next)) return false;
    assistant.humanLoop = next;
    return true;
  } catch { return false; }
}

function renderHumanLoop(message) {
  const request = message.humanLoop;
  if (!request || request.status !== "open") return "";
  const schema = request.responseSchema || {};
  const key = `${message.id}-${request.id}`;
  let fields = "";
  if (schema.type === "select") {
    const selections = humanLoopSelections(message, request.id);
    fields = `<div class="human-loop-options">${(schema.options || []).map((option) => `<label class="human-loop-option"><input type="${schema.maxSelections === 1 ? "radio" : "checkbox"}" name="human-${key}" value="${escapeHtml(option.id)}" data-human-loop-option data-human-loop-message="${escapeHtml(message.id)}" data-human-loop-request="${escapeHtml(request.id)}" data-human-loop-max-selections="${escapeHtml(String(schema.maxSelections || 0))}" ${selections.has(option.id) ? "checked" : ""}/><span><b>${escapeHtml(option.label)}</b>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</span></label>`).join("")}</div>`;
  }
  else if (schema.type === "form") fields = `<div class="human-loop-form">${(schema.fields || []).map((field) => `<label>${escapeHtml(field.label)}${field.required ? " *" : ""}${field.valueType === "textarea" ? `<textarea data-human-field="${escapeHtml(field.id)}" ${field.required ? "required" : ""}></textarea>` : `<input data-human-field="${escapeHtml(field.id)}" type="${field.valueType === "date" ? "date" : field.valueType === "number" ? "number" : "text"}" ${field.required ? "required" : ""}/>`}${field.description ? `<small>${escapeHtml(field.description)}</small>` : ""}</label>`).join("")}</div>`;
  else fields = `<div class="human-loop-confirm"><label><input type="radio" name="human-${key}" value="accept" checked/>${escapeHtml(schema.acceptLabel || "确认")}</label><label><input type="radio" name="human-${key}" value="reject"/>${escapeHtml(schema.rejectLabel || "拒绝")}</label></div>`;
  return `<section class="human-loop-card" data-human-loop="${escapeHtml(request.id)}" data-human-kind="${escapeHtml(schema.type || "")}" data-human-revision="${request.revision}"><b>${escapeHtml(request.title)}</b><p>${escapeHtml(request.prompt)}</p>${fields}<button type="button" class="human-loop-submit" data-human-loop-submit="${message.id}">提交</button><small class="human-loop-error" aria-live="polite"></small></section>`;
}

/** Preserve an unfinished HIL answer across unrelated live-state renders. */
function humanLoopSelections(message, requestId) {
  const values = message?.humanLoopDrafts?.[requestId];
  return new Set(Array.isArray(values) ? values.filter((value) => typeof value === "string") : []);
}

function rememberHumanLoopSelection(messageId, requestId, optionId, checked, maxSelections) {
  const assistant = (activeConversation()?.messages || []).find((message) => message.id === messageId && message.role === "assistant");
  if (!assistant || assistant.humanLoop?.id !== requestId) return;
  const current = humanLoopSelections(assistant, requestId);
  if (maxSelections === 1) {
    if (checked) current.clear();
    if (checked) current.add(optionId);
  } else if (checked) current.add(optionId);
  else current.delete(optionId);
  assistant.humanLoopDrafts = { ...(assistant.humanLoopDrafts || {}), [requestId]: [...current] };
  saveSessions();
}

function renderRecovery(message) {
  const checkpoint = message.checkpoint;
  if (checkpoint?.id) {
    const starting = checkpoint.status === "starting";
    const started = checkpoint.status === "started";
    const canStart = typeof message.assignmentId === "string" && !starting && !started;
    return `<section class="human-loop-card recovery-card"><b>可从检查点继续</b><p>原 Run 已因执行权丢失而失败。继续会创建新的子 Run，并复用已确认的 Plan、证据与上下文；不会复活或直接重放旧 Action。</p>${canStart ? `<button type="button" class="human-loop-submit" data-checkpoint-start="${message.id}">从检查点启动</button>` : ""}<small class="human-loop-error" aria-live="polite">${starting ? "正在创建新的子 Run…" : started ? "已从该检查点创建新 Run。" : ""}</small></section>`;
  }
  const recovery = message.recovery;
  if (!recovery || (recovery.status !== "required" && recovery.status !== "advancing")) return "";
  return `<section class="human-loop-card recovery-card"><b>正在迁移旧恢复状态</b><p>Runtime 会自动修复 Assessment 边界；若执行权已经丢失，则会终止原 Run 并生成可启动的新检查点。</p></section>`;
}

async function startFromCheckpoint(messageId) {
  const conversation = activeConversation();
  const assistant = [...(conversation?.messages || [])].find((message) => message.id === messageId);
  if (!conversation || !assistant?.assignmentId || assistant.checkpoint?.status === "starting" || activeRunsByConversation.has(conversation.id)) return;
  const tenantId = $("tenant-id").value.trim();
  const userId = $("user-id").value.trim();
  const activeRun = { assignmentId: null, abortController: null, submitAbortController: null, submitTimedOut: false, submitTimeout: null, assistant };
  activeRunsByConversation.set(conversation.id, activeRun);
  assistant.checkpoint = { ...assistant.checkpoint, status: "starting" };
  assistant.status = "running";
  assistant.error = undefined;
  assistant.completedAt = undefined;
  saveSessions(); render(); setStatus("正在从检查点创建新的 Run", "running");
  try {
    const response = await fetch(`${api}/v1/assignments/${encodeURIComponent(assistant.assignmentId)}/checkpoint/start`, {
      method: "POST",
      headers: { "x-tenant-id": tenantId, "x-user-id": userId },
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok || !body?.assignment?.id) throw new Error(body?.error || `HTTP ${response.status}`);
    activeRun.assignmentId = body.assignment.id;
    assistant.assignmentId = body.assignment.id;
    assistant.runtimeId = body.assignment.runtimeId || assistant.runtimeId;
    assistant.checkpoint = { ...assistant.checkpoint, status: "started", childRunId: body.run?.remoteRunId };
    assistant.events = [];
    assistant.plan = [];
    setVolatile(assistant, "detailEvents", []);
    saveSessions(); render();
    await streamAssignment(activeRun.assignmentId, conversation, assistant, tenantId, userId, activeRun);
  } catch (error) {
    if (activeRun.assignmentId) {
      if (error?.name !== "AbortError") setStatus("观察连接中断，已启动的 Run 未被停止", "error");
    } else {
      assistant.status = "failed";
      assistant.checkpoint = { ...assistant.checkpoint, status: "available" };
      assistant.error = `从检查点启动失败：${error instanceof Error ? error.message : String(error)}`;
      assistant.text = assistant.error;
      completeAssistantMessage(assistant);
      setStatus(assistant.error, "error");
    }
  } finally {
    if (activeRunsByConversation.get(conversation.id) === activeRun) activeRunsByConversation.delete(conversation.id);
    saveSessions(); render();
  }
}

async function submitHumanLoop(messageId) {
  const assistant = [...(activeConversation()?.messages || [])].find((message) => message.id === messageId);
  const request = assistant?.humanLoop; const card = document.querySelector(`[data-human-loop="${CSS.escape(request?.id || "")}"]`);
  if (!assistant?.assignmentId || !request || !card) return;
  const schema = request.responseSchema || {}; let value;
  if (schema.type === "select") value = [...card.querySelectorAll("input:checked")].map((input) => input.value);
  else if (schema.type === "form") { value = {}; card.querySelectorAll("[data-human-field]").forEach((field) => { value[field.dataset.humanField] = field.value; }); }
  else value = card.querySelector("input:checked")?.value === "reject" ? { accepted: false } : true;
  const error = card.querySelector(".human-loop-error");
  try {
    const response = await fetch(`${api}/v1/assignments/${encodeURIComponent(assistant.assignmentId)}/human-loop/${encodeURIComponent(request.id)}/respond`, { method: "POST", headers: { "content-type": "application/json", "x-tenant-id": $("tenant-id").value.trim(), "x-user-id": $("user-id").value.trim() }, body: JSON.stringify({ value, expectedRevision: request.revision }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    assistant.humanLoop = undefined;
    if (assistant.humanLoopDrafts) delete assistant.humanLoopDrafts[request.id];
    saveSessions(); render(); setStatus("已收到你的回答，继续执行", "running");
  } catch (cause) { if (error) error.textContent = `提交失败：${cause instanceof Error ? cause.message : String(cause)}`; }
}

function completeAssistantMessage(assistant, event) {
  if (numberValue(assistant?.completedAt) !== undefined) return;
  assistant.completedAt = numberValue(event?.createdAt) ?? Date.now();
}

function projectPlanStatuses(plan, events, runStatus) {
  if (!Array.isArray(plan) || plan.length === 0) return [];
  const statuses = new Map();
  for (const event of events || []) {
    const stepId = stringValue(event?.data?.stepId);
    const status = event?.type === "plan.step.started" ? "running" : event?.type === "plan.step.completed" ? "completed" : event?.type === "plan.step.failed" ? "failed" : undefined;
    if (stepId && status) statuses.set(stepId, status);
  }
  return plan.map((step) => {
    const observedStatus = statuses.has(step?.id) ? statuses.get(step.id) : step?.status;
    return { ...step, status: terminalAwarePlanStepStatus(observedStatus, runStatus) };
  });
}

function renderPendingAttachments(conversation) {
  const container = $("pending-attachments");
  const attachments = pendingAttachments(conversation);
  const uploads = uploadCount(conversation.id);
  container.hidden = attachments.length === 0 && uploads === 0;
  container.innerHTML = `${attachments.map((attachment) => renderAttachmentChip(attachment, true)).join("")}${uploads > 0 ? `<span class="source-chip muted"><span class="file-icon" aria-hidden="true"><span></span></span><span>上传中 ${uploads}</span></span>` : ""}`;
  container.querySelectorAll("[data-remove-attachment]").forEach((button) => button.addEventListener("click", () => removePendingAttachment(conversation, button.dataset.removeAttachment)));
}

function renderAttachmentChip(attachment, removable = false) {
  const name = typeof attachment?.originalName === "string" ? attachment.originalName : "未命名文件";
  const size = typeof attachment?.byteSize === "number" ? `<small>${formatBytes(attachment.byteSize)}</small>` : "";
  const remove = removable && typeof attachment?.id === "string" ? `<button type="button" data-remove-attachment="${escapeHtml(attachment.id)}" aria-label="移除 ${escapeHtml(name)}">×</button>` : "";
  return `<span class="source-chip ${removable ? "" : "msg-source-chip"}" title="${escapeHtml(name)}"><span class="file-icon" aria-hidden="true"><span></span></span><span>${escapeHtml(name)}</span>${size}${remove}</span>`;
}
function renderArtifacts(assistant) {
  const artifacts = Array.isArray(assistant?.artifacts) ? assistant.artifacts : [];
  const selected = inlineArtifactPreview && inlineArtifactPreview.assistantId === assistant?.id
    ? artifacts.find((artifact) => artifact.id === inlineArtifactPreview.artifactId)
    : undefined;
  $("artifact-title").textContent = selected ? selected.name || selected.path || "产物预览" : "产物预览";
  $("artifact-subtitle").textContent = selected ? `${selected.mimeType || "文件"} · ${formatBytes(selected.bytes)}` : artifacts.length ? `本轮有 ${artifacts.length} 个产物` : "选择回复中的产物进行预览";
  $("artifact-fullscreen").hidden = !selected;
  const previewHost = $("artifact-inline-preview");
  const emptyHost = $("artifact-empty");
  if (!previewHost || !emptyHost) return;
  if (!inlineArtifactPreview || inlineArtifactPreview.assistantId !== assistant?.id || !artifacts.some((artifact) => artifact.id === inlineArtifactPreview.artifactId)) {
    previewHost.hidden = true;
    previewHost.innerHTML = "";
    emptyHost.hidden = true;
    return;
  }
  previewHost.hidden = false;
  previewHost.innerHTML = inlineArtifactPreview.loading ? `<div class="artifact-inline-loading">正在生成预览…</div>` : (inlineArtifactPreview.html || `<div class="artifact-inline-loading">暂无预览内容</div>`);
  emptyHost.hidden = true;
}

async function openSelectedArtifactFullscreen() {
  const conversation = activeConversation();
  const assistant = (conversation?.messages || []).find((message) => message.role === "assistant" && message.id === inlineArtifactPreview?.assistantId)
    || selectedAssistantMessage(conversation);
  const artifactId = inlineArtifactPreview?.artifactId;
  const artifact = (assistant?.artifacts || []).find((item) => item.id === artifactId);
  if (!assistant?.assignmentId || !artifact) return;
  const headers = () => ({ "x-tenant-id": $("tenant-id").value.trim(), "x-user-id": $("user-id").value.trim() });
  const endpoint = (suffix = "") => `${api}/v1/assignments/${encodeURIComponent(assistant.assignmentId)}/artifacts/${encodeURIComponent(artifact.id)}${suffix}`;
  openArtifactPreview({
    artifact,
    fetchBytes: () => fetchBytes(endpoint, headers).then((response) => response.blob()),
    fetchStructuredPreview: () => fetchStructuredPreview(endpoint, headers),
  });
}

async function downloadArtifact(artifactId, assistantId) {
  const assistant = (activeConversation()?.messages || []).find((message) => message.role === "assistant" && message.id === assistantId) || selectedAssistantMessage(activeConversation());
  if (!assistant?.assignmentId) return;
  const response = await fetch(`${api}/v1/assignments/${encodeURIComponent(assistant.assignmentId)}/artifacts/${encodeURIComponent(artifactId)}`, { headers: { "x-tenant-id": $("tenant-id").value.trim(), "x-user-id": $("user-id").value.trim() } });
  if (!response.ok) return;
  const blob = await response.blob(); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = response.headers.get("content-disposition")?.split("filename*=UTF-8''")[1] ? decodeURIComponent(response.headers.get("content-disposition").split("filename*=UTF-8''")[1]) : "artifact"; link.click(); URL.revokeObjectURL(link.href);
}

async function previewArtifact(artifactId, assistantId) {
  const assistant = (activeConversation()?.messages || []).find((message) => message.role === "assistant" && message.id === assistantId) || selectedAssistantMessage(activeConversation());
  if (!assistant?.assignmentId) return;
  const artifact = (assistant.artifacts || []).find((item) => item.id === artifactId);
  if (!artifact || artifact.previewable === false) return;
  const headers = () => ({ "x-tenant-id": $("tenant-id").value.trim(), "x-user-id": $("user-id").value.trim() });
  const endpoint = (suffix = "") => `${api}/v1/assignments/${encodeURIComponent(assistant.assignmentId)}/artifacts/${encodeURIComponent(artifactId)}${suffix}`;
  artifactPanelOpen = true;
  inlineArtifactPreview = { assistantId: assistant.id, artifactId, loading: true };
  render();
  try {
    const mode = artifactPreviewMode(artifact);
    let html;
    if (mode === "structured") {
      html = renderStructuredPreview(await fetchStructuredPreview(endpoint, headers), renderMarkdown);
    } else {
      const response = await fetchBytes(endpoint, headers);
      if (inlineArtifactPreviewUrl) URL.revokeObjectURL(inlineArtifactPreviewUrl);
      inlineArtifactPreviewUrl = URL.createObjectURL(await response.blob());
      html = renderBlobPreview(mode, inlineArtifactPreviewUrl, artifact.name || artifact.path || "产物");
    }
    inlineArtifactPreview = { assistantId: assistant.id, artifactId, html };
  } catch (error) {
    inlineArtifactPreview = { assistantId: assistant.id, artifactId, html: `<div class="artifact-inline-error">${escapeHtml(error instanceof Error ? error.message : "无法生成预览")}</div>` };
  }
  render();
}

async function fetchBytes(endpoint, headers) {
  const response = await fetch(endpoint(), { headers: headers() });
  if (!response.ok) throw new Error(`无法读取产物（HTTP ${response.status}）`);
  return response;
}

async function fetchStructuredPreview(endpoint, headers) {
  const response = await fetch(endpoint("/preview"), { headers: headers() });
  if (!response.ok) throw new Error(`无法生成预览（HTTP ${response.status}）`);
  return await response.json();
}

function renderToolActivity(tool) {
  return `<span class="detail-tag tool-tag ${tool.status}"><span class="tool-status-dot"></span>${escapeHtml(tool.name)}<small>${toolOutcomeLabel(tool)}</small></span>`;
}

function renderSkillActivity(skill) {
  return `<span class="detail-tag tool-tag ${skill.status}"><span class="tool-status-dot"></span>${escapeHtml(skill.name)}<small>${skill.status === "completed" ? "已加载" : skill.status === "bound" ? "已绑定" : skill.status === "selected" ? "已选择" : skill.status === "failed" ? "加载失败" : skill.status === "rejected" ? "被拒绝" : "加载中"}</small></span>`;
}

function renderCommandActivity(command) {
  const label = command.status === "running" ? "执行中" : command.status === "completed" ? "已完成" : command.status === "failed" ? "失败" : command.status === "rejected" ? "被拒绝" : "已提交";
  const title = stringValue(command.arguments?.command) || "computer_run_command";
  const summary = command.status === "running" ? "已派发，等待命令返回" : command.status === "failed" || command.status === "rejected" ? (command.error || "命令未执行") : command.status === "completed" ? [command.exitCode === undefined ? "" : `退出码 ${command.exitCode}`, command.stdout ? "stdout 已返回" : "", command.stderr ? "stderr 已返回" : ""].filter(Boolean).join(" · ") || "命令执行完成" : "等待执行";
  return `<div class="command-card ${command.status}" data-command-detail="${escapeHtml(command.id)}" role="button" tabindex="0" aria-label="查看命令详情：${escapeHtml(title)}"><div class="command-card-head"><span class="command-state ${command.status}">${label}</span><span class="command-title">${escapeHtml(title)}</span><span class="command-open-hint">查看详情</span></div><dl class="command-meta"><dt>step</dt><dd>${escapeHtml(command.step ?? "-")}</dd><dt>duration</dt><dd>${formatDuration(command.durationMs) || "-"}</dd><dt>call</dt><dd>${escapeHtml(command.id)}</dd></dl><div class="command-summary">${escapeHtml(summary)}</div></div>`;
}

function openCommandDetail(command, assistantId) {
  if (!command || !assistantId) return;
  commandDetailSelection = { assistantId, commandId: command.id };
  renderCommandDetailModal([command]);
}

function closeCommandDetail() {
  commandDetailSelection = undefined;
  renderCommandDetailModal([]);
}

function renderCommandDetailModal(commands) {
  const host = $("command-detail-modal");
  if (!host) return;
  if (!commandDetailSelection) {
    host.innerHTML = "";
    return;
  }
  const command = commands.find((item) => item.id === commandDetailSelection.commandId);
  if (!command) {
    closeCommandDetail();
    return;
  }
  const argumentsText = JSON.stringify(command.arguments || {}, null, 2);
  const outputBlock = (title, value, error = false) => `<section class="command-detail-section"><h4>${title}</h4><pre class="command-full-output${error ? " error" : ""}">${escapeHtml(value || "(empty)")}</pre></section>`;
  host.innerHTML = `<div class="preview-backdrop command-detail-backdrop" role="dialog" aria-modal="true" aria-label="命令完整详情"><div class="preview-dialog maximized command-detail-dialog"><div class="preview-head"><div class="preview-title"><strong>命令详情</strong><span>${escapeHtml(command.id)}</span></div><button type="button" class="preview-close" data-command-detail-close aria-label="关闭命令详情">×</button></div><div class="preview-body command-detail-body"><section class="command-detail-section"><h4>完整命令</h4><pre class="command-full-output">${escapeHtml([command.arguments?.command || "?", ...(Array.isArray(command.arguments?.args) ? command.arguments.args : [])].join(" "))}</pre></section><section class="command-detail-section"><h4>调用参数</h4><pre class="command-full-output">${escapeHtml(argumentsText)}</pre></section><section class="command-detail-section"><h4>执行信息</h4><dl class="command-detail-meta-grid"><dt>状态</dt><dd>${escapeHtml(command.status)}</dd><dt>step</dt><dd>${escapeHtml(command.step ?? "-")}</dd><dt>duration</dt><dd>${formatDuration(command.durationMs) || "-"}</dd><dt>call</dt><dd>${escapeHtml(command.id)}</dd></dl></section>${outputBlock("stdout", command.stdout)}${outputBlock("stderr", command.stderr, true)}</div></div></div>`;
  host.querySelector("[data-command-detail-close]")?.addEventListener("click", closeCommandDetail);
  host.querySelector(".command-detail-backdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeCommandDetail();
  });
}
function toolOutcomeLabel(tool) {
  const parts = [];
  if (tool.completedCalls) parts.push(`${tool.completedCalls} 次完成`);
  if (tool.rejectedCalls) parts.push(`${tool.rejectedCalls} 次被拒绝`);
  if (tool.failedCalls) parts.push(`${tool.failedCalls} 次失败`);
  if (tool.runningCalls) parts.push(`${tool.runningCalls} 次执行中`);
  return parts.length ? parts.join(" · ") : "已提交";
}
function planStepLabel(status) { return status === "completed" ? "已完成" : status === "running" ? "执行中" : status === "failed" ? "失败" : status === "cancelled" ? "已取消" : "等待执行"; }
function recordValue(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : undefined; }
function stringValue(value) { return typeof value === "string" && value.trim() ? value : undefined; }
function numberValue(value) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function formatMessageTime(timestamp) {
  const value = numberValue(timestamp);
  if (value === undefined) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function formatConversationDuration(startedAt, completedAt) {
  const start = numberValue(startedAt);
  const end = numberValue(completedAt);
  if (start === undefined || end === undefined) return "";
  const elapsedMs = Math.max(0, end - start);
  if (elapsedMs < 1000) return `${Math.round(elapsedMs)} 毫秒`;
  const totalSeconds = Math.round(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  return `${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒`;
}
function formatDuration(ms) { if (typeof ms !== "number") return ""; if (ms < 1000) return `${Math.round(ms)} ms`; const seconds = ms / 1000; return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`; }
function formatBytes(bytes) { if (typeof bytes !== "number") return "大小未知"; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function setStatus(text, tone = "") { $("runtime-status").innerHTML = `<i class="status-dot"></i> ${escapeHtml(text)}`; $("runtime-status").className = `status-pill ${tone}`; }
function formatText(text) { return escapeHtml(text).replace(/\n/g, "<br />"); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
async function call(path, tenantId, userId, body, signal) { const response = await fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-tenant-id": tenantId, "x-user-id": userId }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) }); const parsed = await response.json(); if (!response.ok) throw new Error(parsed.error || `HTTP ${response.status}`); return parsed; }
async function toBase64(file) { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
