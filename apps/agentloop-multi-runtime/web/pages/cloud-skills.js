const $ = (id) => document.getElementById(id);
const token = $("operator-token");
const fileInput = $("skill-file");
const list = $("skill-list");
const status = $("status");
const operationStatus = $("reload-status");
const apply = $("apply-skills");
let selectedFile;
let timer;
let busy = false;

if (globalThis.AGENTLOOP_RUNTIME_CONTROL_DEV_MODE) {
  token.value = globalThis.AGENTLOOP_RUNTIME_CONTROL_DEV_TOKEN || "development-operator-token";
  apply.textContent = "上传并应用到开发沙盒";
  document.querySelector(".policy span")?.replaceChildren("开发态上传会替换本项目的 custom-skills/ 目录，操作状态写入 data/local/cloud-skills，并模拟 Runtime 就绪检查，不会触及生产服务器。");
  setStatus("开发态控制服务已启用：当前管理项目 custom-skills/，不会触及生产。", false, status);
}

const messages = {
  operator_unauthorized: "运维凭证不正确。",
  runtime_control_not_configured: "尚未启用服务器 Runtime 控制服务。",
  runtime_control_unavailable: "无法连接服务器 Runtime 控制服务。",
  skill_package_too_large: "Skill ZIP 超过 90 MB。",
  invalid_skill_configuration_request: "Skill ZIP 请求格式无效。",
  active_runs: "仍有未结束任务，请等待任务结束后再试。",
  operation_locked: "服务器正在执行其他部署操作，请稍后再试。",
  readiness_failed: "Runtime 未全部就绪，请检查服务器容器状态和日志。",
  invalid_configuration: "Skill 包校验失败，请检查 ZIP 目录结构和 SKILL.md。",
  skill_not_found: "目标 Skill 不存在或已经被移除。",
  reload_failed: "Skill 发布失败，请检查服务器状态。",
};

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files?.[0];
  if (!selectedFile) { $("file-summary").textContent = "未选择文件。"; apply.disabled = true; return; }
  $("file-summary").textContent = `${selectedFile.name} · ${formatBytes(selectedFile.size)}`;
  apply.disabled = false;
  status.textContent = "已选择文件，发布前会在服务器端校验。";
  status.dataset.state = "";
});

$("load-skills").addEventListener("click", () => { void loadSkills(); });
$("refresh-status").addEventListener("click", () => { void poll(true); });
list.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-skill]");
  if (button) void removeSkill(button.dataset.removeSkill);
});
apply.addEventListener("click", () => { void applySkills(); });

async function loadSkills() {
  if (!token.value.trim()) return setStatus("请输入运维凭证。", true, status);
  const button = $("load-skills"); button.disabled = true;
  try {
    const response = await fetch("/api/operations/skill-configuration", { headers: { authorization: `Bearer ${token.value.trim()}` }, cache: "no-store", signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    if (!response.ok) throw new Error(messages[body.error] ?? "读取 Skill 配置失败。");
    renderSkills(body.skills);
    setStatus(`已读取 ${body.skills.length} 个云端 Skill。`, false, status);
  } catch (error) { setStatus(error.message, true, status); }
  finally { button.disabled = false; }
}

async function applySkills() {
  if (busy || !selectedFile) return;
  if (!token.value.trim()) return setStatus("请输入运维凭证。", true, status);
  const target = globalThis.AGENTLOOP_RUNTIME_CONTROL_DEV_MODE ? "开发沙盒" : "服务器上的自定义 Skill 目录并重建全部云端 Runtime";
  if (!globalThis.confirm(`确认已暂停新任务并等待已有任务结束？上传后会替换${target}。`)) return;
  busy = true; apply.disabled = true; $("load-skills").disabled = true;
  try {
    const bytes = new Uint8Array(await selectedFile.arrayBuffer());
    const response = await fetch("/api/operations/skill-configuration", {
      method: "POST", headers: { authorization: `Bearer ${token.value.trim()}`, "content-type": "application/json" },
      body: JSON.stringify({ archiveName: selectedFile.name, archiveBase64: toBase64(bytes) }), cache: "no-store", signal: AbortSignal.timeout(30000),
    });
    const body = await response.json();
    if (!response.ok && !(response.status === 409 && body.status === "running")) throw new Error(messages[body.error] ?? "Skill 发布请求失败。");
    setOperationMessage(body);
    if (body.status === "running") { clearTimeout(timer); timer = setTimeout(() => { void poll(false); }, 2000); }
  } catch (error) { setStatus(error.message, true, status); setOperationStatus(`${error.message} 操作可能仍在服务器执行，可点击查看状态确认。`, true); }
  finally { busy = false; apply.disabled = !selectedFile; $("load-skills").disabled = false; }
}

async function removeSkill(name) {
  if (busy || !name) return;
  if (!token.value.trim()) return setStatus("请输入运维凭证。", true, status);
  const target = globalThis.AGENTLOOP_RUNTIME_CONTROL_DEV_MODE ? "开发沙盒" : "云端";
  if (!globalThis.confirm(`确认从${target} custom-skills 中移除「${name}」？操作会备份目录并重建全部云端 Runtime。`)) return;
  busy = true; apply.disabled = true; $("load-skills").disabled = true;
  try {
    const response = await fetch("/api/operations/skill-configuration", {
      method: "DELETE", headers: { authorization: `Bearer ${token.value.trim()}`, "content-type": "application/json" },
      body: JSON.stringify({ skillName: name }), cache: "no-store", signal: AbortSignal.timeout(30000),
    });
    const body = await response.json();
    if (!response.ok && !(response.status === 409 && body.status === "running")) throw new Error(messages[body.error] ?? "Skill 移除请求失败。");
    setOperationMessage(body);
    if (body.status === "running") { clearTimeout(timer); timer = setTimeout(() => { void poll(false); }, 2000); }
  } catch (error) { setStatus(error.message, true, status); setOperationStatus(`${error.message} 操作可能仍在服务器执行，可点击查看状态确认。`, true); }
  finally { busy = false; apply.disabled = !selectedFile; $("load-skills").disabled = false; }
}

async function poll(manual) {
  if (!token.value.trim()) return setOperationStatus("请输入运维凭证。", true);
  try {
    const response = await fetch("/api/operations/runtime-reload", { headers: { authorization: `Bearer ${token.value.trim()}` }, cache: "no-store", signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    if (!response.ok) throw new Error(messages[body.error] ?? "读取发布状态失败。");
    if (!["skills", "skills-remove"].includes(body.operation)) {
      if (manual) setOperationStatus("当前记录不是 Skill 发布操作，请先发起或等待 Skill 发布。", true);
      return;
    }
    setOperationMessage(body);
    if (body.status === "running") { clearTimeout(timer); timer = setTimeout(() => { void poll(false); }, 2000); }
    if (body.status === "succeeded") await loadSkills();
  } catch (error) { setOperationStatus(`${error.message}${manual ? "" : " 操作可能仍在服务器执行。"}`, true); }
}

function setOperationMessage(state) {
  if (state.status === "running") return setOperationStatus(state.phase === "checking_readiness" ? "正在逐个检查 Runtime 就绪…" : "正在校验 Skill 包并重建云端 Runtime…");
  if (state.status === "succeeded") return setOperationStatus(state.skillName
    ? `Skill「${state.skillName}」已移除：剩余 ${(state.skills ?? []).length} 个 Skill，Runtime 就绪检查通过。`
    : `Skill 发布完成：${(state.skills ?? []).length} 个 Skill 已通过目录和 Runtime 就绪检查。`);
  if (state.status === "failed") return setOperationStatus(messages[state.phase] ?? messages.reload_failed, true);
  setOperationStatus("当前没有 Skill 发布记录。");
}
function setStatus(text, error, element) { element.textContent = text; element.dataset.state = error ? "error" : ""; }
function setOperationStatus(text, error = false) { setStatus(text, error, operationStatus); }
function renderSkills(skills) {
  if (!Array.isArray(skills) || skills.length === 0) { list.innerHTML = '<p class="empty">当前没有部署维护的自定义 Skill；内核 Skill 仍会默认加载。</p>'; return; }
  list.innerHTML = skills.map((skill) => `<article class="skill-row"><div><strong>${escapeHtml(skill.name)}</strong><small>${escapeHtml(skill.description || "暂无描述")}${skill.hasEnvironment ? " · 已配置 Skill 环境文件" : ""}</small></div><div class="skill-meta">${skill.fileCount} 文件 · ${formatBytes(skill.totalBytes)}<br />${escapeHtml(skill.packageHash.slice(0, 16))}…</div><button class="danger remove-skill" type="button" data-remove-skill="${escapeHtml(skill.name)}">移除</button></article>`).join("");
}
function toBase64(bytes) { let result = ""; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) result += String.fromCharCode(...bytes.subarray(i, i + chunk)); return btoa(result); }
function formatBytes(value) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB`; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }

