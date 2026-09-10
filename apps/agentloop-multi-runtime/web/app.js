import { hasIncompleteCompletedPlan, mergeRuntimeEvents, projectAssistantEvent, replayAssistantEvents } from "./assistant-event-projection.js";
import { createCoalescedUpdater } from "./live-update-scheduler.js";
import { persistJson, persistSessions } from "./session-persistence.js";
import { openArtifactPreview } from "./artifact-preview.js";

const api = String(globalThis.AGENTLOOP_ROUTER_URL || "http://127.0.0.1:8788").replace(/\/+$/, "");
const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "agentloop.multi-runtime.sessions.v1";
const IDENTITY_KEY = "agentloop.multi-runtime.identity.v1";
const MAX_PENDING_ATTACHMENTS = 20;
let sessions = loadSessions();
let activeId = sessions[0]?.id ?? newConversation().id;
const activeRunsByConversation = new Map();
const uploadingByConversation = new Map();
const liveUpdates = createCoalescedUpdater({ render, persist: saveSessions });

loadIdentity();
void loadModels();
void loadRuntimes();
void reconcilePersistedRuns();
render();
document.querySelectorAll("[data-suggest]").forEach((button) => button.addEventListener("click", () => { $("input").value = button.dataset.suggest || ""; $("input").focus(); }));
$("theme-toggle")?.addEventListener("click", () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "" : "dark"; });

$("new-chat").addEventListener("click", () => { activeId = newConversation().id; render(); $("input").focus(); });
$("composer").addEventListener("submit", (event) => { event.preventDefault(); void submit(); });
$("cancel").addEventListener("click", () => void cancelActive());
$("upload-file").addEventListener("click", () => $("attachment").click());
$("attachment").addEventListener("change", () => void uploadAttachments($("attachment").files));
$("input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
});
$("user-id").addEventListener("change", saveIdentity);
$("tenant-id").addEventListener("change", saveIdentity);

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

async function reconcilePersistedRuns() {
  const tenantId = $("tenant-id").value.trim();
  const userId = $("user-id").value.trim();
  if (!tenantId || !userId) return;
  let changed = false;
  await Promise.all(sessions.flatMap((conversation) => (conversation.messages || []).map(async (message) => {
    if (message?.role !== "assistant" || typeof message.assignmentId !== "string" || (message.status !== "running" && !hasIncompleteCompletedPlan(message))) return;
    try {
      const response = await fetch(`${api}/v1/assignments/${encodeURIComponent(message.assignmentId)}`, { headers: { "x-tenant-id": tenantId, "x-user-id": userId } });
      if (!response.ok) return;
      const body = await response.json();
      if (applyRecoveredRunState(message, body?.run)) changed = true;
      if (await replayPersistedRunEvents(message, tenantId, userId)) changed = true;
    } catch {}
  })));
  if (changed) { saveSessions(); render(); }
}

function applyRecoveredRunState(assistant, run) {
  if (!run || !["completed", "failed", "cancelled"].includes(run.status)) return false;
  assistant.status = run.status;
  if (run.status === "completed" && typeof run.output === "string") assistant.text = run.output;
  if (run.status === "failed") {
    assistant.error = recoveredFailureMessage(run) || assistant.error || assistant.text || "Run 失败";
    assistant.text = assistant.error;
  }
  assistant.reasoning = "";
  completeAssistantMessage(assistant, { createdAt: run.finishedAt });
  return true;
}

function recoveredFailureMessage(run) {
  const message = typeof run?.errorMessage === "string" ? run.errorMessage : "";
  if (run?.errorCode === "RUN_LIMIT_EXCEEDED") {
    return message ? `执行轮次已耗尽：${message}` : "执行轮次已耗尽，任务未能在预算内完成。";
  }
  if (message) return message;
  return typeof run?.errorCode === "string" ? `Run 失败：${run.errorCode}` : "";
}

async function replayPersistedRunEvents(assistant, tenantId, userId) {
  try {
    const response = await fetch(`${api}/v1/assignments/${encodeURIComponent(assistant.assignmentId)}/events`, { headers: { "x-tenant-id": tenantId, "x-user-id": userId } });
    if (!response.ok) return false;
    const body = await response.json();
    const events = Array.isArray(body?.events) ? body.events : [];
    if (events.length === 0) return false;
    const terminal = replayAssistantEvents(assistant, events);
    if (terminal) completeAssistantMessage(assistant, events.at(-1));
    return true;
  } catch {
    return false;
  }
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
  if (activeRunsByConversation.has(conversation.id)) { setStatus("当前会话仍在发起或执行；请等待或点击停止", "error"); return; }
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
  conversation.messages.push(userMessage, assistantMessage);
  activeRun.assistant = assistantMessage;
  conversation.title = conversation.title === "新对话" ? input.slice(0, 36) : conversation.title;
  conversation.updatedAt = Date.now();
  saveSessions();
  $("input").value = "";
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
    if (error?.name !== "AbortError" || activeRun.submitTimedOut) { assistantMessage.status = "failed"; assistantMessage.text = activeRun.submitTimedOut ? "发起会话超时，请重试" : `提交失败：${error instanceof Error ? error.message : String(error)}`; completeAssistantMessage(assistantMessage); saveSessions(); render(); setStatus("任务失败", "error"); }
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
  changeUploadCount(conversation.id, selected.length);
  render();
  try {
    for (const file of selected) {
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
        setStatus(`上传失败：${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        changeUploadCount(conversation.id, -1);
        render();
      }
    }
  } finally {
    if (uploadCount(conversation.id) === 0 && !activeRunsByConversation.has(conversation.id)) setStatus("文件已准备好", "ok");
  }
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
  const response = await fetch(`${api}/v1/assignments/${encodeURIComponent(assignmentId)}/events/stream`, { headers: { "x-tenant-id": tenantId, "x-user-id": userId }, signal: activeRun.abortController.signal });
  if (!response.ok || !response.body) throw new Error(`SSE 连接失败：HTTP ${response.status}`);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split("\n\n"); buffer = parts.pop() || "";
      for (const packet of parts) {
        const dataLine = packet.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        const eventLine = packet.split("\n").find((line) => line.startsWith("event: "));
        let payload;
        try {
          const raw = JSON.parse(dataLine.slice(6));
          payload = typeof raw.type === "string" || !eventLine ? raw : { type: eventLine.slice(7), data: raw };
        } catch { continue; }
        if (onEvent(payload, conversation, assistant)) {
          if (["run.completed", "run.failed", "run.cancelled"].includes(payload.type)) await refreshArtifacts(assignmentId, assistant, tenantId, userId);
          try { await reader.cancel(); } catch {}
          return;
        }
      }
    }
    throw new Error("SSE 在收到 Run 终态前关闭");
  } finally { reader.releaseLock(); }
}

function onEvent(event, conversation, assistant) {
  if (!event || typeof event.type !== "string") return false;
  if (event.type === "error") { assistant.status = "failed"; assistant.text = event.data?.error || "SSE 连接失败"; assistant.reasoning = ""; completeAssistantMessage(assistant, event); liveUpdates.flush(); setStatus("事件流失败", "error"); return true; }
  const terminal = projectAssistantEvent(assistant, event);
  assistant.events = mergeRuntimeEvents(assistant.events, [event]);
  if (terminal) completeAssistantMessage(assistant, event);
  conversation.updatedAt = Date.now();
  if (terminal) { liveUpdates.flush(); setStatus(event.type === "run.completed" ? "已完成" : event.type === "run.cancelled" ? "已停止" : "执行失败", assistant.status === "completed" ? "ok" : "error"); return true; }
  liveUpdates.request();
  return false;
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
  const activeRun = activeRunsByConversation.get(activeId);
  if (!activeRun) return;
  if (!activeRun.assignmentId) {
    if (activeRun.assistant) {
      activeRun.assistant.status = "cancelled";
      activeRun.assistant.text = "已停止发起会话";
      activeRun.assistant.reasoning = "";
      completeAssistantMessage(activeRun.assistant);
      saveSessions();
      render();
    }
    activeRun.submitAbortController?.abort();
    setStatus("已停止发起会话", "error");
    return;
  }
  try {
    const response = await fetch(`${api}/v1/assignments/${encodeURIComponent(activeRun.assignmentId)}/cancel`, { method: "POST", headers: { "x-tenant-id": $("tenant-id").value.trim(), "x-user-id": $("user-id").value.trim() } });
    const body = await response.json();
    if (response.ok && activeRun.assistant && applyRecoveredRunState(activeRun.assistant, body?.run)) {
      activeRun.abortController?.abort();
      saveSessions();
      render();
    }
  } catch {}
}

function render() {
  const conversation = activeConversation(); if (!conversation) return;
  activeId = conversation.id; $("conversation-title").textContent = conversation.title; $("conversation-id").textContent = `conversation: ${conversation.id}`;
  $("sessions").innerHTML = sessions.map((item) => `<div class="session-wrap"><button type="button" class="session ${item.id === activeId ? "active" : ""}" data-session="${item.id}"><span class="session-dot"></span><span class="session-body"><span class="session-title">${escapeHtml(item.title)}</span><span class="session-time">${item.messages.length ? `${Math.ceil(item.messages.length / 2)} 轮` : "空会话"}</span></span></button><button type="button" class="session-delete" data-delete-session="${item.id}" aria-label="删除会话">×</button></div>`).join("");
  document.querySelectorAll("[data-session]").forEach((button) => button.addEventListener("click", () => { activeId = button.dataset.session; render(); }));
  document.querySelectorAll("[data-delete-session]").forEach((button) => button.addEventListener("click", () => { sessions = sessions.filter((item) => item.id !== button.dataset.deleteSession); if (activeId === button.dataset.deleteSession) activeId = sessions[0]?.id ?? newConversation().id; saveSessions(); render(); }));
  const messages = conversation.messages || []; $("empty-state").hidden = messages.length > 0; $("messages").innerHTML = messages.map(renderMessage).join("");
  document.querySelectorAll("[data-plan-toggle]").forEach((button) => button.addEventListener("click", () => {
    const assistant = messages.find((message) => message.id === button.dataset.planToggle);
    if (!assistant) return;
    assistant.planOpen = assistant.planOpen !== true;
    render();
  }));
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const activeRun = activeRunsByConversation.get(conversation.id);
  $("submit").disabled = activeRun !== undefined || uploadCount(conversation.id) > 0;
  $("cancel").disabled = activeRun?.assignmentId === null || activeRun === undefined;
  $("upload-file").disabled = activeRun !== undefined || uploadCount(conversation.id) > 0 || pendingAttachments(conversation).length >= MAX_PENDING_ATTACHMENTS;
  renderPendingAttachments(conversation);
  $("details-title").textContent = messages.length > 0 ? "执行详情" : "产物";
  $("plan-section").hidden = !(lastAssistant?.plan?.length);
  $("events-section").hidden = !(lastAssistant?.events?.length);
  renderPlan(projectPlanStatuses(lastAssistant?.plan || [], lastAssistant?.events || [])); renderEvents(lastAssistant?.events || []); renderDetails(conversation, lastAssistant); const scroll = $("conversation-scroll"); scroll.scrollTop = scroll.scrollHeight;
  const reasoningBody = document.querySelector(".reasoning-body"); if (reasoningBody) reasoningBody.scrollTop = reasoningBody.scrollHeight;
}

function renderMessage(message) {
  if (message.role === "user") {
    const attachments = Array.isArray(message.attachments) ? message.attachments : (message.files || []).map((name) => ({ originalName: name }));
    const askedAt = formatMessageTime(message.createdAt);
    return `<article class="msg user"><div class="msg-body"><div class="msg-bubble"><div class="msg-role">你</div>${attachments.length ? `<div class="msg-source-row" aria-label="本轮上传文件">${attachments.map(renderAttachmentChip).join("")}</div>` : ""}<div class="msg-text">${escapeHtml(message.text)}</div>${askedAt ? `<div class="message-timing user-timing">提问于 ${askedAt}</div>` : ""}</div></div></article>`;
  }
  const isLive = message.status === "running";
  const plan = projectPlanStatuses(message.plan || [], message.events || []);
  const runtime = message.runtimeId ? ` · ${message.runtimeId}` : "";
  const reasoning = isLive && message.reasoning ? `<details class="live-reasoning" open><summary>模型思考</summary><div class="reasoning-body">${formatText(message.reasoning)}</div></details>` : "";
  const output = message.status === "failed" ? `<div class="failure-title">${formatText(message.error || message.text || "Run 失败")}</div>` : message.text ? (message.status === "completed" ? renderMarkdown(message.text) : formatText(message.text)) : `<span class="thinking"><i></i><i></i><i></i></span>`;
  const stateLabel = message.status === "running" ? "执行中" : message.status === "completed" ? "已完成" : message.status === "failed" ? "未完成" : message.status || "";
  const stateIcon = message.status === "completed" ? "✓" : message.status === "failed" ? "!" : "";
  const completedAt = formatMessageTime(message.completedAt);
  const duration = formatConversationDuration(message.createdAt, message.completedAt);
  const responseTiming = completedAt ? `<div class="message-timing assistant-timing">回答结束于 ${completedAt}${duration ? ` · 耗时 ${duration}` : ""}</div>` : "";
  const hasPlan = plan.length;
  const planPanelId = `plan-${message.id}`;
  const stepToggle = hasPlan ? `<button type="button" class="live-step-toggle" data-plan-toggle="${message.id}" aria-expanded="${message.planOpen === true}" aria-controls="${planPanelId}">步骤 ${plan.filter((step) => step.status === "completed").length}/${plan.length}<span class="live-step-caret" aria-hidden="true">⌄</span></button>` : "";
  const planPanel = hasPlan && message.planOpen === true ? `<ol class="inline-plan-steps" id="${planPanelId}">${plan.map((step, index) => `<li><span class="step-dot ${step.status === "completed" ? "done" : step.status === "running" ? "running" : step.status === "failed" ? "error" : "pending"}"></span><span><b>${String(index + 1).padStart(2, "0")} ${escapeHtml(step.objective || step.id || "未命名步骤")}</b><small>${planStepLabel(step.status)}</small></span></li>`).join("")}</ol>` : "";
  return `<article class="msg assistant ${isLive ? "live" : "final"}"><div class="msg-avatar">A</div><div class="msg-body"><div class="live-card ${message.status === "completed" ? "completed" : message.status === "failed" ? "failed" : ""}"><div class="live-head"><span class="assistant-state ${message.status}">${stateIcon || (isLive ? `<span class="thinking"><i></i><i></i><i></i></span>` : "")}</span><span>AgentLoop${runtime} · ${stateLabel}</span>${stepToggle}</div>${planPanel}${reasoning}<div class="live-output-text">${output}</div>${responseTiming}</div></div></article>`;
}

function completeAssistantMessage(assistant, event) {
  if (numberValue(assistant?.completedAt) !== undefined) return;
  assistant.completedAt = numberValue(event?.createdAt) ?? Date.now();
}

function projectPlanStatuses(plan, events) {
  if (!Array.isArray(plan) || plan.length === 0) return [];
  const statuses = new Map();
  for (const event of events || []) {
    const stepId = stringValue(event?.data?.stepId);
    const status = event?.type === "plan.step.started" ? "running" : event?.type === "plan.step.completed" ? "completed" : event?.type === "plan.step.failed" ? "failed" : undefined;
    if (stepId && status) statuses.set(stepId, status);
  }
  return plan.map((step) => statuses.has(step?.id) ? { ...step, status: statuses.get(step.id) } : step);
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
function renderPlan(steps) { if (!steps.length) { $("plan").className = "details-empty"; $("plan").textContent = "提交任务后显示 Planner。"; return; } $("plan").className = "plan-card"; $("plan").innerHTML = `<div class="plan-head"><span class="plan-title">Planner</span><span class="plan-goal">当前执行计划</span></div><ol class="plan-steps">${steps.map((step, index) => `<li class="plan-step"><span class="step-dot ${step.status === "completed" ? "done" : step.status === "running" ? "running" : step.status === "failed" ? "error" : "pending"}"></span><div class="step-main"><span class="step-obj">${escapeHtml(step.objective || step.id || `步骤 ${index + 1}`)}</span><span class="step-meta">${step.dependencies?.length ? `依赖：${step.dependencies.map(escapeHtml).join("、")}` : "无前置依赖"}</span></div><span class="step-state">${planStepLabel(step.status)}</span></li>`).join("")}</ol>`; }
function renderEvents(events) { $("event-count").textContent = `${events.length} events`; $("events").innerHTML = `<div class="event-list">${events.slice(-80).reverse().map((event) => `<div class="event"><span class="event-seq">#${event.seq}</span><span class="event-type">${escapeHtml(event.type)}</span></div>`).join("")}</div>`; }
function renderDetails(conversation, assistant) {
  const hasMessage = Boolean(assistant);
  $("details-task").textContent = hasMessage ? conversation.title : "选择或启动一个对话";
  $("details-runtime").textContent = assistant?.runtimeId || "自动分配";
  const events = assistant?.events || [];
  const activities = executionActivities(events);
  $("details-tools").innerHTML = activities.tools.length ? activities.tools.map(renderToolActivity).join("") : `<span class="muted">本轮尚未调用工具。</span>`;
  $("details-commands").innerHTML = activities.commands.length ? activities.commands.slice(-8).reverse().map(renderCommandActivity).join("") : `<span class="muted">本轮尚未执行命令。</span>`;
  $("details-output").innerHTML = assistant?.text ? (assistant.status === "completed" ? renderMarkdown(assistant.text) : formatText(assistant.text)) : `<span class="muted">暂无最终回复。</span>`;
  renderArtifacts(assistant);
}

function renderArtifacts(assistant) {
  const artifacts = Array.isArray(assistant?.artifacts) ? assistant.artifacts : [];
  $("details-artifacts").innerHTML = artifacts.length
    ? artifacts.map((artifact) => `<article class="artifact-card"><div class="artifact-head"><strong>${escapeHtml(artifact.name || artifact.path)}</strong><span class="artifact-role ${escapeHtml(artifact.role || "process")}">${artifact.role === "final" ? "最终" : "过程"}</span></div><div class="artifact-meta">${escapeHtml(artifact.mimeType || "文件")} · ${formatBytes(artifact.bytes)}${artifact.previewable ? " · 可预览" : ""}</div><div class="artifact-actions"><button type="button" data-artifact-download="${escapeHtml(artifact.id)}">下载</button><button type="button" data-artifact-preview="${escapeHtml(artifact.id)}">预览</button></div></article>`).join("")
    : `<span class="muted">本轮暂无可预览或下载的产物。</span>`;
  document.querySelectorAll("[data-artifact-download]").forEach((button) => button.addEventListener("click", () => void downloadArtifact(button.dataset.artifactDownload)));
  document.querySelectorAll("[data-artifact-preview]").forEach((button) => button.addEventListener("click", () => void previewArtifact(button.dataset.artifactPreview)));
}

async function downloadArtifact(artifactId) {
  const assistant = [...(activeConversation()?.messages || [])].reverse().find((message) => message.role === "assistant");
  if (!assistant?.assignmentId) return;
  const response = await fetch(`${api}/v1/assignments/${encodeURIComponent(assistant.assignmentId)}/artifacts/${encodeURIComponent(artifactId)}`, { headers: { "x-tenant-id": $("tenant-id").value.trim(), "x-user-id": $("user-id").value.trim() } });
  if (!response.ok) return;
  const blob = await response.blob(); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = response.headers.get("content-disposition")?.split("filename*=UTF-8''")[1] ? decodeURIComponent(response.headers.get("content-disposition").split("filename*=UTF-8''")[1]) : "artifact"; link.click(); URL.revokeObjectURL(link.href);
}

async function previewArtifact(artifactId) {
  const assistant = [...(activeConversation()?.messages || [])].reverse().find((message) => message.role === "assistant");
  if (!assistant?.assignmentId) return;
  const artifact = (assistant.artifacts || []).find((item) => item.id === artifactId);
  if (!artifact) return;
  const headers = () => ({ "x-tenant-id": $("tenant-id").value.trim(), "x-user-id": $("user-id").value.trim() });
  const endpoint = (suffix = "") => `${api}/v1/assignments/${encodeURIComponent(assistant.assignmentId)}/artifacts/${encodeURIComponent(artifactId)}${suffix}`;
  openArtifactPreview({
    artifact,
    fetchBytes: async () => {
      const response = await fetch(endpoint(), { headers: headers() });
      if (!response.ok) throw new Error(`无法读取产物（HTTP ${response.status}）`);
      return await response.blob();
    },
    fetchStructuredPreview: async () => {
      const response = await fetch(endpoint("/preview"), { headers: headers() });
      if (!response.ok) throw new Error(`无法生成预览（HTTP ${response.status}）`);
      return await response.json();
    },
    renderMarkdown,
  });
}

function executionActivities(events) {
  const tools = new Map();
  const commands = new Map();
  for (const event of events) {
    const data = event.data || {};
    const toolCallId = stringValue(data.toolCallId);
    const toolName = stringValue(data.toolName) || stringValue(data.name);
    if (!toolCallId || !toolName) continue;
    if (["tool.planned", "assistant.tool_call.committed", "tool.dispatched", "tool.completed", "tool.failed", "tool.rejected"].includes(event.type)) {
      const current = tools.get(toolCallId) || { id: toolCallId, name: toolName, status: "queued", seq: event.seq || 0 };
      current.name = toolName;
      current.seq = Math.max(current.seq, event.seq || 0);
      current.status = toolStatus(event.type, current.status);
      tools.set(toolCallId, current);
    }
    if (toolName !== "computer_run_command") continue;
    const current = commands.get(toolCallId) || { id: toolCallId, command: "", args: [], status: "queued", seq: event.seq || 0 };
    current.seq = Math.max(current.seq, event.seq || 0);
    if (event.type === "tool.planned" || event.type === "assistant.tool_call.committed") current.submittedAt = current.submittedAt ?? event.createdAt;
    if (event.type === "tool.dispatched") current.dispatchedAt = event.createdAt;
    if (["tool.completed", "tool.failed", "tool.rejected"].includes(event.type)) {
      current.completedAt = event.createdAt;
      const startedAt = current.dispatchedAt ?? current.submittedAt;
      current.durationMs = typeof startedAt === "number" && typeof current.completedAt === "number" ? Math.max(0, current.completedAt - startedAt) : undefined;
    }
    current.step = numberValue(data.step) ?? current.step;
    const args = recordValue(data.arguments);
    if (args) {
      current.command = stringValue(args.command) || current.command;
      current.args = Array.isArray(args.args) ? args.args.map((item) => String(item)) : current.args;
      current.cwd = stringValue(args.cwd) || current.cwd;
      current.timeoutMs = numberValue(args.timeoutMs) ?? current.timeoutMs;
    }
    current.status = toolStatus(event.type, current.status);
    if (event.type === "tool.completed") {
      current.result = parseResult(data.result);
      current.exitCode = numberValue(current.result?.exitCode);
      current.stdout = stringValue(current.result?.stdout);
      current.stderr = stringValue(current.result?.stderr);
    }
    if (event.type === "tool.failed") current.error = stringValue(data.error);
    if (event.type === "tool.rejected") current.error = stringValue(data.reason);
    commands.set(toolCallId, current);
  }
  const toolTotals = new Map();
  for (const tool of tools.values()) {
    const current = toolTotals.get(tool.name) || { name: tool.name, calls: 0, status: tool.status, seq: tool.seq, completedCalls: 0, rejectedCalls: 0, failedCalls: 0, runningCalls: 0 };
    current.calls += 1;
    if (tool.status === "completed") current.completedCalls += 1;
    else if (tool.status === "rejected") current.rejectedCalls += 1;
    else if (tool.status === "failed") current.failedCalls += 1;
    else if (tool.status === "running") current.runningCalls += 1;
    current.status = aggregateToolStatus(current);
    current.seq = Math.max(current.seq, tool.seq);
    toolTotals.set(tool.name, current);
  }
  return {
    tools: [...toolTotals.values()].sort((left, right) => left.seq - right.seq),
    commands: [...commands.values()].sort((left, right) => left.seq - right.seq),
  };
}

function renderToolActivity(tool) {
  return `<span class="detail-tag tool-tag ${tool.status}"><span class="tool-status-dot"></span>${escapeHtml(tool.name)}<small>${toolOutcomeLabel(tool)}</small></span>`;
}

function renderCommandActivity(command) {
  const label = command.status === "running" ? "执行中" : command.status === "completed" ? "已完成" : command.status === "failed" ? "失败" : command.status === "rejected" ? "被拒绝" : "已提交";
  const title = [command.command || "?", ...summarizeCommandArgs(command.args || [])].join(" ").trim();
  const summary = command.status === "running" ? "已派发，等待命令返回" : command.status === "failed" || command.status === "rejected" ? (command.error || "命令未执行") : command.status === "completed" ? [command.exitCode === undefined ? "" : `退出码 ${command.exitCode}`, command.stdout ? "stdout 已返回" : "", command.stderr ? "stderr 已返回" : ""].filter(Boolean).join(" · ") || "命令执行完成" : "等待执行";
  const output = command.stdout || command.stderr || "";
  return `<details class="command-card ${command.status}" ${command.status === "running" ? "open" : ""}><summary><span class="command-state ${command.status}">${label}</span><span class="command-title">${escapeHtml(title)}</span></summary><dl class="command-meta"><dt>step</dt><dd>${escapeHtml(command.step ?? "-")}</dd><dt>cwd</dt><dd>${escapeHtml(command.cwd || ".")}</dd><dt>timeout</dt><dd>${formatDuration(command.timeoutMs) || "-"}</dd><dt>duration</dt><dd>${formatDuration(command.durationMs) || "-"}</dd><dt>call</dt><dd>${escapeHtml(command.id)}</dd></dl><div class="command-summary">${escapeHtml(summary)}</div>${output ? `<pre class="command-output ${command.stderr ? "error" : ""}">${escapeHtml(output)}</pre>` : ""}</details>`;
}

function toolStatus(type, previous) {
  if (type === "tool.dispatched") return "running";
  if (type === "tool.completed") return "completed";
  if (type === "tool.failed") return "failed";
  if (type === "tool.rejected") return "rejected";
  return previous;
}
function aggregateToolStatus(tool) {
  if (tool.failedCalls > 0) return tool.failedCalls === tool.calls ? "failed" : "partial";
  if (tool.rejectedCalls > 0) return tool.rejectedCalls === tool.calls ? "rejected" : "partial";
  if (tool.runningCalls > 0) return "running";
  if (tool.completedCalls > 0) return "completed";
  return "queued";
}
function toolOutcomeLabel(tool) {
  const parts = [];
  if (tool.completedCalls) parts.push(`${tool.completedCalls} 次完成`);
  if (tool.rejectedCalls) parts.push(`${tool.rejectedCalls} 次被拒绝`);
  if (tool.failedCalls) parts.push(`${tool.failedCalls} 次失败`);
  if (tool.runningCalls) parts.push(`${tool.runningCalls} 次执行中`);
  return parts.length ? parts.join(" · ") : "已提交";
}
function planStepLabel(status) { return status === "completed" ? "已完成" : status === "running" ? "执行中" : status === "failed" ? "失败" : "等待执行"; }
function summarizeCommandArgs(args) { const result = []; for (let index = 0; index < args.length; index += 1) { result.push(args[index] === "-c" && index + 1 < args.length ? "-c [inline script]" : args[index]); if (args[index] === "-c") index += 1; } return result; }
function parseResult(value) { if (value && typeof value === "object" && !Array.isArray(value)) return value; if (typeof value !== "string") return {}; try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
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
function renderMarkdown(text) {
  const fence = "```";
  return escapeHtml(text).split(fence).map((part, index) => index % 2 ? `<pre class="md-code"><code>${part.replace(/^\n|\n$/g, "")}</code></pre>` : renderMarkdownBlocks(part)).join("");
}
function renderMarkdownBlocks(text) {
  const lines = text.split("\n"); const output = []; let paragraph = []; let listTag = ""; let listItems = [];
  const flushParagraph = () => { if (paragraph.length) { output.push(`<p>${paragraph.map(renderMarkdownInline).join("<br />")}</p>`); paragraph = []; } };
  const flushList = () => { if (listTag) { output.push(`<${listTag}>${listItems.join("")}</${listTag}>`); listTag = ""; listItems = []; } };
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    const unordered = /^(?:-|\*)\s+(.+)$/u.exec(line);
    const ordered = /^\d+\.\s+(.+)$/u.exec(line);
    if (heading) { flushParagraph(); flushList(); output.push(`<h${heading[1].length}>${renderMarkdownInline(heading[2])}</h${heading[1].length}>`); }
    else if (unordered || ordered) { flushParagraph(); const nextListTag = unordered ? "ul" : "ol"; if (listTag !== nextListTag) { flushList(); listTag = nextListTag; } listItems.push(`<li>${renderMarkdownInline((unordered || ordered)[1])}</li>`); }
    else if (/^&gt;\s+/.test(line)) { flushParagraph(); flushList(); output.push(`<blockquote>${renderMarkdownInline(line.slice(5))}</blockquote>`); }
    else if (!line.trim()) { flushParagraph(); flushList(); }
    else { flushList(); paragraph.push(renderMarkdownInline(line)); }
  }
  flushParagraph(); flushList(); return output.join("");
}
function renderMarkdownInline(text) {
  return text.replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>').replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>").replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
async function call(path, tenantId, userId, body, signal) { const response = await fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-tenant-id": tenantId, "x-user-id": userId }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) }); const parsed = await response.json(); if (!response.ok) throw new Error(parsed.error || `HTTP ${response.status}`); return parsed; }
async function toBase64(file) { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
