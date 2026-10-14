export function parseMcpJsonImport(raw) {
  let document;
  try { document = JSON.parse(raw); }
  catch { throw new Error("MCP JSON 格式无效"); }
  const entries = serverEntries(document);
  if (entries.length === 0) throw new Error("MCP JSON 中没有 Server 配置");
  return entries.map(([key, value], index) => normalizeServer(key, value, index));
}

function serverEntries(document) {
  if (Array.isArray(document)) return document.map((value) => [undefined, value]);
  if (!record(document)) throw new Error("MCP JSON 必须是对象或数组");
  if (document.url !== undefined) return [[document.key, document]];
  const servers = document.mcpServers ?? document.servers;
  if (Array.isArray(servers)) return servers.map((value) => [undefined, value]);
  if (record(servers)) return Object.entries(servers);
  return [];
}

function normalizeServer(fallbackKey, value, index) {
  if (!record(value)) throw new Error(`第 ${index + 1} 个 MCP Server 配置无效`);
  if (value.command !== undefined || value.args !== undefined || value.transport === "stdio") {
    throw new Error("本地 Runtime 当前仅支持 HTTP MCP Server");
  }
  const key = text(value.key) ?? text(fallbackKey);
  const rawUrl = text(value.url);
  if (key === undefined || rawUrl === undefined) throw new Error(`第 ${index + 1} 个 MCP Server 缺少 key 或 url`);
  let endpoint;
  try { endpoint = new URL(rawUrl); }
  catch { throw new Error(`MCP Server ${key} 的 URL 无效`); }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error(`MCP Server ${key} 仅支持 HTTP URL`);

  const queryCredentials = [...endpoint.searchParams.entries()].filter(([name]) => /^(?:key|token|secret|password|api[-_]?key|auth)$/i.test(name));
  if (queryCredentials.length > 1) throw new Error(`MCP Server ${key} 包含多个 Query 凭据，请改用表单配置`);
  let auth = normalizeAuth(value.auth, value.headers);
  if (queryCredentials.length === 1) {
    if (auth !== undefined && auth.kind !== "none") throw new Error(`MCP Server ${key} 同时配置了 URL 凭据和 auth`);
    const [parameterName, secret] = queryCredentials[0];
    endpoint.searchParams.delete(parameterName);
    auth = { kind: "query_parameter", parameterName, value: secret };
  }

  const toolAllowlist = stringArray(value.toolAllowlist);
  const toolBlocklist = stringArray(value.toolBlocklist);
  const aliases = stringArray(value.aliases);
  const protocolVersion = text(value.protocolVersion);
  const timeoutMs = positiveInteger(value.timeoutMs);
  return {
    displayName: text(value.displayName) ?? key,
    key,
    transport: "http",
    url: endpoint.toString(),
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    auth: auth ?? { kind: "none" },
    ...(toolAllowlist.length === 0 ? {} : { toolAllowlist }),
    ...(toolBlocklist.length === 0 ? {} : { toolBlocklist }),
    ...(value.trust === "trusted" || value.trust === "untrusted" ? { trust: value.trust } : {}),
    ...(aliases.length === 0 ? {} : { aliases }),
    ...(Array.isArray(value.capabilities) ? { capabilities: value.capabilities } : {}),
  };
}

function normalizeAuth(auth, headers) {
  if (record(auth)) return auth;
  if (!record(headers) || Object.keys(headers).length === 0) return undefined;
  const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)]));
  const authorizationName = Object.keys(normalizedHeaders).find((name) => name.toLowerCase() === "authorization");
  const authorization = authorizationName === undefined ? undefined : normalizedHeaders[authorizationName];
  if (authorization?.startsWith("Bearer ") && Object.keys(normalizedHeaders).length === 1) {
    return { kind: "bearer", token: authorization.slice("Bearer ".length) };
  }
  return { kind: "custom_headers", headers: normalizedHeaders };
}

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value) { return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined; }
function positiveInteger(value) { return Number.isInteger(value) && value > 0 ? value : undefined; }
function stringArray(value) { return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))] : []; }
