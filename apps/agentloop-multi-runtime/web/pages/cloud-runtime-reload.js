const messages = {
  operator_unauthorized: "运维凭证不正确。",
  runtime_control_not_configured: "尚未启用服务器 Runtime 控制服务，请先完成部署配置。",
  runtime_control_unavailable: "无法连接服务器 Runtime 控制服务。",
  active_runs: "仍有未结束任务，未重新加载。请等待任务结束后再试。",
  invalid_configuration: "服务器模型配置无效或缺少 Key，未重新加载。请检查已上传文件。",
  operation_locked: "服务器正在执行其他部署操作，请稍后再试。",
  readiness_failed: "Runtime 未全部就绪，请检查服务器容器状态和日志。",
  reload_interrupted: "控制服务在操作期间中断，结果未确认。请先检查服务器 Runtime 状态。",
  reload_failed: "重新加载失败，请检查服务器配置和 Runtime 状态。",
};

// Injectable browser dependencies allow the actual request/polling workflow to
// be exercised without a production Docker host.
export function mountRuntimeReload({ document, fetch, confirm, setTimeout, clearTimeout }) {
  const form = document.getElementById("reload-form");
  const token = document.getElementById("operator-token");
  const button = document.getElementById("reload-runtime");
  const refresh = document.getElementById("reload-status-refresh");
  const status = document.getElementById("reload-status");
  let timer;
  let busy = false;
  let operationId;

  function show(text, error = false) {
    status.textContent = text;
    status.dataset.state = error ? "error" : "";
  }
  function schedule() { timer = setTimeout(() => { void request("GET"); }, 2000); }
  async function request(method) {
    if (busy) return;
    if (!token.value.trim()) { show("请输入运维凭证。", true); return; }
    clearTimeout(timer);
    busy = true;
    button.disabled = true;
    refresh.disabled = true;
    let running = false;
    let uncertain = true;
    try {
      const response = await fetch("/api/operations/runtime-reload", {
        method, headers: { authorization: `Bearer ${token.value.trim()}` }, cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      const state = await response.json();
      uncertain = false;
      if (!response.ok && !(response.status === 409 && state.status === "running")) {
        throw new Error(messages[state.error] ?? "读取操作结果失败，请查看状态后再试。");
      }
      if (operationId && method === "GET" && state.id !== operationId) {
        throw new Error("服务器操作记录已变化，请点击查看状态确认最新结果。");
      }
      operationId = state.id;
      running = state.status === "running";
      if (running) {
        show(state.phase === "checking_readiness" ? "正在逐个检查 Runtime 就绪…" : "正在校验配置并重新加载 Runtime…");
        schedule();
      } else if (state.status === "succeeded") {
        const at = state.finishedAt ? `（${new Date(state.finishedAt * 1000).toLocaleString()}）` : "";
        show(`重新加载完成${at}：所有云端 Runtime 已就绪，有效模型配置检查通过。刷新工作区后选择模型发起新任务验证。`);
      } else if (state.status === "failed") {
        show(messages[state.phase] ?? messages.reload_failed, true);
      } else { show("当前没有重新加载记录。"); }
    } catch (error) {
      show(`${error.message}${uncertain ? " 操作可能仍在服务器执行，可点击查看状态确认。" : ""}`, true);
    } finally {
      busy = false;
      button.disabled = running;
      refresh.disabled = false;
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!token.value.trim()) { show("请输入运维凭证。", true); return; }
    if (!confirm("确认已将配置上传到服务器、暂停新任务并等待已有任务结束？将重新加载全部云端 Runtime。")) return;
    operationId = undefined;
    void request("POST");
  });
  refresh.addEventListener("click", () => { operationId = undefined; void request("GET"); });
  // Credentials stay only in this input; no cookies, URL parameters or storage.
}

if (typeof document !== "undefined") mountRuntimeReload({ document, fetch: globalThis.fetch.bind(globalThis),
  confirm: globalThis.confirm.bind(globalThis), setTimeout, clearTimeout });
