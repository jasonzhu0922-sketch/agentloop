import { configurationForApply, mergeEnvLines, providerKeyNames, readEnvValue } from "./cloud-model-config.js";
import { mountRuntimeReload } from "./cloud-runtime-reload.js";

const $ = (id) => document.getElementById(id);
const jsonEditor = $("config-json");
const keyList = $("key-list");
const status = $("status");
let envLines = [];
let envLoaded = false;

if (globalThis.AGENTLOOP_RUNTIME_CONTROL_DEV_MODE) {
  $("operator-token").value = globalThis.AGENTLOOP_RUNTIME_CONTROL_DEV_TOKEN || "development-operator-token";
  $("apply-production-config").textContent = "保存并应用到开发沙盒";
  status.textContent = "开发态控制服务已启用：操作只写入本地沙盒，不会触及生产。";
}

$("config-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    jsonEditor.value = JSON.stringify(parsed, null, 2);
    status.textContent = `已读取 ${file.name}`;
    status.dataset.state = "";
    refreshKeys();
    validate();
  } catch { setError("模型配置不是有效 JSON"); }
});

$("env-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  envLines = (await file.text()).split(/\r?\n/);
  envLoaded = true;
  status.textContent = `已读取 ${file.name}`;
  status.dataset.state = "";
  refreshKeys();
  validate();
});

$("format-json").addEventListener("click", () => {
  try { jsonEditor.value = JSON.stringify(JSON.parse(jsonEditor.value), null, 2); setError(""); refreshKeys(); }
  catch { setError("模型配置不是有效 JSON"); }
});
$("add-key").addEventListener("click", () => addKeyRow("", ""));
jsonEditor.addEventListener("input", () => { refreshKeys(); validate(); });
keyList.addEventListener("input", validate);
keyList.addEventListener("click", (event) => {
  if (event.target.closest(".remove-key")) { event.target.closest(".key-row").remove(); validate(); }
});
$("download-config").addEventListener("click", () => download("llm-providers.json", `${JSON.stringify(parseConfig(), null, 2)}\n`, "application/json"));
$("download-env").addEventListener("click", () => download("runtime.env", `${serializeEnv()}\n`, "text/plain"));

function parseConfig() {
  const config = JSON.parse(jsonEditor.value);
  providerKeyNames(config);
  return config;
}

function refreshKeys() {
  let config;
  try { config = parseConfig(); }
  catch { return; }
  const existing = new Map([...keyList.querySelectorAll(".key-row")].map((row) => [row.querySelector("[name=env]").value, row.querySelector("[name=key]").value]));
  keyList.replaceChildren();
  providerKeyNames(config).forEach((name) => {
    const priorInput = existing.get(name);
    const value = priorInput ?? readEnvValue(envLines, name);
    addKeyRow(name, value);
  });
  validate();
}

function addKeyRow(name, value) {
  const row = document.createElement("div");
  row.className = "key-row";
  const env = document.createElement("input");
  env.name = "env"; env.value = name; env.autocomplete = "off"; env.setAttribute("aria-label", "API Key 环境变量名");
  const key = document.createElement("input");
  key.name = "key"; key.type = "password"; key.value = value; key.autocomplete = "new-password"; key.placeholder = "留空保留服务器原 Key；填写则替换"; key.setAttribute("aria-label", `API Key ${name || "环境变量"}`);
  const remove = document.createElement("button");
  remove.type = "button"; remove.className = "remove-key"; remove.textContent = "×"; remove.title = "移除此变量"; remove.setAttribute("aria-label", "移除此变量");
  row.append(env, key, remove); keyList.append(row);
}

function serializeEnv() {
  const entries = [...keyList.querySelectorAll(".key-row")].map((row) => [row.querySelector("[name=env]").value, row.querySelector("[name=key]").value]);
  return mergeEnvLines(envLines, entries).join("\n");
}

function validate() {
  status.dataset.state = "";
  try {
    parseConfig();
    serializeEnv();
    $("download-config").disabled = false;
    $("download-env").disabled = !envLoaded;
    if (!status.dataset.state) status.textContent = envLoaded ? "配置有效，可导出两个文件" : "模型配置有效；导入 runtime.env 后可导出密钥文件";
  } catch (error) {
    $("download-config").disabled = true;
    $("download-env").disabled = true;
    if (jsonEditor.value.trim()) setError(error.message);
  }
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function setError(message) { status.textContent = message; status.dataset.state = message ? "error" : ""; }

mountRuntimeReload({ document, fetch: globalThis.fetch.bind(globalThis), confirm: globalThis.confirm.bind(globalThis), setTimeout, clearTimeout,
  configurationInput: () => configurationForApply(jsonEditor.value, envLoaded ? envLines : undefined,
    [...keyList.querySelectorAll(".key-row")].map((row) => [row.querySelector("[name=env]").value, row.querySelector("[name=key]").value])),
  onConfiguration: (configuration) => {
    jsonEditor.value = JSON.stringify(configuration, null, 2);
    envLines = []; envLoaded = false; keyList.replaceChildren();
    $("env-file").value = "";
    refreshKeys(); validate();
  },
});
