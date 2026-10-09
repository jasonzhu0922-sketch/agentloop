import { hasIncompleteCompletedPlan, mergeRuntimeEvents, projectAssistantEvent, replayAssistantEvents } from "./projections/assistant-event-projection.js";
import { conversationMessagesFromTurns } from "./projections/conversation-history.js";
import { commandToolCallIds, executionActivities } from "./projections/execution-detail-projection.js";
import { executionProvenanceParts } from "./projections/execution-provenance.js";
import { artifactPreviewMode, openArtifactPreview, renderBlobPreview, renderMarkdown, renderStructuredPreview, updateArtifactPreviewMarkup } from "/artifact-preview.js";
import { isExecutionLogArtifact, isFinalDeliveryArtifact } from "./presentation/artifact-display.js";
import { assistantMessagePresentation, completedArtifactSummary, terminalAwarePlanStepStatus } from "./presentation/assistant-message-presentation.js";
import { submissionFailureMessage } from "./presentation/submission-failure-message.js";
import { cancellationTarget } from "./state/cancellation-target.js";
import { createConversationState } from "./state/conversation-state.js";
import { createCoalescedUpdater } from "./state/live-update-scheduler.js";
import { persistJson, persistSessions } from "./state/session-persistence.js";
import { createSessionState } from "./state/session-state.js";
import { createRunState } from "./state/run-state.js";
import { isNearBottom, nextScrollTop } from "./ui/scroll-follow.js";
import { autoResizeComposerInput, resetComposerInput, shouldSubmitComposerOnKeydown } from "./ui/composer-input.js";
import { hasSelectedTextWithin } from "./ui/message-selection.js";
import { observeAssignment } from "./api/assignment-stream.js";
import { createRouterClient, routerProxyPath } from "./api/router-client.js";
import { createLocalAgentClient } from "./local-runtime/local-agent-client.js";
import { loadLocalRuntimePreference, localRuntimePreferenceKey, saveLocalRuntimePreference } from "./local-runtime/local-runtime-preference.js";
import { createLocalRuntimeState } from "./local-runtime/local-runtime-state.js";
import { localRuntimeListMarkup, localRuntimeOptions, localRuntimeViewModel } from "./local-runtime/local-runtime-view-model.js";

const api = String(globalThis.AGENTLOOP_ROUTER_URL || "http://127.0.0.1:8788").replace(/\/+$/, "");
const publicRouterUrl = String(globalThis.AGENTLOOP_ROUTER_PUBLIC_URL || (api.startsWith("http") ? api : location.origin)).replace(/\/+$/, "");
const localAgentApi = String(globalThis.AGENTLOOP_LOCAL_AGENT_URL || "http://127.0.0.1:8790").replace(/\/+$/, "");
const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "agentloop.multi-runtime.sessions.v1";
const AUTH_TOKEN_KEY = "agentloop.multi-runtime.auth-token.v1";
const ACTIVE_USER_KEY = "agentloop.multi-runtime.active-user.v1";
const WORKSPACE_WIDTH_KEY = "agentloop.multi-runtime.artifact-width.v1";
const MAX_PENDING_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const CONVERSATION_PAGE_SIZE = 30;
const LOCAL_AGENT_PROTOCOL_VERSION = "1";
const LOCAL_SESSION_REFRESH_AHEAD_MS = 5 * 60 * 1000;
const ROUTER_STARTUP_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000];
const ARTIFACT_PRODUCING_TOOLS = new Set([
  "computer_write_file",
  "computer_patch_file",
  "computer_run_command",
  "convert_artifact",
  "verify_artifact_acceptance",
]);
const conversationState = createConversationState(CONVERSATION_PAGE_SIZE);
const sessionState = createSessionState({ storage: sessionStorage, authTokenKey: AUTH_TOKEN_KEY, activeUserKey: ACTIVE_USER_KEY });
const localRuntimeState = createLocalRuntimeState();
const runState = createRunState();
let renderedConversationId;
let commandDetailSelection;
let inlineArtifactPreview;
let inlineArtifactPreviewUrl;
let artifactPanelOpen = false;
let artifactPanelWidth = loadArtifactPanelWidth();
let resizeState;
const liveUpdates = createCoalescedUpdater({ render: renderPendingLiveAssistantMessages, persist: saveSessions });

const nativeFetch = window.fetch.bind(window);
const routerClient = createRouterClient({ baseUrl: api, fetchImpl: nativeFetch, tokenProvider: () => sessionStorage.getItem(AUTH_TOKEN_KEY) || undefined });
const localAgentClient = createLocalAgentClient({
  baseUrl: localAgentApi,
  fetchImpl: nativeFetch,
  session: {
    ensureValid: async () => {
      if (!sessionState.localSessionToken || sessionState.localSessionExpiresAt - Date.now() <= LOCAL_SESSION_REFRESH_AHEAD_MS) await refreshLocalSessionOnce();
    },
    token: () => sessionState.localSessionToken,
    refresh: refreshLocalSessionOnce,
  },
});
// Compatibility bridge for the legacy page functions that still call fetch()
// directly. New transport code must use routerClient/localAgentClient; this
// bridge keeps the existing DOM workflow authenticated while migration is
// completed incrementally.
window.fetch = (input, init = {}) => {
  const requestUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const path = routerProxyPath(requestUrl, api, location.href);
  if (path === undefined) return nativeFetch(input, init);
  return routerClient.request(path, init);
};

void bootstrapAuthenticatedApp();
document.querySelectorAll("[data-suggest]").forEach((button) => button.addEventListener("click", () => { $("input").value = button.dataset.suggest || ""; autoResizeComposerInput($("input")); $("input").focus(); }));
$("theme-toggle")?.addEventListener("click", () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "" : "dark"; });

$("new-chat").addEventListener("click", () => { conversationState.activeId = newConversation().id; resetArtifactWorkspace(); render(); $("input").focus(); });
$("composer").addEventListener("submit", (event) => { event.preventDefault(); void runComposerAction(); });
$("submit").addEventListener("click", () => void runComposerAction());
$("messages").addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-copy-message]") : null;
  if (!(button instanceof HTMLButtonElement)) return;
  const message = activeConversation()?.messages?.find((item) => item.id === button.dataset.copyMessage);
  if (message) void copyConversationMessage(message, button);
});
$("upload-file").addEventListener("click", () => $("attachment").click());
$("attachment").addEventListener("change", () => void uploadAttachments($("attachment").files));
$("workspace-resizer").addEventListener("pointerdown", beginWorkspaceResize);
$("workspace-resizer").addEventListener("keydown", handleWorkspaceResizeKeydown);
$("workspace-resizer").addEventListener("dblclick", resetArtifactPanelWidth);
$("artifact-panel-close").addEventListener("click", () => { resetArtifactWorkspace(); render(); });
$("artifact-fullscreen").addEventListener("click", () => void openSelectedArtifactFullscreen());
$("input").addEventListener("keydown", (event) => {
  if (shouldSubmitComposerOnKeydown(event)) { event.preventDefault(); void runComposerAction(); }
});
$("input").addEventListener("input", () => autoResizeComposerInput($("input")));
$("auth-logout").addEventListener("click", () => void logoutUser());
$("enable-local-runtime").addEventListener("click", () => void enableLocalRuntime());
$("local-agent-settings").addEventListener("click", () => void openLocalAgentSettings());
$("agent-storage-pick").addEventListener("click", () => void pickSharedStorage());
$("agent-upload-storage-pick").addEventListener("click", () => void pickUploadStorage());
$("agent-settings-close").addEventListener("click", closeLocalAgentSettings);
$("agent-install-cancel").addEventListener("click", closeLocalAgentInstall);
$("runtime-config-cancel").addEventListener("click", closeConfigureLocalRuntime);
$("runtime-config-form").addEventListener("submit", (event) => { event.preventDefault(); void saveLocalRuntimeConfiguration(); });
$("use-local-runtime").addEventListener("change", () => {
  saveLocalRuntimePreference(localStorage, sessionState.user?.id, localRuntimeState.device?.id, isLocalExecution());
  refreshRuntimeOptions();
  updateLocalControls();
  if (isLocalExecution()) {
    void loadLocalScopes();
    setStatus("本机运行：由所选本机 Runtime 执行", "ok");
  } else setStatus("云端运行：由云端自动选择 Runtime", "ok");
  render();
});
$("runtime").addEventListener("change", () => {
  if (isLocalExecution()) {
    localRuntimeState.runtimeId = $("runtime").value;
    syncLocalRuntimeManager();
    void loadLocalScopes();
  }
  updateLocalControls();
  render();
});
$("directory-scope").addEventListener("click", () => void addDirectoryScope());
$("local-runtime-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-local-runtime-action]");
  if (!button || button.disabled) return;
  const runtimeId = button.dataset.runtimeId;
  if (!runtimeId) return;
  const action = button.dataset.localRuntimeAction;
  if (action === "select") void selectLocalRuntime(runtimeId);
  if (action === "configure") { selectLocalRuntime(runtimeId); openConfigureLocalRuntime(runtimeId); }
  if (action === "delete") void deleteLocalRuntime(runtimeId);
  if (action === "drain") void applyLocalRuntimeLifecycle("drain", runtimeId);
  if (action === "restart") void applyLocalRuntimeLifecycle("restart", runtimeId);
  if (action === "toggle") void toggleLocalRuntimeStarted(runtimeId);
});
$("local-runtime-create").addEventListener("click", openCreateLocalRuntime);
$("runtime-create-cancel").addEventListener("click", closeCreateLocalRuntime);
$("runtime-create-modal").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeCreateLocalRuntime(); });
$("runtime-create-form").addEventListener("submit", (event) => { event.preventDefault(); void createLocalRuntime($("runtime-create-name").value); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { closeCommandDetail(); closeCreateLocalRuntime(); closeLocalAgentSettings(); closeLocalAgentInstall(); closeConfigureLocalRuntime(); }
});

function newConversation() {
  const conversation = { id: crypto.randomUUID(), title: "新对话", createdAt: Date.now(), updatedAt: Date.now(), messages: [], pendingAttachments: [] };
  conversationState.sessions.unshift(conversation);
  saveSessions();
  return conversation;
}

function activeConversation() { return conversationState.sessions.find((item) => item.id === conversationState.activeId) ?? conversationState.sessions[0]; }
function saveSessions() { if (sessionState.user) persistSessions(localStorage, conversationState.sessions, sessionKey(sessionState.user.id)); }
function loadSessions(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
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
function sessionKey(userId) { return `${STORAGE_KEY}.${encodeURIComponent(userId)}`; }

async function bootstrapAuthenticatedApp() {
  if (!(await restoreIdentitySession())) return;
  render();
  await Promise.all([loadModels(), loadDevices(), loadConversationPage(true)]);
}

async function restoreIdentitySession() {
  if (!sessionState.authToken) { redirectToLogin(); return false; }
  try {
    const response = await routerClient.request("/v1/auth/me");
    if (response.status === 401) { clearAuthState(); return false; }
    if (!response.ok) throw new Error(`router_unavailable:${response.status}`);
    applyAuthenticatedIdentity(await response.json());
    return true;
  } catch (error) {
    // A Router restart must not erase a valid browser session or masquerade as
    // an authentication failure. Keep the cached, user-scoped UI available
    // and surface the infrastructure state explicitly.
    const userId = sessionStorage.getItem(ACTIVE_USER_KEY);
    if (!userId) { redirectToLogin(); return false; }
    sessionState.setUser({ id: userId, email: "已登录（Router 暂不可达）" });
    conversationState.recovered = sortSessions(loadSessions(sessionKey(userId)));
    conversationState.sessions = [...conversationState.recovered];
    conversationState.activeId = conversationState.sessions[0]?.id;
    $("identity-label").textContent = sessionState.user.email;
    setTimeout(() => setStatus(`Router 暂不可达：${error instanceof Error ? error.message : String(error)}`, "error"));
    return true;
  }
}

function applyAuthenticatedIdentity(value) {
  const user = value.user; const tenant = value.tenant;
  if (!user || typeof user.id !== "string" || typeof user.email !== "string" || !tenant || typeof tenant.id !== "string") throw new Error("identity_response_invalid");
  if (sessionState.user?.id !== user.id) {
    conversationState.clear(); localRuntimeState.clear();
    clearLocalSession();
  }
  sessionState.setUser(user);
  $("user-id").value = user.id; $("tenant-id").value = tenant.id; $("identity-label").textContent = user.email;
  sessionStorage.setItem(ACTIVE_USER_KEY, user.id);
  conversationState.recovered = sortSessions(loadSessions(sessionKey(user.id)));
}

function clearAuthState() {
  sessionState.clearIdentity(); conversationState.clear();
  localRuntimeState.clear();
  clearLocalSession();
  $("user-id").value = ""; $("tenant-id").value = ""; $("identity-label").textContent = "";
  redirectToLogin();
}

async function logoutUser() { try { await routerClient.request("/v1/auth/logout", { method: "POST" }); } catch {} clearAuthState(); }

async function enableLocalRuntime() {
  const button = $("enable-local-runtime");
  if (!sessionState.user) { redirectToLogin(); return; }
  button.disabled = true;
  try {
    await probeLocalAgent();
    if (localRuntimeState.agentStatus === "not_installed") {
      await offerLocalAgentInstall();
      return;
    }
    if (localRuntimeState.agentStatus === "installed_stopped") {
      await startInstalledLocalAgent();
      return;
    }
    if (localRuntimeState.agentStatus === "incompatible") throw new Error("Local Runtime Agent 协议版本不兼容，请安装匹配版本");
    if (localRuntimeState.agentStatus !== "online_unpaired" && localRuntimeState.agentStatus !== "online") throw new Error("Local Runtime Agent 尚未就绪");
    if (localRuntimeState.agentHealth?.registered === true) {
      await connectRegisteredLocalAgent();
      return;
    }
    const authorization = await call("/v1/devices/registration-tokens", {});
    if (typeof authorization.token !== "string") throw new Error("设备注册授权无效");
    const response = await localAgentClient.register(authorization.token);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.device?.id !== "string") throw new Error(typeof body.error === "string" ? body.error : `Local Agent HTTP ${response.status}`);
    localRuntimeState.device = body.device;
    await refreshLocalSession();
    await loadLocalRuntimes();
    await loadLocalScopes();
    updateLocalControls();
    await probeLocalAgent();
    setStatus(`Local Runtime Agent 已配对：${body.device.displayName || body.device.id}`, "ok");
  } catch (error) {
    setStatus(`本机能力不可用：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally { button.disabled = false; }
}

async function loadDevices() {
  await probeLocalAgent();
  try {
    const response = await routerClient.request("/v1/devices");
    if (!response.ok) return;
    const body = await response.json();
    localRuntimeState.device = (body.devices || []).find((device) => device.id === localRuntimeState.agentHealth?.deviceId && device.status === "active");
    if (localRuntimeState.device && localRuntimeState.agentStatus === "online") await connectRegisteredLocalAgent();
  } catch {}
  if (localRuntimeState.agentStatus === "router_disconnected") scheduleLocalAgentReprobe();
  updateLocalControls();
}

function scheduleLocalAgentReprobe() {
  if (localRuntimeState.agentReprobe) return;
  localRuntimeState.agentReprobe = setTimeout(() => void (async () => {
    localRuntimeState.agentReprobe = undefined;
    await probeLocalAgent();
    if (localRuntimeState.agentStatus === "online") await loadDevices();
    else if (localRuntimeState.agentStatus === "router_disconnected") scheduleLocalAgentReprobe();
  })(), 1_500);
}

async function connectRegisteredLocalAgent() {
  if (!localRuntimeState.device?.id) return;
  await refreshLocalSession();
  await loadLocalRuntimes();
  await loadLocalScopes();
  await reconcileStrictLocalRuns();
  await loadLocalAgentConfig();
  updateLocalControls();
}

async function probeLocalAgent() {
  localRuntimeState.agentStatus = "checking";
  renderLocalAgentState();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await localAgentClient.health({ signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.status !== "ready") throw new Error(`Local Agent HTTP ${response.status}`);
    localRuntimeState.agentHealth = body;
    localStorage.setItem("agentloop.local-agent-seen.v1", "1");
    localRuntimeState.agentStatus = body.protocolVersion !== LOCAL_AGENT_PROTOCOL_VERSION ? "incompatible"
      : !body.router?.configured ? "router_not_configured"
      : !body.registered ? "online_unpaired"
      : body.routerConnected ? "online" : "router_disconnected";
  } catch {
    localRuntimeState.agentHealth = undefined;
    localRuntimeState.agentStatus = localStorage.getItem("agentloop.local-agent-seen.v1") === "1" ? "installed_stopped" : "not_installed";
  } finally {
    clearTimeout(timeout);
    renderLocalAgentState();
    updateLocalControls();
  }
}

function renderLocalAgentState() {
  const copy = {
    checking: ["检查中", "正在检查 Local Runtime Agent。"],
    not_installed: ["未安装 · 安装", "安装后可在本机安全地访问已授权目录。"],
    router_not_configured: ["需重新安装", "此安装包未配置当前服务端。"],
    installed_stopped: ["未启动 · 启动", "已安装的 Agent 将通过系统启动协议恢复。"],
    online_unpaired: ["未配对 · 配对", "配对后 Router 才可调度本机 Runtime。"],
    online: ["已就绪", "本机 Agent 已连接；本机目录和产物默认不上传云端。"],
    router_disconnected: ["连接中断 · 重试", "Agent 正在自动重连 Router；恢复后才可调度本机 Runtime。"],
    incompatible: ["需更新", "当前 Agent 与 Web 控制协议不兼容。"],
  }[localRuntimeState.agentStatus] || ["未就绪 · 重试", "请检查本机 Agent。"];
  $("local-agent-state-label").textContent = copy[0];
  $("enable-local-runtime").title = copy[1];
  $("enable-local-runtime").setAttribute("aria-label", `本机能力：${copy[0]}。${copy[1]}`);
  $("local-agent-state-dot").className = localRuntimeState.agentStatus;
  $("local-agent-version").textContent = localRuntimeState.agentHealth?.agentVersion ? `v${localRuntimeState.agentHealth.agentVersion}` : "";
  $("enable-local-runtime").classList.toggle("ready", localRuntimeState.agentStatus === "online");
  $("local-agent-settings").disabled = localRuntimeState.agentStatus !== "online";
}

async function offerLocalAgentInstall() {
  const platform = detectedAgentPlatform();
  const arch = await detectedAgentArchitecture();
  $("agent-install-modal").hidden = false;
  $("agent-install-description").textContent = "正在从云端获取与当前设备匹配的签名安装包…";
  $("agent-install-detail").innerHTML = "";
  $("agent-install-download").hidden = true;
  try {
    const response = await routerClient.request(`/v1/local-agent/releases/latest?platform=${encodeURIComponent(platform)}&arch=${encodeURIComponent(arch)}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(body.releases)) throw new Error(body.error || "当前环境尚未发布此设备的 Local Runtime Agent 安装包");
    const release = body.releases.find((item) => item.arch === arch) || body.releases[0];
    if (!release || release.protocolVersion !== LOCAL_AGENT_PROTOCOL_VERSION) throw new Error("没有与当前 Web 协议兼容的安装包");
    $("agent-install-description").textContent = `将下载 Local Runtime Agent ${release.version}（${release.platform}/${release.arch}）。`;
    $("agent-install-detail").innerHTML = `<dt>SHA-256</dt><dd>${escapeHtml(release.sha256)}</dd><dt>签名</dt><dd>${escapeHtml(release.signature)}</dd>`;
    const download = $("agent-install-download");
    download.href = release.downloadUrl;
    download.hidden = false;
    download.onclick = () => beginLocalAgentInstallPolling();
  } catch (error) {
    $("agent-install-description").textContent = `无法获得安装包：${error instanceof Error ? error.message : String(error)}`;
  }
}

function beginLocalAgentInstallPolling() {
  if (localRuntimeState.agentInstallPoll) clearInterval(localRuntimeState.agentInstallPoll);
  localRuntimeState.agentInstallPoll = setInterval(() => void (async () => {
    await probeLocalAgent();
    if (localRuntimeState.agentStatus === "online" || localRuntimeState.agentStatus === "online_unpaired") {
      clearInterval(localRuntimeState.agentInstallPoll); localRuntimeState.agentInstallPoll = undefined; closeLocalAgentInstall();
      if (localRuntimeState.agentStatus === "online") await loadDevices();
    }
  })(), 2_000);
}

async function startInstalledLocalAgent() {
  openLocalAgentProtocol("start");
  beginLocalAgentInstallPolling();
  setStatus("已请求系统启动 Local Runtime Agent，正在等待它上线…", "ok");
}

async function configureLocalAgentRouter(value = publicRouterUrl) {
  let routerUrl;
  try {
    routerUrl = new URL(value || publicRouterUrl);
    if (routerUrl.protocol !== "https:" && routerUrl.protocol !== "http:") throw new Error("协议必须为 HTTPS 或 HTTP");
    if (routerUrl.username || routerUrl.password || routerUrl.pathname !== "/" || routerUrl.search || routerUrl.hash) throw new Error("请填写服务端根地址，例如 https://router.example.com");
  } catch (error) {
    setStatus(`服务端地址无效：${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  openLocalAgentProtocol("configure", routerUrl.toString());
  beginLocalAgentInstallPolling();
  setStatus("已请求 Local Runtime Agent 保存服务端地址并重连…", "ok");
}

function openLocalAgentProtocol(action, routerUrl = publicRouterUrl) {
  const target = new URL(`agentloop-local-runtime://${action}`);
  target.searchParams.set("routerUrl", routerUrl);
  target.searchParams.set("webOrigin", location.origin);
  window.location.href = target.toString();
}

function closeLocalAgentInstall() { $("agent-install-modal").hidden = true; }
function detectedAgentPlatform() { return navigator.userAgent.includes("Windows") ? "windows" : navigator.userAgent.includes("Mac") ? "darwin" : "linux"; }
async function detectedAgentArchitecture() {
  const hints = navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === "function"
    ? await navigator.userAgentData.getHighEntropyValues(["architecture"]).catch(() => ({})) : {};
  const value = String(hints.architecture || "").toLowerCase();
  if (value.includes("arm")) return "arm64";
  if (value.includes("x86") || value.includes("x64")) return "x64";
  return "unknown";
}

async function refreshLocalSession() {
  const deviceId = localRuntimeState.device?.id;
  const userId = sessionState.user?.id;
  if (!deviceId || !userId) throw new Error("本机 Runtime 尚未与当前登录用户配对");
  const body = await call(`/v1/devices/${encodeURIComponent(deviceId)}/local-sessions`, {});
  if (sessionState.user?.id !== userId || localRuntimeState.device?.id !== deviceId) throw new Error("本机 Runtime 登录身份已更新，请重试");
  if (typeof body.token !== "string" || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= Date.now()) throw new Error("本机 Runtime 会话授权无效");
  sessionState.setLocalSession(body.token, body.expiresAt);
  scheduleLocalSessionRefresh(deviceId, userId);
}

function clearLocalSession() {
  sessionState.clearLocalSession();
  if (localRuntimeState.sessionRefreshTimer) clearTimeout(localRuntimeState.sessionRefreshTimer);
  localRuntimeState.sessionRefreshTimer = undefined;
}

function scheduleLocalSessionRefresh(deviceId, userId) {
  if (localRuntimeState.sessionRefreshTimer) clearTimeout(localRuntimeState.sessionRefreshTimer);
  const delay = Math.max(1_000, sessionState.localSessionExpiresAt - Date.now() - LOCAL_SESSION_REFRESH_AHEAD_MS);
  localRuntimeState.sessionRefreshTimer = setTimeout(() => {
    localRuntimeState.sessionRefreshTimer = undefined;
    if (localRuntimeState.device?.id !== deviceId || sessionState.user?.id !== userId) return;
    void refreshLocalSessionOnce().catch(() => undefined);
  }, delay);
}

/**
 * The browser-to-Agent credential is separately scoped from the device
 * credential. Connection state is not authorization state: renewing it here keeps a healthy Agent
 * usable without teaching individual directory/run/artifact operations about
 * session lifetime.  A rejected request has not reached its side effect,
 * because the Agent authenticates before dispatching every protected route.
 */
async function refreshLocalSessionOnce() {
  if (!localRuntimeState.sessionRefresh) {
    localRuntimeState.sessionRefresh = refreshLocalSession().finally(() => { localRuntimeState.sessionRefresh = undefined; });
  }
  return await localRuntimeState.sessionRefresh;
}

async function localAgentFetch(path, init = {}) {
  return await localAgentClient.request(path, init);
}

async function agentAwareFetch(endpoint, init = {}) {
  return endpoint.startsWith(`${localAgentApi}/`)
    ? await localAgentFetch(endpoint.slice(localAgentApi.length), init)
    : endpoint.startsWith(`${api}/`)
      ? await routerClient.request(endpoint.slice(api.length), init)
      : await nativeFetch(endpoint, init);
}

async function loadLocalRuntimes() {
  if (!localRuntimeState.device?.id) return;
  const response = await routerClient.request(localAgentRouterPath("/runtimes"));
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Local Agent HTTP ${response.status}`);
  localRuntimeState.runtimes = Array.isArray(body.runtimes) ? body.runtimes : [];
  if (!localRuntimeState.runtimes.some((runtime) => runtime.id === localRuntimeState.runtimeId)) {
    localRuntimeState.runtimeId = localRuntimeState.runtimes.find((runtime) => runtime.status === "ready" && runtime.isDefault)?.id
      || localRuntimeState.runtimes.find((runtime) => runtime.status === "ready")?.id
      || localRuntimeState.runtimes[0]?.id
      || "";
  }
  syncLocalRuntimeManager();
  refreshRuntimeOptions();
  updateLocalControls();
}

async function loadLocalScopes() {
  if (!sessionState.localSessionToken || !localRuntimeState.runtimeId || !selectedLocalRuntimeRunning()) { localRuntimeState.scopes = []; renderLocalScopes(); return; }
  const response = await localAgentFetch(`/v1/directory-scopes?runtimeId=${encodeURIComponent(localRuntimeState.runtimeId)}`);
  if (!response.ok) { localRuntimeState.scopes = []; renderLocalScopes(); return; }
  localRuntimeState.scopes = (await response.json()).scopes || [];
  renderLocalScopes();
}

function updateLocalControls() {
  const view = localRuntimeViewModel({
    agentStatus: localRuntimeState.agentStatus,
    device: localRuntimeState.device,
    localSessionToken: sessionState.localSessionToken,
    runtimes: localRuntimeState.runtimes,
    runtimeId: localRuntimeState.runtimeId,
    localExecution: isLocalExecution(),
  });
  const paired = view.paired;
  const localToggle = $("use-local-runtime");
  localToggle.disabled = !paired;
  if (paired) {
    const preferenceKey = localRuntimePreferenceKey(sessionState.user?.id, localRuntimeState.device?.id);
    if (preferenceKey && localRuntimeState.hydratedPreferenceKey !== preferenceKey) {
      const preference = loadLocalRuntimePreference(localStorage, sessionState.user?.id, localRuntimeState.device?.id);
      // A missing value belongs to this user/device just as much as an
      // explicit false: never carry the previous device's DOM state across.
      localToggle.checked = preference === true;
      localRuntimeState.hydratedPreferenceKey = preferenceKey;
    }
  } else {
    // Losing the live pairing only suspends the UI. Do not turn this temporary
    // safety reset into a persisted user choice, or reconnection could not
    // restore the user's local-execution preference.
    localRuntimeState.hydratedPreferenceKey = "";
    if (localToggle.checked) localToggle.checked = false;
    localRuntimeState.scopes = [];
  }
  const local = isLocalExecution();
  const runtimeReady = view.runtimeReady;
  const hasReadyRuntime = view.hasReadyRuntime;
  // The Runtime selection is visible as soon as a device is paired, even when
  // local execution is off.  It remains a preference until the checkbox opts
  // the next submission into the selected device Runtime.
  $("local-runtime-picker").hidden = !paired;
  $("runtime").disabled = view.runtimeDisabled;
  $("directory-scope")?.toggleAttribute("disabled", view.directoryScopeDisabled);
  $("local-runtime-manager").hidden = view.runtimeManagerHidden;
  $("upload-file").toggleAttribute("disabled", view.uploadDisabled);
  syncLocalRuntimeManager();
  renderLocalScopes();
}

async function addDirectoryScope() {
  if (!sessionState.localSessionToken || !localRuntimeState.runtimeId) { setStatus("请先启用并选择本机 Runtime", "error"); return; }
  try {
    const response = await localAgentFetch("/v1/directory-scopes/pick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runtimeId: localRuntimeState.runtimeId }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Local Agent HTTP ${response.status}`);
    if (body.cancelled === true) return;
    localRuntimeState.scopes = [body.scope, ...localRuntimeState.scopes.filter((scope) => scope.id !== body.scope.id)];
    renderLocalScopes();
    setStatus(`已授权本机目录：${body.scope.displayName}`, "ok");
  } catch (error) { setStatus(`目录授权失败：${error instanceof Error ? error.message : String(error)}`, "error"); }
}

function renderLocalScopes() {
  const container = $("local-directory-scopes");
  if (!container) return;
  // The authority endpoint returns active scopes only. Keep this filter as a
  // client-side guard against a stale response completing after revocation.
  const activeScopes = localRuntimeState.scopes.filter((scope) => scope.status === "active");
  const visible = isLocalExecution() && activeScopes.length > 0;
  container.hidden = !visible;
  container.innerHTML = visible ? `<span class="runtime-directory-label"><span class="scope-icon" aria-hidden="true">▣</span>当前 Runtime 已授权目录</span>${activeScopes.map((scope) => `<span class="source-chip local-scope-chip"><span>${escapeHtml(scope.displayName)}</span><small>已授权</small><button type="button" data-revoke-local-scope="${escapeHtml(scope.id)}" aria-label="撤销目录 ${escapeHtml(scope.displayName)}">×</button></span>`).join("")}` : "";
  container.querySelectorAll("[data-revoke-local-scope]").forEach((button) => button.addEventListener("click", () => void revokeLocalScope(button.dataset.revokeLocalScope)));
}

async function revokeLocalScope(scopeId) {
  if (!scopeId || !localRuntimeState.runtimeId) return;
  try {
    const response = await localAgentFetch(`/v1/directory-scopes/${encodeURIComponent(scopeId)}/revoke`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runtimeId: localRuntimeState.runtimeId }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Local Agent HTTP ${response.status}`);
    }
    await loadLocalScopes();
    setStatus("已撤销本机目录授权", "ok");
  } catch (error) { setStatus(`撤销目录失败：${error instanceof Error ? error.message : String(error)}`, "error"); }
}

function openCreateLocalRuntime() {
  $("runtime-create-name").value = "";
  $("runtime-create-modal").hidden = false;
  $("runtime-create-name").focus();
}

function closeCreateLocalRuntime() { $("runtime-create-modal").hidden = true; }

async function createLocalRuntime(displayName) {
  if (!displayName?.trim()) return;
  try {
    const response = await routerClient.postJson(localAgentRouterPath("/runtimes"), { displayName: displayName.trim() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Local Agent HTTP ${response.status}`);
    localRuntimeState.runtimeId = body.runtime.id;
    await loadLocalRuntimes();
    await loadLocalScopes();
    closeCreateLocalRuntime();
    setStatus(`已创建 ${body.runtime.displayName}`, "ok");
  } catch (error) { setStatus(`创建 Runtime 失败：${error instanceof Error ? error.message : String(error)}`, "error"); }
}

function openConfigureLocalRuntime(runtimeId = localRuntimeState.runtimeId) {
  const runtime = selectedLocalRuntime(runtimeId);
  if (!runtime) return;
  localRuntimeState.runtimeId = runtime.id;
  $("runtime-config-name").value = runtime.displayName;
  $("runtime-config-id").textContent = runtime.id;
  $("runtime-config-status").textContent = runtimeStatusLabel(runtime.status);
  $("runtime-config-modal").hidden = false;
  $("runtime-config-name").focus();
}

function closeConfigureLocalRuntime() { $("runtime-config-modal").hidden = true; }

async function saveLocalRuntimeConfiguration() {
  const runtime = selectedLocalRuntime();
  const displayName = $("runtime-config-name").value.trim();
  if (!runtime || !displayName) return;
  try {
    const response = await routerClient.request(localAgentRouterPath(`/runtimes/${encodeURIComponent(runtime.id)}`), {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Local Agent HTTP ${response.status}`);
    await loadLocalRuntimes();
    closeConfigureLocalRuntime();
    setStatus("已更新 Runtime 配置", "ok");
  } catch (error) { setStatus(`更新 Runtime 配置失败：${error instanceof Error ? error.message : String(error)}`, "error"); }
}

async function deleteLocalRuntime(runtimeId = localRuntimeState.runtimeId) {
  const runtime = selectedLocalRuntime(runtimeId);
  if (!runtime) return;
  if (runtime.isDefault) { setStatus("默认 Runtime 不能删除", "error"); return; }
  if (!confirm(`删除“${runtime.displayName}”？该 Runtime 必须没有活动任务；确认后会停止并回收其独立运行记录与目录授权。设备级共享产物和 Skill 不会删除。`)) return;
  try {
    const response = await routerClient.request(localAgentRouterPath(`/runtimes/${encodeURIComponent(runtime.id)}`), { method: "DELETE" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Local Agent HTTP ${response.status}`);
    localRuntimeState.runtimeId = "";
    await loadLocalRuntimes();
    await loadLocalScopes();
    setStatus("已删除 Runtime，并回收其独立状态", "ok");
  } catch (error) { setStatus(`删除 Runtime 失败：${error instanceof Error ? error.message : String(error)}`, "error"); }
}

async function loadLocalAgentConfig() {
  if (!localRuntimeState.device?.id) return;
  const response = await routerClient.request(localAgentRouterPath("/config"));
  if (!response.ok) return;
  localRuntimeState.agentConfig = await response.json().catch(() => undefined);
  renderLocalAgentConfig();
}

function renderLocalAgentConfig() {
  const storage = localRuntimeState.agentConfig?.sharedStorage;
  const uploadStorage = localRuntimeState.agentConfig?.uploadStorage;
  $("agent-settings-version").textContent = localRuntimeState.agentConfig?.agentVersion ? `v${localRuntimeState.agentConfig.agentVersion} · 协议 ${localRuntimeState.agentConfig.protocolVersion}` : "-";
  $("agent-settings-storage").textContent = storage?.path || "-";
  $("agent-settings-upload-storage").textContent = uploadStorage?.path || defaultUploadStoragePath(storage?.path);
  $("agent-router-url").textContent = localRuntimeState.agentConfig?.router?.url || localRuntimeState.agentHealth?.router?.url || publicRouterUrl;
}

function defaultUploadStoragePath(sharedStoragePath) {
  if (typeof sharedStoragePath !== "string" || sharedStoragePath.length === 0) return "-";
  const normalized = sharedStoragePath.replace(/[\\/]+$/, "");
  const separator = normalized.includes("\\") ? "\\" : "/";
  const parentEnd = normalized.lastIndexOf(separator);
  return parentEnd < 0 ? "uploads" : `${normalized.slice(0, parentEnd)}${separator}uploads`;
}

async function openLocalAgentSettings() {
  if (!sessionState.localSessionToken) return;
  await Promise.all([loadLocalAgentConfig(), loadLocalRuntimes()]);
  renderLocalAgentConfig();
  syncLocalRuntimeManager();
  $("agent-settings-modal").hidden = false;
}

function closeLocalAgentSettings() { $("agent-settings-modal").hidden = true; }

async function pickSharedStorage() {
  try {
    const response = await routerClient.postJson(localAgentRouterPath("/config/shared-storage/pick"), {});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Local Agent HTTP ${response.status}`);
    if (body.cancelled) return;
    localRuntimeState.agentConfig = { ...(localRuntimeState.agentConfig || {}), sharedStorage: body.sharedStorage };
    renderLocalAgentConfig();
    await loadLocalRuntimes();
    await loadLocalScopes();
    setStatus("已切换设备级共享存储，所有运行中的子 Runtime 已重新加载", "ok");
  } catch (error) { setStatus(`切换共享存储失败：${error instanceof Error ? error.message : String(error)}`, "error"); }
}

async function pickUploadStorage() {
  try {
    const response = await routerClient.postJson(localAgentRouterPath("/config/upload-storage/pick"), {});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Local Agent HTTP ${response.status}`);
    if (body.cancelled) return;
    localRuntimeState.agentConfig = { ...(localRuntimeState.agentConfig || {}), uploadStorage: body.uploadStorage };
    renderLocalAgentConfig();
    await loadLocalRuntimes();
    setStatus("已切换设备级上传源文件目录，所有运行中的子 Runtime 已重新加载", "ok");
  } catch (error) { setStatus(`切换上传源文件目录失败：${error instanceof Error ? error.message : String(error)}`, "error"); }
}

async function applyLocalRuntimeLifecycle(action, runtimeId = localRuntimeState.runtimeId) {
  if (!runtimeId) return;
  try {
    const response = await routerClient.request(localAgentRouterPath(`/runtimes/${encodeURIComponent(runtimeId)}/${action}`), { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Local Agent HTTP ${response.status}`);
    await loadLocalRuntimes();
    await loadLocalScopes();
    const labels = { drain: "已进入 Drain", restart: "重启请求已提交", stop: "已停止", start: "已启动" };
    setStatus(`${body.runtime.displayName}：${labels[action]}`, body.runtime.status === "failed" ? "error" : "ok");
  } catch (error) { setStatus(`Runtime 操作失败：${error instanceof Error ? error.message : String(error)}`, "error"); }
}

async function toggleLocalRuntimeStarted(runtimeId = localRuntimeState.runtimeId) {
  const runtime = selectedLocalRuntime(runtimeId);
  if (!runtime) return;
  await applyLocalRuntimeLifecycle(runtime.status === "stopped" || (runtime.status === "draining" && !runtime.pendingAction) ? "start" : "stop", runtime.id);
}

async function selectLocalRuntime(runtimeId) {
  if (!localRuntimeState.runtimes.some((runtime) => runtime.id === runtimeId)) return;
  localRuntimeState.runtimeId = runtimeId;
  refreshRuntimeOptions();
  await loadLocalScopes();
  updateLocalControls();
  render();
}

function selectedLocalRuntime(runtimeId = localRuntimeState.runtimeId) { return localRuntimeState.runtimes.find((runtime) => runtime.id === runtimeId); }
function runtimeDisplayNameFor(runtimeId) { return selectedLocalRuntime(runtimeId)?.displayName; }
function selectedLocalRuntimeRunning() { return selectedLocalRuntime()?.status !== "stopped" && selectedLocalRuntime()?.status !== "failed"; }
function isLocalExecution() { return $("use-local-runtime")?.checked === true; }
function localHeaders(json = false) { return { ...(json ? { "content-type": "application/json" } : {}), "x-local-session": sessionState.localSessionToken }; }
function localAgentRouterPath(suffix) {
  if (!localRuntimeState.device?.id) throw new Error("本机 Agent 尚未配对");
  return `/v1/devices/${encodeURIComponent(localRuntimeState.device.id)}/local-agent${suffix}`;
}

function syncLocalRuntimeManager() {
  const list = $("local-runtime-list");
  if (!list) return;
  list.innerHTML = localRuntimeListMarkup(localRuntimeState.runtimes, localRuntimeState.runtimeId, escapeHtml, runtimeStatusLabel);
}

function runtimeStatusLabel(status) {
  return status === "ready" ? "就绪" : status === "draining" ? "排空中" : status === "restarting" ? "重启中" : status === "stopped" ? "已停止" : "失败";
}

function redirectToLogin() {
  if (location.pathname === "/login" || location.pathname === "/register") return;
  const next = `${location.pathname}${location.search}${location.hash}`;
  location.replace(`/login?next=${encodeURIComponent(next)}`);
}

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

async function loadConversationPage(reset = false) {
  if (conversationState.loadingMore || (!reset && !conversationState.hasMore)) return;
  if (!sessionState.user || !sessionState.authToken) return;
  const tenantId = $("tenant-id").value.trim();
  const userId = $("user-id").value.trim();
  if (!tenantId || !userId) return;
  const offset = reset ? 0 : conversationState.nextOffset;
  conversationState.loadingMore = true;
  render();
  try {
    const response = await fetchWithRouterStartupRetry(`${api}/v1/conversations?limit=${CONVERSATION_PAGE_SIZE}&offset=${offset}`, {
      headers: { "x-tenant-id": tenantId, "x-user-id": userId },
    }, reset);
    const body = await response.json().catch(() => undefined);
    if (!response.ok || !Array.isArray(body?.conversations)) throw new Error(body?.error || `HTTP ${response.status}`);
    mergeConversationSummaries(body.conversations, reset);
    if (reset) conversationState.visibleLimit = CONVERSATION_PAGE_SIZE;
    else conversationState.visibleLimit += CONVERSATION_PAGE_SIZE;
    conversationState.hasMore = body.hasMore === true;
    conversationState.nextOffset = Number.isSafeInteger(body.nextOffset) ? body.nextOffset : offset + body.conversations.length;
    conversationState.activeId = activeConversation()?.id ?? newConversation().id;
    if (reset) {
      // Browser snapshots are only an offline recovery aid. Once the Router is
      // reachable, refresh the active conversation so every persisted reply
      // is rebound to its authoritative Assignment artifacts.
      await selectConversation(conversationState.activeId);
      void reconcileStrictLocalRuns();
    }
  } catch (error) {
    if (reset && conversationState.sessions.length === 0) {
      conversationState.sessions = [...conversationState.recovered];
      conversationState.activeId = conversationState.sessions[0]?.id ?? newConversation().id;
      setStatus("会话列表加载失败，已显示本地恢复缓存", "error");
    } else if (!reset) {
      setStatus(`加载更多对话失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  } finally {
    conversationState.loadingMore = false;
    render();
  }
}

async function fetchWithRouterStartupRetry(url, init = {}, retryStartupFailure = false) {
  let lastError;
  const delays = retryStartupFailure ? ROUTER_STARTUP_RETRY_DELAYS_MS : [];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (!retryStartupFailure || !isRouterStartupFailure(response)) return response;
      lastError = new Error(`router_unavailable:${response.status}`);
    } catch (error) {
      if (!retryStartupFailure || !isNetworkFailure(error)) throw error;
      lastError = error;
    }
    if (attempt < delays.length) await new Promise((resolveDelay) => setTimeout(resolveDelay, delays[attempt]));
  }
  throw lastError ?? new Error("router_unavailable");
}

function isRouterStartupFailure(response) {
  return response.status === 502 || response.status === 503 || response.status === 504;
}

function isNetworkFailure(error) {
  return error instanceof TypeError || (error instanceof Error && /fetch failed|network|ECONNREFUSED|socket/i.test(error.message));
}

function mergeConversationSummaries(summaries, reset = false, state = conversationStateForEvaluation()) {
  const coordination = runtimeCoordinationState();
  const byId = new Map([...state.recovered, ...state.sessions].map((conversation) => [conversation.id, conversation]));
  const nextSessions = reset ? [...state.sessions] : state.sessions;
  if (reset) {
    for (const recovered of state.recovered) {
      if ((recovered.messages || []).some((message) => message?.role === "assistant" && message.localRunId) && !nextSessions.some((conversation) => conversation.id === recovered.id)) {
        nextSessions.push(recovered);
      }
    }
  }
  for (const summary of summaries) {
    if (!summary || typeof summary.id !== "string") continue;
    const existing = byId.get(summary.id);
    if (existing) {
      existing.title = existing.title && existing.title !== "新对话" ? existing.title : String(summary.title || "新对话");
      existing.createdAt = finiteNumber(existing.createdAt, summary.createdAt);
      // Server activity time is authoritative, including downward corrections
      // after a stale observation polluted browser cache ordering.
      existing.updatedAt = coordination.activeByConversation.has(existing.id)
        ? Math.max(finiteNumber(existing.updatedAt, 0), finiteNumber(summary.updatedAt, 0))
        : finiteNumber(summary.updatedAt, existing.updatedAt);
      existing.runCount = finiteNumber(summary.runCount, existing.runCount);
      existing.lastStatus = typeof summary.lastStatus === "string" ? summary.lastStatus : existing.lastStatus;
      if (reset) existing.historyLoaded = false;
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
  state.sessions.splice(0, state.sessions.length, ...sortSessions(nextSessions));
}

// Keeping the projection function independently evaluable is useful for the
// browser recovery tests and for future workers that do not own the page
// singleton. The production path always resolves to conversationState.
function conversationStateForEvaluation() {
  if (typeof conversationState !== "undefined") return conversationState;
  if (typeof sessions !== "undefined" && typeof recoveredSessions !== "undefined") return { sessions, recovered: recoveredSessions };
  throw new Error("conversation_state_unavailable");
}

function runtimeCoordinationState() {
  if (typeof runState !== "undefined") return runState;
  return {
    activeByConversation: typeof activeRunsByConversation !== "undefined" ? activeRunsByConversation : new Map(),
    pendingLiveAssistantIds: typeof pendingLiveAssistantIds !== "undefined" ? pendingLiveAssistantIds : new Set(),
  };
}

function sortSessions(values) {
  return [...values].sort((left, right) => finiteNumber(right?.updatedAt, 0) - finiteNumber(left?.updatedAt, 0) || String(right?.id || "").localeCompare(String(left?.id || "")));
}

function finiteNumber(value, fallback) { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }

async function selectConversation(conversationId) {
  const conversation = conversationState.sessions.find((item) => item.id === conversationId);
  if (!conversation) return;
  resetArtifactWorkspace();
  conversationState.activeId = conversation.id;
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
    const assistants = conversation.messages
      .filter((message) => message.role === "assistant" && typeof message.assignmentId === "string");
    // Conversation history stores the durable turn/result index, while the
    // assignment artifact endpoint owns downloadable artifact identities.
    // Rehydrate every historical assistant turn so a final artifact remains
    // attached to the reply that delivered it after reload or another device
    // opens the conversation. Running turns additionally need status/events.
    await Promise.allSettled(assistants.map((assistant) => assistant.status === "running"
      ? hydratePersistedAssistant(assistant, tenantId, userId)
      : refreshArtifacts(assistant.assignmentId, assistant, tenantId, userId)));
    const selected = selectedAssistantMessage(conversation);
    if (selected?.assignmentId) {
      conversation.selectedAssistantId = selected.id;
      await hydrateCommandEvidence(selected, tenantId, userId);
      runState.hydratedDetailAssignmentIds.add(selected.assignmentId);
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
  await Promise.all(conversationState.sessions.flatMap((conversation) => (conversation.messages || []).map(async (message) => {
    if (message?.role !== "assistant" || typeof message.assignmentId !== "string" || runState.activeByConversation.has(conversation.id)) return;
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
  if (typeof run?.remoteRunId === "string") assistant.remoteRunId = run.remoteRunId;
  const modelChanged = typeof run?.modelKey === "string" && run.modelKey.trim().length > 0 && assistant.modelKey !== run.modelKey;
  if (modelChanged) assistant.modelKey = run.modelKey;
  if (run?.status === "running") {
    if ((assistant.events || []).some((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.type))) return modelChanged;
    if (assistant.status === "failed") {
      // Repair old browser caches that recorded a transport error as a Run failure.
      assistant.status = "running"; assistant.error = undefined; assistant.text = ""; assistant.completedAt = undefined;
      return true;
    }
    return modelChanged;
  }
  if (!run || !["completed", "failed", "cancelled"].includes(run.status)) return false;
  assistant.status = run.status;
  assistant.connection = undefined;
  assistant.error = undefined;
  if (run.status === "completed" && typeof run.output === "string") assistant.text = run.output;
  if (run.status === "failed") {
    assistant.error = recoveredFailureMessage(run) || assistant.error || "本次未能形成可提交的最终结果。";
    // Failed Runs can carry a Runtime-authored final report. It is not a
    // successful answer, but it is the user-facing terminal summary and must
    // survive browser reload just like the live terminal event projection.
    assistant.partialText = typeof run.output === "string" && run.output.trim()
      ? run.output
      : typeof run.partialOutput === "string" && run.partialOutput.trim()
        ? run.partialOutput
        : undefined;
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
      return typeof run?.output === "string" && run.output.trim()
        ? "本轮达到可用轮次上限；以下为已持久化的执行总结，尚非成功交付。"
        : "本轮达到可用轮次上限，尚未形成最终结果。";
    case "STEP_NOT_COMPLETED":
      return "本次结果未通过最终验收。";
    case "ASSESSMENT_ERROR":
      return "本次结果仍未通过验收确认。";
    case "MODEL_ERROR":
      return "本次处理暂时未能完成。";
    case "TOOL_EXECUTION_ERROR":
      return "处理未能继续完成。";
    case "TOOL_POLICY_DENIED":
    case "FORBIDDEN":
      return "当前内容需要更多权限才能继续处理。";
    default:
      return "本次未能形成可提交的最终结果。";
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
    if (!response.ok) throw new Error(`router_unavailable:${response.status}`);
    const body = await response.json();
    const models = Array.isArray(body.models) ? body.models : [];
    $("model-select").innerHTML = `<option value="">使用 Runtime 默认模型</option>` + models.map((model) => `<option value="${escapeHtml(model.key)}">${escapeHtml(model.displayName || model.key)}</option>`).join("");
    if (models[0]) setStatus(models[0].displayName || models[0].key, "ok");
  } catch (error) { setStatus(`Router 暂不可达：${error instanceof Error ? error.message : String(error)}`, "error"); }
}

function refreshRuntimeOptions() {
  const select = $("runtime");
  if (!select) return;
  const view = localRuntimeViewModel({
    agentStatus: localRuntimeState.agentStatus,
    device: localRuntimeState.device,
    localSessionToken: sessionState.localSessionToken,
    runtimes: localRuntimeState.runtimes,
    runtimeId: localRuntimeState.runtimeId,
    localExecution: isLocalExecution(),
  });
  if (!view.paired) {
    select.innerHTML = "";
    select.disabled = true;
    return;
  }
  select.innerHTML = localRuntimeOptions(localRuntimeState.runtimes, escapeHtml, runtimeStatusLabel);
  select.value = localRuntimeState.runtimeId;
  select.disabled = view.runtimeDisabled;
}

async function submit() {
  const input = $("input").value.trim();
  const conversation = activeConversation();
  if (!input || !conversation) return;
  const executionTarget = isLocalExecution() ? "local" : "cloud";
  if (executionTarget === "local" && !sessionState.localSessionToken) { setStatus("本机运行需要先启用 Local Runtime", "error"); return; }
  if (executionTarget === "local" && selectedLocalRuntime()?.status !== "ready") { setStatus("请选择处于就绪状态的本机 Runtime", "error"); return; }
  if (runState.activeByConversation.has(conversation.id) || conversation.messages.some((message) => message.role === "assistant" && message.status === "running" && (message.assignmentId || message.localRunId))) { setStatus("当前会话仍在发起或执行；请等待或点击停止", "error"); return; }
  if (uploadCount(conversation.id) > 0) { setStatus("文件仍在上传，请稍候再发送", "error"); return; }
  const tenantId = $("tenant-id").value.trim();
  const ownerUserId = $("user-id").value.trim();
  if (!sessionState.user || !tenantId || !ownerUserId) { setStatus("请先登录", "error"); return; }
  const attachments = pendingAttachments(conversation);
  const activeRun = { assignmentId: null, abortController: null, submitAbortController: new AbortController(), submitTimedOut: false, submitTimeout: null, assistant: null };
  runState.activeByConversation.set(conversation.id, activeRun);
  conversation.pendingAttachments = [];
  const submittedAt = Date.now();
  const userMessage = { id: crypto.randomUUID(), role: "user", text: input, attachments, createdAt: submittedAt };
  const assistantMessage = {
    id: crypto.randomUUID(), role: "assistant", text: "", reasoning: "", status: "running", events: [], plan: [], createdAt: submittedAt,
    executionLocation: executionTarget,
  };
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
    const localSourceIds = attachments.filter((attachment) => attachment.dataPlane === "local_runtime").map((attachment) => attachment.id);
    const cloudAttachmentIds = attachments.filter((attachment) => attachment.dataPlane !== "local_runtime").map((attachment) => attachment.id);
    if (executionTarget === "local" && cloudAttachmentIds.length > 0) throw new Error("本机运行不能读取云端附件；请重新选择本机文件上传");
    if (executionTarget === "cloud" && localSourceIds.length > 0) throw new Error("云端运行不能读取本机 Runtime 文件；请重新选择云端文件上传");
    if (executionTarget === "local" && attachments.some((attachment) => attachment.dataPlane === "local_runtime" && attachment.runtimeId !== localRuntimeState.runtimeId)) {
      throw new Error("本机文件属于另一个 Runtime；请切回其 Runtime 或重新上传");
    }
    const payload = {
      conversationId: conversation.id,
      clientMessageId: userMessage.id,
      input,
      attachmentIds: cloudAttachmentIds,
      ...(executionTarget === "local" ? { localDirectoryScopeIds: localRuntimeState.scopes.filter((scope) => scope.status === "active").map((scope) => scope.id) } : {}),
      ...(executionTarget === "local" && localSourceIds.length > 0 ? { localUploadedSourceIds: localSourceIds } : {}),
      ...(executionTarget === "local" && localSourceIds.length > 0 ? { messageAttachments: attachmentSnapshots(attachments) } : {}),
      ...($("model-select").value ? { requestedModelKey: $("model-select").value } : {}),
    };
    activeRun.submitTimeout = setTimeout(() => { activeRun.submitTimedOut = true; activeRun.submitAbortController.abort(); }, 15_000);
    const body = await call("/v2/tasks", {
      schema: "agentloop.task/v2",
      executionTarget: executionTarget === "local"
        ? { kind: "local_device", deviceId: localRuntimeState.device.id, runtimeId: localRuntimeState.runtimeId }
        : { kind: "cloud_pool" },
      dataPolicy: { mode: executionTarget },
      ...payload,
    }, activeRun.submitAbortController.signal);
    clearTimeout(activeRun.submitTimeout);
    activeRun.submitTimeout = null;
    activeRun.assignmentId = body.assignment.id;
    assistantMessage.assignmentId = activeRun.assignmentId;
    assistantMessage.runtimeId = body.assignment.runtimeId;
    assistantMessage.runtimeDisplayName = runtimeDisplayNameFor(body.assignment.runtimeId);
    assistantMessage.executionLocation = executionTarget === "local" ? "local" : "cloud";
    if (executionTarget === "local") assistantMessage.localRuntimeId = body.assignment.runtimeId;
    if (body.assignment.status === "failed") {
      assistantMessage.status = "failed";
      assistantMessage.error = typeof body.assignment.errorMessage === "string" ? body.assignment.errorMessage : "该轮未成功创建 Runtime Run";
      assistantMessage.text = assistantMessage.error;
      completeAssistantMessage(assistantMessage);
      setStatus(assistantMessage.error, "error");
      saveSessions();
      render();
      return;
    }
    setStatus(`${executionTarget === "local" ? "本机" : "云端"}已分配 ${assistantMessage.runtimeDisplayName || "未命名 Runtime"} · SSE 连接中`, "running");
    saveSessions();
    render();
    await streamAssignment(activeRun.assignmentId, conversation, assistantMessage, tenantId, ownerUserId, activeRun);
  } catch (error) {
    if (activeRun.assignmentId) {
      if (error?.name !== "AbortError") setStatus("观察连接中断，任务状态以 Runtime 为准；重新打开会话可继续同步", "error");
    } else if (error?.name !== "AbortError" || activeRun.submitTimedOut) { assistantMessage.status = "failed"; assistantMessage.text = activeRun.submitTimedOut ? "发起会话超时，请重试" : submissionFailureMessage(error); completeAssistantMessage(assistantMessage); saveSessions(); render(); setStatus("任务失败", "error"); }
  } finally {
    if (activeRun.submitTimeout !== null) clearTimeout(activeRun.submitTimeout);
    if (runState.activeByConversation.get(conversation.id) === activeRun) runState.activeByConversation.delete(conversation.id);
    render();
  }
}

function runComposerAction() {
  const conversation = activeConversation();
  if (!conversation) return;
  const target = cancellationTarget(runState.activeByConversation.get(conversation.id), conversation.messages);
  if (target.canCancel) { void cancelActive(); return; }
  void submit();
}

async function uploadAttachments(fileList) {
  const conversation = activeConversation();
  const tenantId = $("tenant-id").value.trim();
  const ownerUserId = $("user-id").value.trim();
  const selected = [...(fileList || [])].slice(0, Math.max(0, MAX_PENDING_ATTACHMENTS - pendingAttachments(conversation).length));
  $("attachment").value = "";
  if (!conversation || selected.length === 0 || runState.activeByConversation.has(conversation.id)) return;
  if (!sessionState.user || !tenantId || !ownerUserId) { setStatus("请先登录", "error"); return; }
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
        const local = isLocalExecution();
        if (local && (!sessionState.localSessionToken || !localRuntimeState.runtimeId || selectedLocalRuntime()?.status !== "ready")) {
          throw new Error("请先启用并选择处于就绪状态的本机 Runtime");
        }
        const body = local
          ? await localUploadSource(file, conversation.id, localRuntimeState.runtimeId)
          : await call("/v1/attachments", {
          conversationId: conversation.id,
          originalName: file.name,
          mediaType: file.type || "application/octet-stream",
          contentBase64: await toBase64(file),
        });
        const attachment = local ? body?.source : body?.attachment;
        if (!attachment || typeof attachment.id !== "string" || typeof attachment.originalName !== "string" || typeof attachment.byteSize !== "number") {
          throw new Error("上传服务返回的附件无效");
        }
        conversation.pendingAttachments = [...pendingAttachments(conversation), local ? { ...attachment, dataPlane: "local_runtime", runtimeId: localRuntimeState.runtimeId } : attachment].slice(0, MAX_PENDING_ATTACHMENTS);
        saveSessions();
      } catch (error) {
        failures.push(uploadFailureMessage(file, error));
      } finally {
        changeUploadCount(conversation.id, -1);
        render();
      }
    }
  } finally {
    if (uploadCount(conversation.id) === 0 && !runState.activeByConversation.has(conversation.id)) {
      setStatus(failures.length > 0 ? uploadFailureStatus(failures) : "文件已准备好", failures.length > 0 ? "error" : "ok");
    }
  }
}

async function localUploadSource(file, conversationId, runtimeId) {
  const response = await localAgentFetch("/v1/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runtimeId, conversationId, originalName: file.name, mediaType: file.type || "application/octet-stream", contentBase64: await toBase64(file) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Local Agent HTTP ${response.status}`);
  if (body.runtimeId !== runtimeId) throw new Error("本机上传返回了不匹配的 Runtime");
  return body;
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
  return runState.uploadingByConversation.get(conversationId) || 0;
}

function changeUploadCount(conversationId, delta) {
  const next = Math.max(0, uploadCount(conversationId) + delta);
  if (next === 0) runState.uploadingByConversation.delete(conversationId);
  else runState.uploadingByConversation.set(conversationId, next);
}

function removePendingAttachment(conversation, attachmentId) {
  if (!conversation || runState.activeByConversation.has(conversation.id)) return;
  conversation.pendingAttachments = pendingAttachments(conversation).filter((attachment) => attachment.id !== attachmentId);
  saveSessions();
  render();
}

function attachmentSnapshots(attachments) {
  return attachments.map((attachment) => ({
    id: attachment.id,
    originalName: attachment.originalName,
    mediaType: attachment.mediaType || "application/octet-stream",
    byteSize: attachment.byteSize,
  }));
}

async function streamAssignment(assignmentId, conversation, assistant, tenantId, userId, activeRun) {
  activeRun.abortController = new AbortController();
  await observeAssignment({
    baseUrl: `${api}/v1/assignments/${encodeURIComponent(assignmentId)}`,
    headers: { "x-tenant-id": tenantId, "x-user-id": userId },
    signal: activeRun.abortController.signal,
    afterSeq: Math.max(0, ...(assistant.events || []).map((event) => Number.isSafeInteger(event.seq) ? event.seq : 0)),
    onEvent: (event) => onEvent(event, conversation, assistant),
    onStatus: (run) => {
      applyRecoveredRunState(assistant, run);
      requestLiveAssistantUpdate(assistant);
    },
    onRun: (run) => {
      applyRecoveredRunState(assistant, run);
      flushTerminalAssistantUpdate(assistant);
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

async function observeStrictLocalRun(conversation, assistant, activeRun) {
  const runtimeId = assistant.localRuntimeId;
  const runId = assistant.localRunId;
  if (!runtimeId || !runId) throw new Error("strict_local_run_identity_missing");
  activeRun.abortController = new AbortController();
  let afterSeq = Math.max(0, ...(assistant.events || []).map((event) => Number.isSafeInteger(event.seq) ? event.seq : 0));
  let transientFailures = 0;
  while (!activeRun.abortController.signal.aborted && assistant.status === "running") {
    try {
      const [eventsResponse, runResponse] = await Promise.all([
        localAgentFetch(`/v1/strict-local-runs/${encodeURIComponent(runtimeId)}/${encodeURIComponent(runId)}/events?afterSeq=${afterSeq}`, { signal: activeRun.abortController.signal }),
        localAgentFetch(`/v1/strict-local-runs/${encodeURIComponent(runtimeId)}/${encodeURIComponent(runId)}`, { signal: activeRun.abortController.signal }),
      ]);
      const [eventsBody, runBody] = await Promise.all([eventsResponse.json().catch(() => ({})), runResponse.json().catch(() => ({}))]);
      if (!eventsResponse.ok) throw new Error(eventsBody.error || `Local Agent HTTP ${eventsResponse.status}`);
      if (!runResponse.ok) throw new Error(runBody.error || `Local Agent HTTP ${runResponse.status}`);
      transientFailures = 0;
      for (const event of Array.isArray(eventsBody.events) ? eventsBody.events : []) {
        if (Number.isSafeInteger(event.seq)) afterSeq = Math.max(afterSeq, event.seq);
        onEvent(event, conversation, assistant);
      }
      applyRecoveredRunState(assistant, runBody.run);
      if (["completed", "failed", "cancelled"].includes(assistant.status)) flushTerminalAssistantUpdate(assistant);
      else requestLiveAssistantUpdate(assistant);
      if (assistant.status !== "running") break;
      await waitForStrictLocalPoll(activeRun.abortController.signal);
    } catch (error) {
      if (activeRun.abortController.signal.aborted) break;
      transientFailures += 1;
      setStatus(`本机事件连接暂时中断，正在重连：${error instanceof Error ? error.message : String(error)}`, "error");
      await waitForStrictLocalPoll(activeRun.abortController.signal, Math.min(3_000, 500 * transientFailures));
    }
  }
  if (["completed", "failed", "cancelled"].includes(assistant.status)) {
    await refreshStrictLocalArtifacts(assistant);
    setStatus(assistant.status === "completed" ? "严格本地执行已完成" : assistant.status === "cancelled" ? "已停止" : "严格本地执行失败", assistant.status === "completed" ? "ok" : "error");
  }
}

function waitForStrictLocalPoll(signal, delay = 700) {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, delay);
    function done() { signal.removeEventListener("abort", done); clearTimeout(timer); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function refreshStrictLocalArtifacts(assistant) {
  if (!assistant?.localRuntimeId || !assistant?.localRunId || !sessionState.localSessionToken) return;
  try {
    const response = await localAgentFetch(`/v1/local-runtimes/${encodeURIComponent(assistant.localRuntimeId)}/runs/${encodeURIComponent(assistant.localRunId)}/artifacts`);
    if (!response.ok) return;
    const body = await response.json();
    assistant.artifacts = (Array.isArray(body.artifacts) ? body.artifacts : []).map((artifact) => ({ ...artifact, location: "local" }));
    saveSessions();
    render();
  } catch {}
}

function resumeStrictLocalObservation(conversation, assistant) {
  if (!sessionState.localSessionToken || !assistant?.localRuntimeId || !assistant?.localRunId || assistant.status !== "running" || runState.activeByConversation.has(conversation.id)) return;
  const activeRun = { assignmentId: null, localRunId: assistant.localRunId, localRuntimeId: assistant.localRuntimeId, abortController: null, submitAbortController: null, assistant };
  runState.activeByConversation.set(conversation.id, activeRun);
  void observeStrictLocalRun(conversation, assistant, activeRun)
    .catch(() => setStatus("严格本地观察连接中断，任务仍由本机 Runtime 执行", "error"))
    .finally(() => {
      if (runState.activeByConversation.get(conversation.id) === activeRun) runState.activeByConversation.delete(conversation.id);
      saveSessions(); render();
    });
}

async function reconcileStrictLocalRuns() {
  for (const conversation of conversationState.sessions) {
    for (const assistant of conversation.messages || []) {
      if (assistant?.role === "assistant" && assistant.status === "running" && assistant.localRunId) resumeStrictLocalObservation(conversation, assistant);
    }
  }
}

function resumeAssignmentObservation(conversation, assistant, tenantId, userId) {
  if (runState.activeByConversation.has(conversation.id)) return;
  const activeRun = { assignmentId: assistant.assignmentId, abortController: null, assistant };
  runState.activeByConversation.set(conversation.id, activeRun);
  void streamAssignment(assistant.assignmentId, conversation, assistant, tenantId, userId, activeRun)
    .catch(() => { setStatus("观察连接中断，任务状态以 Runtime 为准", "error"); })
    .finally(() => {
      if (runState.activeByConversation.get(conversation.id) === activeRun) runState.activeByConversation.delete(conversation.id);
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
  if (terminal) { flushTerminalAssistantUpdate(assistant); setStatus(event.type === "run.completed" ? "已完成" : event.type === "run.cancelled" ? "已停止" : "执行失败", assistant.status === "completed" ? "ok" : "error"); return true; }
  requestLiveAssistantUpdate(assistant);
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
  const target = cancellationTarget(runState.activeByConversation.get(conversation.id), conversation.messages);
  if (!target.canCancel || !target.assistant) return;
  if (target.localRunId) {
    const runtimeId = target.activeRun?.localRuntimeId ?? target.assistant.localRuntimeId;
    if (!runtimeId || !sessionState.localSessionToken) { setStatus("无法停止严格本地任务：本机 Runtime 会话不可用", "error"); return; }
    const key = `strict:${runtimeId}:${target.localRunId}`;
    if (runState.cancellingAssignmentIds.has(key)) return;
    runState.cancellingAssignmentIds.add(key);
    render();
    try {
      const response = await localAgentFetch(`/v1/strict-local-runs/${encodeURIComponent(runtimeId)}/${encodeURIComponent(target.localRunId)}/cancel`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Local Agent HTTP ${response.status}`);
      applyRecoveredRunState(target.assistant, body.run);
      target.activeRun?.abortController?.abort();
      await refreshStrictLocalArtifacts(target.assistant);
      saveSessions();
      setStatus(body.run?.status === "cancelled" ? "已停止" : "任务已结束", body.run?.status === "completed" ? "ok" : "error");
    } catch (error) {
      setStatus(`停止失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      runState.cancellingAssignmentIds.delete(key);
      render();
    }
    return;
  }
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
  if (runState.cancellingAssignmentIds.has(target.assignmentId)) return;
  runState.cancellingAssignmentIds.add(target.assignmentId);
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
    runState.cancellingAssignmentIds.delete(target.assignmentId);
    render();
  }
}

/**
 * A streaming event belongs to one assistant turn. Keep its repaint scoped
 * to that card so an active later turn does not replace completed history.
 */
function requestLiveAssistantUpdate(assistant) {
  if (typeof assistant?.id === "string") runState.pendingLiveAssistantIds.add(assistant.id);
  liveUpdates.request();
}

function flushTerminalAssistantUpdate(assistant) {
  if (typeof assistant?.id === "string") runState.pendingLiveAssistantIds.delete(assistant.id);
  // Terminal state also changes the composer/action controls, so it is one of
  // the deliberately full renders rather than a card-only streaming update.
  liveUpdates.flush();
}

function renderPendingLiveAssistantMessages() {
  const coordination = typeof runState !== "undefined"
    ? runState
    : { pendingLiveAssistantIds: typeof pendingLiveAssistantIds !== "undefined" ? pendingLiveAssistantIds : new Set() };
  const messageIds = [...coordination.pendingLiveAssistantIds];
  coordination.pendingLiveAssistantIds.clear();
  const conversation = activeConversation();
  if (!conversation || renderedConversationId !== conversation.id) { render(); return; }
  const messages = (conversation.messages || []).filter((message) => message?.role === "assistant" && messageIds.includes(message.id) && message.status === "running");
  // Events for a background conversation have no visible surface to update.
  if (messages.length === 0) return;
  const cards = messages.map((message) => ({
    message,
    card: document.querySelector(`[data-assistant-message="${CSS.escape(message.id)}"]`),
  }));
  // A new conversation/card or an intervening structural render needs the
  // normal path once; afterwards each event replaces only its own live card.
  if (cards.some(({ card }) => card === null)) { render(); return; }
  const conversationScroll = $("conversation-scroll");
  const followConversation = isNearBottom(conversationScroll);
  const previousConversationTop = conversationScroll.scrollTop;
  for (const { message, card } of cards) {
    const previousOutput = card.querySelector(".live-output-text");
    const followOutput = previousOutput === null || isNearBottom(previousOutput);
    const previousOutputTop = previousOutput?.scrollTop ?? 0;
    card.outerHTML = renderMessage(message);
    const replacement = document.querySelector(`[data-assistant-message="${CSS.escape(message.id)}"]`);
    if (replacement === null) { render(); return; }
    bindAssistantCard(replacement, conversation, conversation.messages || []);
    const output = replacement.querySelector(".live-output-text");
    if (output) output.scrollTop = nextScrollTop(output, followOutput, previousOutputTop);
  }
  conversationScroll.scrollTop = nextScrollTop(conversationScroll, followConversation, previousConversationTop);
}

function render() {
  runState.pendingLiveAssistantIds.clear();
  const conversation = activeConversation(); if (!conversation) return;
  applyArtifactPanelWidth();
  $("workspace")?.classList.toggle("artifact-open", artifactPanelOpen && inlineArtifactPreview !== undefined);
  const conversationScroll = $("conversation-scroll");
  const followConversation = renderedConversationId !== conversation.id || isNearBottom(conversationScroll);
  const previousReasoning = document.querySelector(".reasoning-body");
  const followReasoning = previousReasoning === null || isNearBottom(previousReasoning);
  const previousReasoningTop = previousReasoning?.scrollTop ?? 0;
  // Live output is deliberately capped inside its reply card. Snapshot each
  // card separately before replacing the DOM so a running answer follows new
  // output, while a reader who scrolled up to inspect earlier text stays put.
  const previousLiveOutputs = new Map([...document.querySelectorAll(".msg.assistant.live .live-output-text")]
    .flatMap((output) => {
      const messageId = output.closest("[data-assistant-message]")?.dataset.assistantMessage;
      return messageId === undefined ? [] : [[messageId, {
        follow: isNearBottom(output),
        scrollTop: output.scrollTop,
      }]];
    }));
  conversationState.activeId = conversation.id; $("conversation-title").textContent = conversation.title; $("conversation-id").textContent = `conversation: ${conversation.id}`;
  const orderedSessions = sortSessions(conversationState.sessions);
  const visibleSessions = orderedSessions.slice(0, conversationState.visibleLimit);
  const canLoadMoreConversations = conversationState.hasMore || orderedSessions.length > visibleSessions.length;
  $("sessions").innerHTML = visibleSessions.map((item) => `<div class="session-wrap"><button type="button" class="session ${item.id === conversationState.activeId ? "active" : ""}" data-session="${item.id}"><span class="session-dot"></span><span class="session-body"><span class="session-title">${escapeHtml(item.title)}</span><span class="session-time">${conversationTurnLabel(item)}</span></span></button><button type="button" class="session-delete" data-delete-session="${item.id}" aria-label="删除会话">×</button></div>`).join("") + (canLoadMoreConversations ? `<button id="load-more-conversations" class="sessions-more" type="button" ${conversationState.loadingMore ? "disabled" : ""}>${conversationState.loadingMore ? "加载中…" : "加载更多对话"}</button>` : "");
  document.querySelectorAll("[data-session]").forEach((button) => button.addEventListener("click", () => void selectConversation(button.dataset.session)));
  $("load-more-conversations")?.addEventListener("click", () => {
    if (conversationState.hasMore) void loadConversationPage(false);
    else { conversationState.visibleLimit += CONVERSATION_PAGE_SIZE; render(); }
  });
  document.querySelectorAll("[data-delete-session]").forEach((button) => {
    button.disabled = runState.deletingConversationIds.has(button.dataset.deleteSession);
    button.addEventListener("click", () => void deleteConversation(button.dataset.deleteSession));
  });
  const messages = conversation.messages || []; $("empty-state").hidden = messages.length > 0; $("messages").innerHTML = messages.map(renderMessage).join("");
  renderHumanLoopSurfaces(messages);
  document.querySelectorAll("[data-assistant-message]").forEach((card) => bindAssistantCard(card, conversation, messages));
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
  document.querySelectorAll("[data-human-loop-form-field]").forEach((field) => field.addEventListener("input", () => rememberHumanLoopFormValue(field.dataset.humanLoopMessage, field.dataset.humanLoopRequest, field.dataset.humanLoopFormField, field.value)));
  document.querySelectorAll("[data-human-loop-confirm]").forEach((input) => input.addEventListener("change", () => {
    if (input.checked) rememberHumanLoopConfirmation(input.dataset.humanLoopMessage, input.dataset.humanLoopRequest, input.value);
  }));
  document.querySelectorAll("[data-checkpoint-start]").forEach((button) => button.addEventListener("click", () => void startFromCheckpoint(button.dataset.checkpointStart)));
  const selectedAssistant = selectedAssistantMessage(conversation, messages);
  const activeRun = runState.activeByConversation.get(conversation.id);
  const cancelTarget = cancellationTarget(activeRun, messages);
  const localTargetUnavailable = isLocalExecution() && selectedLocalRuntime()?.status !== "ready";
  const cancellingKey = cancelTarget.localRunId ? `strict:${cancelTarget.activeRun?.localRuntimeId ?? cancelTarget.assistant?.localRuntimeId}:${cancelTarget.localRunId}` : cancelTarget.assignmentId;
  const primaryAction = $("submit");
  const stopping = cancelTarget.canCancel;
  primaryAction.disabled = stopping
    ? cancellingKey !== undefined && runState.cancellingAssignmentIds.has(cancellingKey)
    : activeRun !== undefined || uploadCount(conversation.id) > 0 || localTargetUnavailable;
  primaryAction.classList.toggle("is-stop", stopping);
  primaryAction.textContent = stopping ? "■" : "↑";
  primaryAction.setAttribute("aria-label", stopping ? "停止当前任务" : "发送任务");
  primaryAction.title = stopping ? "停止当前任务" : "发送任务";
  $("upload-file").disabled = (isLocalExecution() && selectedLocalRuntime()?.status !== "ready") || activeRun !== undefined || uploadCount(conversation.id) > 0 || pendingAttachments(conversation).length >= MAX_PENDING_ATTACHMENTS;
  renderPendingAttachments(conversation);
  // The artifact pane has its own selection: while a new turn is running the
  // user can still preview a product from any earlier assistant reply. Do not
  // let the conversation's current (usually latest) selection hide that pane.
  renderArtifacts();
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
  document.querySelectorAll(".msg.assistant.live .live-output-text").forEach((output) => {
    const messageId = output.closest("[data-assistant-message]")?.dataset.assistantMessage;
    const previous = messageId === undefined ? undefined : previousLiveOutputs.get(messageId);
    output.scrollTop = nextScrollTop(output, previous?.follow ?? true, previous?.scrollTop ?? 0);
  });
  renderedConversationId = conversation.id;
}

function bindAssistantCard(card, conversation, messages) {
    const select = () => void selectAssistantTurn(conversation, card.dataset.assistantMessage);
    card.addEventListener("click", (event) => {
      if (event.target.closest("button, input, label, a")) return;
      // Selecting a reply fires click on mouse-up.  Rendering here would
      // replace the DOM and discard the selection before the user can copy it.
      if (hasSelectedTextWithin(window.getSelection(), card)) return;
      select();
    });
    card.addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && !event.target.closest("button, input, label, a")) { event.preventDefault(); select(); } });
  card.querySelectorAll("[data-plan-toggle]").forEach((button) => button.addEventListener("click", () => {
    const assistant = messages.find((message) => message.id === button.dataset.planToggle);
    if (!assistant) return;
    assistant.planOpen = assistant.planOpen !== true;
    render();
  }));
  card.querySelectorAll("[data-trace-toggle]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const assistant = messages.find((message) => message.id === button.dataset.traceToggle);
    if (!assistant) return;
    assistant.traceOpen = assistant.traceOpen !== true;
    render();
  }));
  card.querySelectorAll("[data-other-artifacts-toggle]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const assistant = messages.find((message) => message.id === button.dataset.otherArtifactsToggle);
    if (!assistant) return;
    assistant.otherArtifactsOpen = assistant.otherArtifactsOpen !== true;
    render();
  }));
}

async function deleteConversation(conversationId) {
  const conversation = conversationState.sessions.find((item) => item.id === conversationId);
  if (!conversation || runState.deletingConversationIds.has(conversationId)) return;
  if (runState.activeByConversation.has(conversationId) || (conversation.messages || []).some((message) => message.role === "assistant" && message.status === "running")) {
    setStatus("会话仍有运行中的任务，请先停止后再删除", "error");
    return;
  }
  const hasRouterConversation = Number(conversation.runCount || 0) > 0 || (conversation.messages || []).some((message) => typeof message.assignmentId === "string");
  const strictLocalRuntimeIds = [...new Set((conversation.messages || [])
    .filter((message) => typeof message.localRunId === "string" && typeof message.assignmentId !== "string" && typeof message.localRuntimeId === "string")
    .map((message) => message.localRuntimeId))];
  runState.deletingConversationIds.add(conversationId);
  render();
  try {
    const deletions = [];
    if (hasRouterConversation) {
      deletions.push(fetch(`${api}/v1/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE", headers: { "x-tenant-id": $("tenant-id").value.trim(), "x-user-id": $("user-id").value.trim() } })
        .then(async (response) => { if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `HTTP ${response.status}`); } }));
    }
    for (const runtimeId of strictLocalRuntimeIds) {
      deletions.push(localAgentFetch(`/v1/local-runtimes/${encodeURIComponent(runtimeId)}/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" })
        .then(async (response) => { if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `Local Agent HTTP ${response.status}`); } }));
    }
    await Promise.all(deletions);
    conversationState.sessions = conversationState.sessions.filter((item) => item.id !== conversationId);
    if (conversationState.activeId === conversationId) conversationState.activeId = conversationState.sessions[0]?.id ?? newConversation().id;
    saveSessions();
    setStatus("会话已删除", "ok");
  } catch (error) {
    setStatus(`删除会话失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    runState.deletingConversationIds.delete(conversationId);
    render();
  }
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
  if (!assistant.assignmentId || runState.hydratedDetailAssignmentIds.has(assistant.assignmentId)) return;
  assistant.detailsLoading = true;
  render();
  try {
    await hydratePersistedAssistant(assistant, $("tenant-id").value.trim(), $("user-id").value.trim(), true);
    runState.hydratedDetailAssignmentIds.add(assistant.assignmentId);
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
  const provenance = renderExecutionProvenance(message);
  const reasoning = isLive && message.reasoning ? `<details class="live-reasoning" open><summary>模型思考</summary><div class="reasoning-body">${formatText(message.reasoning)}</div></details>` : "";
  const humanLoop = renderHumanLoop(message);
  const recovery = renderRecovery(message);
  const interimOutput = message.text ? (message.status === "completed" ? renderMarkdown(message.text) : formatText(message.text)) : "";
  // A pending Human-in-the-Loop request is the current actionable state. Keep
  // any useful interim model text, but never let it displace the response
  // controls the user needs in order to continue the Run.
  const projectedOutput = `${interimOutput}${humanLoop}${recovery}`;
  const artifactSummary = message.status === "completed" ? completedArtifactSummary(message.artifacts) : "";
  const emptyOutput = isLive ? `<span class="thinking"><i></i><i></i><i></i></span>` : `<span class="terminal-empty">${escapeHtml(artifactSummary || presentation.emptyText)}</span>`;
  const output = message.status === "failed"
    ? `<div class="failure-title">${formatText(message.error || presentation.emptyText)}</div>${message.partialText ? `<div class="partial-result"><strong>执行总结</strong>${renderMarkdown(message.partialText)}</div>` : ""}${recovery}`
    : projectedOutput || emptyOutput;
  const stateLabel = message.humanLoop?.status === "open" ? "等待你的输入" : message.recovery?.status === "required" || message.recovery?.status === "advancing" ? "正在恢复" : presentation.label;
  const stateIcon = presentation.icon;
  const completedAt = formatMessageTime(message.completedAt);
  const duration = formatConversationDuration(message.createdAt, message.completedAt);
  const liveEventIndicator = renderLiveEventIndicator(message);
  const responseTiming = renderMessageFooter(message, completedAt ? `回答结束于 ${completedAt}${duration ? ` · 耗时 ${duration}` : ""}` : "", "回答", liveEventIndicator);
  const hasPlan = plan.length;
  const planPanelId = `plan-${message.id}`;
  const stepToggle = hasPlan ? `<button type="button" class="live-step-toggle" data-plan-toggle="${message.id}" aria-expanded="${message.planOpen === true}" aria-controls="${planPanelId}">步骤 ${plan.filter((step) => step.status === "completed").length}/${plan.length}<span class="live-step-caret" aria-hidden="true">⌄</span></button>` : "";
  const planPanel = hasPlan && message.planOpen === true ? `<ol class="inline-plan-steps" id="${planPanelId}">${plan.map((step, index) => `<li><span class="step-dot ${step.status === "completed" ? "done" : step.status === "running" ? "running" : step.status === "failed" ? "error" : "pending"}"></span><span><b>${String(index + 1).padStart(2, "0")} ${escapeHtml(step.objective || step.id || "未命名步骤")}</b><small>${planStepLabel(step.status)}</small></span></li>`).join("")}</ol>` : "";
  const executionTrace = renderExecutionTrace(message);
  const inlineArtifacts = renderInlineArtifacts(message);
  return `<article class="msg assistant ${isLive ? "live" : "final"} ${isSelected ? "selected" : ""}" data-assistant-message="${escapeHtml(message.id)}" role="button" tabindex="0" aria-label="查看该轮执行详情" aria-pressed="${isSelected}"><div class="msg-avatar">A</div><div class="msg-body"><div class="live-card ${presentation.cardClass}"><div class="live-head"><span class="assistant-state ${message.status}">${stateIcon || (isLive ? `<span class="thinking"><i></i><i></i><i></i></span>` : "")}</span><span>AgentLoop · ${stateLabel}</span>${provenance}${stepToggle}</div>${planPanel}${reasoning}<div class="live-output-text md">${output}</div>${executionTrace}${inlineArtifacts}${responseTiming}</div></div></article>`;
}

function renderExecutionProvenance(message) {
  return `<span class="execution-provenance" aria-label="本轮执行来源">${executionProvenanceParts(message).map((part) => `<span class="execution-provenance-chip ${escapeHtml(part.kind)}">${escapeHtml(part.label)}</span>`).join("")}</span>`;
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
  const skillStatus = (skill) => skill.status === "completed" ? "已加载" : skill.status === "bound" ? "已绑定" : "已选择";
  const skillBlock = skills.length ? `<div class="inline-skill-summary"><span>本轮 Skill 状态</span><div class="inline-skill-list">${skills.map((skill) => `<span class="inline-skill-chip">${escapeHtml(skill.name)} · ${skillStatus(skill)}</span>`).join("")}</div></div>` : "";
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
  const running = ["running", "waiting"].includes(message?.status);
  if (seq === undefined && !type && !running) return "";
  const terminal = !running;
  const eventNumber = seq === undefined ? "进行中" : `#${seq}`;
  const eventLabel = type ? eventTypeLabel(type) : "正在连接 Runtime";
  return `<span class="live-event-indicator ${running ? "active" : ""} ${terminal ? "terminal" : ""} ${escapeHtml(message?.status || "")}" data-event-seq="${escapeHtml(seq ?? "pending")}" title="${running ? "当前运行进度" : "最新运行事件"}" ${running ? 'role="status" aria-live="polite"' : ""}><i class="live-event-pulse" aria-hidden="true"></i><span class="live-event-number">${escapeHtml(eventNumber)}</span><small>${escapeHtml(eventLabel)}</small></span>`;
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

function renderMessageFooter(message, timing, kind, eventFeedback = "") {
  const label = `复制${kind}`;
  return `<div class="message-footer${eventFeedback ? " event-feedback" : ""}">${eventFeedback}${timing ? `<div class="message-timing">${timing}</div>` : ""}<button type="button" class="message-copy" data-copy-message="${escapeHtml(message.id)}" aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg></button></div>`;
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
  if (request?.status === "open") return `<section class="human-loop-inline-notice"><b>正在等待你的决策</b><span>${escapeHtml(request.title)}</span></section>`;
  return renderResolvedHumanLoops(message);
}

function renderResolvedHumanLoops(message) {
  const history = Array.isArray(message.humanLoopHistory) ? message.humanLoopHistory : [];
  if (!history.length) return "";
  return `<section class="human-loop-history" aria-label="已回答的人工决策">${history.map((entry) => `<details><summary>已回答：${escapeHtml(entry.request?.title || "人工决策")}</summary><p>${escapeHtml(entry.request?.prompt || "")}</p><div><b>你的回答</b><span>${escapeHtml(humanLoopResponseText(entry.value))}</span></div></details>`).join("")}</section>`;
}

function humanLoopResponseText(value) {
  if (value === true) return "已确认";
  if (Array.isArray(value)) return value.length ? value.join("、") : "未选择";
  if (value && typeof value === "object") return Object.entries(value).map(([key, entry]) => `${key}: ${String(entry)}`).join("；");
  return String(value ?? "");
}

function renderHumanLoopCard(message) {
  const request = message.humanLoop;
  if (!request || request.status !== "open") return "";
  const schema = request.responseSchema || {};
  const key = `${message.id}-${request.id}`;
  let fields = "";
  if (schema.type === "select") {
    const selections = humanLoopSelections(message, request.id);
    fields = `<div class="human-loop-options">${(schema.options || []).map((option) => `<label class="human-loop-option"><input type="${schema.maxSelections === 1 ? "radio" : "checkbox"}" name="human-${key}" value="${escapeHtml(option.id)}" data-human-loop-option data-human-loop-message="${escapeHtml(message.id)}" data-human-loop-request="${escapeHtml(request.id)}" data-human-loop-max-selections="${escapeHtml(String(schema.maxSelections || 0))}" ${selections.has(option.id) ? "checked" : ""}/><span><b>${escapeHtml(option.label)}</b>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</span></label>`).join("")}</div>`;
  }
  else if (schema.type === "form") fields = `<div class="human-loop-form">${(schema.fields || []).map((field) => {
    const value = humanLoopFormValue(message, request.id, field.id);
    return `<label>${escapeHtml(field.label)}${field.required ? " *" : ""}${field.valueType === "textarea" ? `<textarea data-human-field="${escapeHtml(field.id)}" data-human-loop-form-field="${escapeHtml(field.id)}" data-human-loop-message="${escapeHtml(message.id)}" data-human-loop-request="${escapeHtml(request.id)}" ${field.required ? "required" : ""}>${escapeHtml(value)}</textarea>` : `<input data-human-field="${escapeHtml(field.id)}" data-human-loop-form-field="${escapeHtml(field.id)}" data-human-loop-message="${escapeHtml(message.id)}" data-human-loop-request="${escapeHtml(request.id)}" type="${field.valueType === "date" ? "date" : field.valueType === "number" ? "number" : "text"}" value="${escapeHtml(value)}" ${field.required ? "required" : ""}/>`}${field.description ? `<small>${escapeHtml(field.description)}</small>` : ""}</label>`;
  }).join("")}</div>`;
  else {
    const confirmation = humanLoopConfirmation(message, request.id);
    fields = `<div class="human-loop-confirm"><label><input type="radio" name="human-${key}" value="accept" data-human-loop-confirm data-human-loop-message="${escapeHtml(message.id)}" data-human-loop-request="${escapeHtml(request.id)}" ${confirmation !== "reject" ? "checked" : ""}/>${escapeHtml(schema.acceptLabel || "确认")}</label><label><input type="radio" name="human-${key}" value="reject" data-human-loop-confirm data-human-loop-message="${escapeHtml(message.id)}" data-human-loop-request="${escapeHtml(request.id)}" ${confirmation === "reject" ? "checked" : ""}/>${escapeHtml(schema.rejectLabel || "拒绝")}</label></div>`;
  }
  const selectionHint = schema.type === "select" ? `<span class="human-loop-selection-hint">${schema.minSelections === schema.maxSelections ? `请选择 ${schema.maxSelections} 项` : `请选择 ${schema.minSelections}–${schema.maxSelections} 项`}</span>` : "";
  return `<section class="human-loop-card" data-human-loop="${escapeHtml(request.id)}" data-human-kind="${escapeHtml(schema.type || "")}" data-human-revision="${request.revision}"><div class="human-loop-card-copy"><p>${escapeHtml(request.prompt)}</p>${selectionHint}</div>${fields}<small class="human-loop-error" aria-live="polite"></small></section>`;
}

function currentHumanLoopMessage(messages) {
  return [...messages].reverse().find((message) => message?.role === "assistant" && message.humanLoop?.status === "open");
}

function renderHumanLoopSurfaces(messages) {
  const message = currentHumanLoopMessage(messages);
  const panel = $("human-loop-panel");
  if (!message) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const request = message.humanLoop;
  panel.hidden = false;
  panel.innerHTML = `<header class="human-loop-panel-head"><div><span class="human-loop-panel-kicker">需要你的决策</span><strong>${escapeHtml(request.title)}</strong></div><span class="human-loop-panel-badge">等待你的输入</span></header><div class="human-loop-panel-body">${renderHumanLoopCard(message)}</div><footer class="human-loop-panel-actions"><span>提交后，AgentLoop 会继续执行</span><button type="button" class="human-loop-submit" data-human-loop-submit="${escapeHtml(message.id)}">确认并继续</button></footer>`;
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

function humanLoopFormValue(message, requestId, fieldId) {
  const value = message?.humanLoopFormDrafts?.[requestId]?.[fieldId];
  return typeof value === "string" ? value : "";
}

function rememberHumanLoopFormValue(messageId, requestId, fieldId, value) {
  const assistant = (activeConversation()?.messages || []).find((message) => message.id === messageId && message.role === "assistant");
  if (!assistant || assistant.humanLoop?.id !== requestId || !fieldId) return;
  assistant.humanLoopFormDrafts = { ...(assistant.humanLoopFormDrafts || {}), [requestId]: { ...(assistant.humanLoopFormDrafts?.[requestId] || {}), [fieldId]: value } };
  saveSessions();
}

function humanLoopConfirmation(message, requestId) {
  return message?.humanLoopConfirmationDrafts?.[requestId] === "reject" ? "reject" : "accept";
}

function rememberHumanLoopConfirmation(messageId, requestId, value) {
  const assistant = (activeConversation()?.messages || []).find((message) => message.id === messageId && message.role === "assistant");
  if (!assistant || assistant.humanLoop?.id !== requestId || (value !== "accept" && value !== "reject")) return;
  assistant.humanLoopConfirmationDrafts = { ...(assistant.humanLoopConfirmationDrafts || {}), [requestId]: value };
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
  if (!conversation || !assistant?.assignmentId || assistant.checkpoint?.status === "starting" || runState.activeByConversation.has(conversation.id)) return;
  const tenantId = $("tenant-id").value.trim();
  const userId = $("user-id").value.trim();
  const activeRun = { assignmentId: null, abortController: null, submitAbortController: null, submitTimedOut: false, submitTimeout: null, assistant };
  runState.activeByConversation.set(conversation.id, activeRun);
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
    if (runState.activeByConversation.get(conversation.id) === activeRun) runState.activeByConversation.delete(conversation.id);
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
    assistant.humanLoopHistory = [...(Array.isArray(assistant.humanLoopHistory) ? assistant.humanLoopHistory : []), { request, value, respondedAt: Date.now() }];
    assistant.humanLoop = undefined;
    if (assistant.humanLoopDrafts) delete assistant.humanLoopDrafts[request.id];
    if (assistant.humanLoopFormDrafts) delete assistant.humanLoopFormDrafts[request.id];
    if (assistant.humanLoopConfirmationDrafts) delete assistant.humanLoopConfirmationDrafts[request.id];
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
function renderArtifacts() {
  const conversation = activeConversation();
  const messages = conversation?.messages || [];
  const selectedAssistant = selectedAssistantMessage(conversation, messages);
  const previewAssistant = inlineArtifactPreview
    ? messages.find((message) => message.role === "assistant" && message.id === inlineArtifactPreview.assistantId)
    : undefined;
  const assistant = previewAssistant || selectedAssistant;
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
    updateArtifactPreviewMarkup(previewHost, "");
    emptyHost.hidden = true;
    return;
  }
  previewHost.hidden = false;
  const previewMarkup = inlineArtifactPreview.loading
    ? `<div class="artifact-inline-loading">正在生成预览…</div>`
    : (inlineArtifactPreview.html || `<div class="artifact-inline-loading">暂无预览内容</div>`);
  updateArtifactPreviewMarkup(previewHost, previewMarkup);
  emptyHost.hidden = true;
}

async function openSelectedArtifactFullscreen() {
  const conversation = activeConversation();
  const assistant = (conversation?.messages || []).find((message) => message.role === "assistant" && message.id === inlineArtifactPreview?.assistantId)
    || selectedAssistantMessage(conversation);
  const artifactId = inlineArtifactPreview?.artifactId;
  const artifact = (assistant?.artifacts || []).find((item) => item.id === artifactId);
  if ((!assistant?.assignmentId && !assistant?.localRunId) || !artifact) return;
  const { endpoint, headers } = artifactTransport(assistant, artifact);
  openArtifactPreview({
    artifact,
    fetchBytes: () => fetchBytes(endpoint, headers).then((response) => response.blob()),
    fetchStructuredPreview: () => fetchStructuredPreview(endpoint, headers),
  });
}

async function downloadArtifact(artifactId, assistantId) {
  const assistant = (activeConversation()?.messages || []).find((message) => message.role === "assistant" && message.id === assistantId) || selectedAssistantMessage(activeConversation());
  if (!assistant?.assignmentId && !assistant?.localRunId) return;
  const artifact = (assistant.artifacts || []).find((item) => item.id === artifactId);
  if (!artifact) return;
  const transport = artifactTransport(assistant, artifact);
  const response = await agentAwareFetch(transport.endpoint(), { headers: transport.headers() });
  if (!response.ok) return;
  const blob = await response.blob(); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = response.headers.get("content-disposition")?.split("filename*=UTF-8''")[1] ? decodeURIComponent(response.headers.get("content-disposition").split("filename*=UTF-8''")[1]) : "artifact"; link.click(); URL.revokeObjectURL(link.href);
}

async function previewArtifact(artifactId, assistantId) {
  const assistant = (activeConversation()?.messages || []).find((message) => message.role === "assistant" && message.id === assistantId) || selectedAssistantMessage(activeConversation());
  if (!assistant?.assignmentId && !assistant?.localRunId) return;
  const artifact = (assistant.artifacts || []).find((item) => item.id === artifactId);
  if (!artifact || artifact.previewable === false) return;
  const { endpoint, headers } = artifactTransport(assistant, artifact);
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

function artifactTransport(assistant, artifact) {
  // A Router-assigned local Runtime is reachable only through the Agent's
  // outbound WebSocket. Keep the browser on the authenticated Router route;
  // `strict_local` has no Assignment and is the sole loopback-only path.
  if (assistant.assignmentId) {
    return {
      endpoint: (suffix = "") => `${api}/v1/assignments/${encodeURIComponent(assistant.assignmentId)}/artifacts/${encodeURIComponent(artifact.id)}${suffix}`,
      headers: () => ({ "x-tenant-id": $("tenant-id").value.trim(), "x-user-id": $("user-id").value.trim() }),
    };
  }
  if (artifact.location === "local") {
    const runId = assistant.localRunId || assistant.remoteRunId;
    const runtimeId = assistant.localRuntimeId || assistant.runtimeId;
    if (!runId || !runtimeId) throw new Error("本机产物运行标识不可用");
    return {
      endpoint: (suffix = "") => `${localAgentApi}/v1/local-runtimes/${encodeURIComponent(runtimeId)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}${suffix}`,
      headers: () => localHeaders(),
    };
  }
  throw new Error("产物没有可访问的数据面");
}

async function fetchBytes(endpoint, headers) {
  const response = await agentAwareFetch(endpoint(), { headers: headers() });
  if (!response.ok) throw new Error(`无法读取产物（HTTP ${response.status}）`);
  return response;
}

async function fetchStructuredPreview(endpoint, headers) {
  const response = await agentAwareFetch(endpoint("/preview"), { headers: headers() });
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
  host.innerHTML = `<div class="preview-backdrop maximized command-detail-backdrop" role="dialog" aria-modal="true" aria-label="命令完整详情"><div class="preview-dialog maximized command-detail-dialog"><div class="preview-head"><div class="preview-title"><strong>命令详情</strong><span>${escapeHtml(command.id)}</span></div><button type="button" class="preview-close" data-command-detail-close aria-label="关闭命令详情">×</button></div><div class="preview-body command-detail-body"><section class="command-detail-section"><h4>完整命令</h4><pre class="command-full-output">${escapeHtml([command.arguments?.command || "?", ...(Array.isArray(command.arguments?.args) ? command.arguments.args : [])].join(" "))}</pre></section><section class="command-detail-section"><h4>调用参数</h4><pre class="command-full-output">${escapeHtml(argumentsText)}</pre></section><section class="command-detail-section"><h4>执行信息</h4><dl class="command-detail-meta-grid"><dt>状态</dt><dd>${escapeHtml(command.status)}</dd><dt>step</dt><dd>${escapeHtml(command.step ?? "-")}</dd><dt>duration</dt><dd>${formatDuration(command.durationMs) || "-"}</dd><dt>call</dt><dd>${escapeHtml(command.id)}</dd></dl></section>${outputBlock("stdout", command.stdout)}${outputBlock("stderr", command.stderr, true)}</div></div></div>`;
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
async function call(path, body, signal) {
  const response = await fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });
  const parsed = await response.json();
  if (!response.ok) throw Object.assign(new Error(parsed.error || `HTTP ${response.status}`), typeof parsed.code === "string" ? { code: parsed.code } : {});
  return parsed;
}
async function toBase64(file) { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
