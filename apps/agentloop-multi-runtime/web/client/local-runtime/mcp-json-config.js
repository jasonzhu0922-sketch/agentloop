const AUTH_KINDS = new Set(["none", "bearer", "api_key_header", "basic", "query_parameter", "custom_headers"]);

export const runtimeMcpConfigurationExample = [{
  displayName: "知识服务", key: "knowledge", transport: "http",
  url: "https://mcp.example.com/mcp", auth: { kind: "none" },
  aliases: ["知识库"],
  capabilities: [{ id: "knowledge_search", category: "search", label: "知识检索" }],
}];

export function parseRuntimeMcpConfiguration(raw) {
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error("MCP JSON 格式错误，请检查引号、逗号和括号。"); }
  if (!Array.isArray(value)) throw new Error("MCP 配置必须是 JSON 数组。");
  for (const [index, server] of value.entries()) {
    const label = `mcpServers[${index}]`;
    if (!isRecord(server)) throw new Error(`${label} 必须是 JSON 对象。`);
    for (const field of ["displayName", "key", "url"]) {
      if (typeof server[field] !== "string" || server[field].trim() === "") throw new Error(`${label}.${field} 必须是非空字符串。`);
    }
    if (server.transport !== "http") throw new Error(`${label}.transport 必须是 http。`);
    let url;
    try { url = new URL(server.url); }
    catch { throw new Error(`${label}.url 不是有效 URL。`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label}.url 只支持 HTTP 或 HTTPS。`);
    if (url.username || url.password) throw new Error(`${label}.url 不能包含用户名或密码，请使用 auth 字段。`);
    if ([...url.searchParams.keys()].some((key) => /(?:token|secret|password|api[-_]?key|auth)/i.test(key))) {
      throw new Error(`${label}.url 不能包含凭据参数，请使用 auth 字段。`);
    }
    if (!isRecord(server.auth) || !AUTH_KINDS.has(server.auth.kind)) throw new Error(`${label}.auth.kind 无效。`);
    if (server.id !== undefined && (typeof server.id !== "string" || server.id.length === 0)) throw new Error(`${label}.id 必须是非空字符串。`);
    if (server.protocolVersion !== undefined && typeof server.protocolVersion !== "string") throw new Error(`${label}.protocolVersion 必须是字符串。`);
    if (server.timeoutMs !== undefined && (!Number.isSafeInteger(server.timeoutMs) || server.timeoutMs <= 0)) throw new Error(`${label}.timeoutMs 必须是正整数。`);
    for (const field of ["toolAllowlist", "toolBlocklist", "aliases"]) {
      if (server[field] !== undefined && (!Array.isArray(server[field]) || server[field].some((item) => typeof item !== "string" || item.length === 0))) {
        throw new Error(`${label}.${field} 必须是字符串数组。`);
      }
    }
    if (server.trust !== undefined && !["trusted", "untrusted"].includes(server.trust)) throw new Error(`${label}.trust 无效。`);
    if (server.capabilities !== undefined && (!Array.isArray(server.capabilities) || server.capabilities.some((item) => !isRecord(item)))) {
      throw new Error(`${label}.capabilities 必须是对象数组。`);
    }
    validateAuthentication(server.auth, label);
  }
  const keys = value.map((server) => server.key);
  if (new Set(keys).size !== keys.length) throw new Error("MCP Server 的 key 不能重复。");
  return value;
}

function validateAuthentication(auth, label) {
  const stringFields = auth.kind === "bearer" ? ["token"]
    : auth.kind === "api_key_header" ? ["headerName", "value"]
      : auth.kind === "basic" ? ["username", "password"]
        : auth.kind === "query_parameter" ? ["parameterName", "value"] : [];
  for (const field of stringFields) {
    if (auth[field] !== undefined && (typeof auth[field] !== "string" || auth[field].length === 0)) throw new Error(`${label}.auth.${field} 必须是非空字符串。`);
  }
  if (["api_key_header", "basic"].includes(auth.kind) && !auth[stringFields[0]]) throw new Error(`${label}.auth.${stringFields[0]} 不能为空。`);
  if (auth.kind === "query_parameter" && !auth.parameterName) throw new Error(`${label}.auth.parameterName 不能为空。`);
  if (auth.kind === "custom_headers") {
    if (auth.headers !== undefined && (!isRecord(auth.headers) || Object.values(auth.headers).some((item) => typeof item !== "string" || item.length === 0))) {
      throw new Error(`${label}.auth.headers 必须是值为非空字符串的 JSON 对象。`);
    }
    if (auth.headerNames !== undefined && (!Array.isArray(auth.headerNames) || auth.headerNames.some((item) => typeof item !== "string" || item.length === 0))) {
      throw new Error(`${label}.auth.headerNames 必须是字符串数组。`);
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
