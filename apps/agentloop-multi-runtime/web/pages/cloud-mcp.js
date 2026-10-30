const $ = (id) => document.getElementById(id);
const token = $("operator-token");
const editor = $("config-json");
const status = $("status");
const downloadButton = $("download-config");
let busy = false;

const example = {
  defaultTrust: "untrusted",
  servers: [{
    key: "amap-maps", transport: "http", url: "https://mcp.example.com/mcp",
    auth: { kind: "query", name: "key", secretEnv: "AMAP_MCP_KEY" },
    trust: "trusted", timeoutMs: 15000, aliases: ["地图"],
  }],
};

if (globalThis.AGENTLOOP_RUNTIME_CONTROL_DEV_MODE) {
  token.value = globalThis.AGENTLOOP_RUNTIME_CONTROL_DEV_TOKEN || "development-operator-token";
  $("apply-config").textContent = "保存到开发沙盒";
  setStatus("开发态控制服务已启用：操作只写入本地云端配置沙盒。", false);
  editor.value = `${JSON.stringify(example, null, 2)}\n`;
  validate();
}

$("format-json").addEventListener("click", () => {
  try { editor.value = `${JSON.stringify(parse(), null, 2)}\n`; validate(); }
  catch (error) { setStatus(error.message, true); }
});
editor.addEventListener("input", validate);
$("load-production-config").addEventListener("click", () => { void loadConfiguration(); });
$("apply-config").addEventListener("click", () => { void applyConfiguration(); });
downloadButton.addEventListener("click", () => {
  const config = parse();
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "mcp-servers.json"; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function parse() {
  let value;
  try { value = JSON.parse(editor.value); } catch { throw new Error("MCP 配置不是有效 JSON。"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.servers)) throw new Error("配置必须是包含 servers 数组的 JSON 对象。");
  if (value.defaultTrust !== undefined && !["trusted", "untrusted"].includes(value.defaultTrust)) throw new Error("defaultTrust 只能是 trusted 或 untrusted。");
  const keys = new Set();
  const normalizedKeys = new Set();
  value.servers.forEach((server, index) => {
    const label = `servers[${index}]`;
    if (!server || typeof server !== "object" || typeof server.key !== "string" || !server.key.trim()) throw new Error(`${label}.key 必须是非空字符串。`);
    if (keys.has(server.key)) throw new Error(`Server key 重复：${server.key}`); keys.add(server.key);
    const normalizedKey = server.key.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
    if (normalizedKeys.has(normalizedKey)) throw new Error(`Server key 规范化后重复：${server.key}`); normalizedKeys.add(normalizedKey);
    if (server.transport !== "http") throw new Error(`${label}.transport 必须是 http。`);
    let url; try { url = new URL(server.url); } catch { throw new Error(`${label}.url 不是有效 URL。`); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`${label}.url 必须是无凭据的 HTTP(S) URL。`);
    if (server.auth !== undefined && (!server.auth || typeof server.auth !== "object" || !["none", "bearer", "headers", "headers_env", "query", "api_key_header", "query_parameter", "custom_headers"].includes(server.auth.kind))) throw new Error(`${label}.auth.kind 无效。`);
  });
  return value;
}

function validate() {
  try { parse(); downloadButton.disabled = false; if (!status.dataset.state) setStatus("JSON 配置有效，可保存。", false); }
  catch (error) { downloadButton.disabled = true; if (editor.value.trim()) setStatus(error.message, true); }
}

async function loadConfiguration() {
  if (busy) return;
  if (!token.value.trim()) return setStatus("请输入运维凭证。", true);
  busy = true; $("load-production-config").disabled = true;
  try {
    const response = await fetch("/api/operations/mcp-configuration", { headers: { authorization: `Bearer ${token.value.trim()}` }, cache: "no-store", signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    if (!response.ok) throw new Error(messages[body.error] ?? "读取 MCP 配置失败。");
    editor.value = `${JSON.stringify(body.configuration, null, 2)}\n`; validate(); setStatus("已读取当前云端 MCP 配置。", false);
  } catch (error) { setStatus(error.message, true); }
  finally { busy = false; $("load-production-config").disabled = false; }
}

async function applyConfiguration() {
  if (busy) return;
  if (!token.value.trim()) return setStatus("请输入运维凭证。", true);
  let configuration; try { configuration = parse(); } catch (error) { return setStatus(error.message, true); }
  const count = configuration.servers.length;
  if (!globalThis.confirm(`确认保存 ${count} 个 MCP Server 配置？保存后由云端 Runtime 在下次加载时使用。`)) return;
  busy = true; $("apply-config").disabled = true; $("load-production-config").disabled = true;
  try {
    const response = await fetch("/api/operations/mcp-configuration", { method: "POST", headers: { authorization: `Bearer ${token.value.trim()}`, "content-type": "application/json" }, body: JSON.stringify({ configuration }), cache: "no-store", signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    if (!response.ok) throw new Error(messages[body.error] ?? "保存 MCP 配置失败。");
    setStatus(`${globalThis.AGENTLOOP_RUNTIME_CONTROL_DEV_MODE ? "已保存到开发沙盒" : "已保存并应用"}：${body.mcpServers?.length ?? count} 个 MCP Server。`, false);
  } catch (error) { setStatus(error.message, true); }
  finally { busy = false; $("apply-config").disabled = false; $("load-production-config").disabled = false; }
}

const messages = { operator_unauthorized: "运维凭证不正确。", runtime_control_not_configured: "尚未启用服务器 Runtime 控制服务。", runtime_control_unavailable: "无法连接服务器 Runtime 控制服务。", mcp_configuration_read_failed: "无法读取生产 MCP 配置，请稍后重试。", invalid_mcp_configuration: "MCP 配置无效，请检查 JSON 和 Server 字段。", invalid_mcp_configuration_request: "提交的 MCP 配置请求无效。", configuration_too_large: "配置超过 2 MB。" };
function setStatus(text, error) { status.textContent = text; status.dataset.state = error ? "error" : ""; }
