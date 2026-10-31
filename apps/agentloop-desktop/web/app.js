const $ = (selector) => document.querySelector(selector);
const state = { runtimes: [], selectedRuntimeId: "", run: undefined };

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "HTTP " + response.status);
  return body;
}

async function refresh() {
  const [config, auth, runtimeResult] = await Promise.all([
    api("/v1/desktop/config"),
    api("/v1/auth/status"),
    api("/v1/local-runtimes"),
  ]);
  state.runtimes = runtimeResult.runtimes || [];
  if (!state.selectedRuntimeId || !state.runtimes.some((item) => item.id === state.selectedRuntimeId)) {
    state.selectedRuntimeId = state.runtimes.find((item) => item.isDefault)?.id || state.runtimes[0]?.id || "";
  }
  $("#status").textContent = "Desktop 已启动 · Local Agent " + (config.localAgent.managed ? "由本机托管" : "外部连接") + (auth.authenticated ? " · 已有本地会话" : " · 等待云端登录");
  render();
}

function render() {
  $("#runtimes").innerHTML = state.runtimes.length === 0 ? "没有 Runtime" : state.runtimes.map((runtime) => {
    const actions = runtime.status === "ready"
      ? '<button class="secondary" data-action="stop" data-id="' + runtime.id + '">停止</button>'
      : '<button data-action="start" data-id="' + runtime.id + '">启动</button>';
    return '<div class="runtime"><div><div class="runtime-name">' + escapeHtml(runtime.displayName || runtime.id) + '</div><div class="muted">' + escapeHtml(runtime.status || "unknown") + (runtime.isDefault ? " · 默认" : "") + '</div></div><div class="row">' + actions + '<button class="secondary" data-action="restart" data-id="' + runtime.id + '">重启</button></div></div>';
  }).join("");
  $("#runtime").innerHTML = state.runtimes.map((runtime) => '<option value="' + runtime.id + '"' + (runtime.id === state.selectedRuntimeId ? " selected" : "") + '>' + escapeHtml(runtime.displayName || runtime.id) + '</option>').join("");
}

$("#refresh").addEventListener("click", () => refresh().catch(showError));
$("#runtime").addEventListener("change", (event) => { state.selectedRuntimeId = event.target.value; });
$("#create").addEventListener("click", async () => {
  const name = window.prompt("Runtime 名称", "本地 Runtime " + String(state.runtimes.length + 1));
  if (!name) return;
  await api("/v1/local-runtimes", { method: "POST", body: JSON.stringify({ displayName: name }) });
  await refresh();
});
$("#runtimes").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  await api("/v1/local-runtimes/" + encodeURIComponent(id) + "/" + button.dataset.action, { method: "POST", body: "{}" });
  await refresh();
});
$("#run").addEventListener("click", async () => {
  try {
    const runtimeId = $("#runtime").value;
    const input = $("#input").value.trim();
    if (!runtimeId || !input) throw new Error("请选择 Runtime 并输入任务");
    const result = await api("/v1/strict-local-runs", {
      method: "POST",
      body: JSON.stringify({
        runtimeId,
        conversationId: "desktop-default",
        clientMessageId: crypto.randomUUID(),
        input,
        requestedModelKey: $("#model").value.trim(),
        localDirectoryScopeIds: [],
        localUploadedSourceIds: [],
        allowDangerousTools: true
      })
    });
    state.run = result.run;
    $("#log").textContent = JSON.stringify(result, null, 2);
    await pollRun(runtimeId, state.run.remoteRunId);
  } catch (error) { showError(error); }
});
async function pollRun(runtimeId, runId) {
  for (let index = 0; index < 120; index += 1) {
    const result = await api("/v1/strict-local-runs/" + encodeURIComponent(runtimeId) + "/" + encodeURIComponent(runId));
    $("#log").textContent = JSON.stringify(result, null, 2);
    if (result.run?.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
function showError(error) { $("#log").textContent = "错误: " + (error?.message || String(error)); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character])); }
refresh().catch(showError);
