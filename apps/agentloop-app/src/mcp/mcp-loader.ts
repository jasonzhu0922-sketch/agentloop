import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { AppError, badRequest } from "@zhujun/agentloop";
import type { RuntimeTool, ToolExecutionContext, ToolSourceCapability } from "@zhujun/agentloop";
import { requireRecord, requireString } from "@zhujun/agentloop";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_CLIENT_NAME = "agentloop-app";
const MCP_CLIENT_VERSION = "0.1.0";

export interface McpServersConfig {
  readonly defaultTrust?: "trusted" | "untrusted";
  readonly servers: readonly McpServerRegistration[];
}

export interface McpServerRegistration {
  readonly key: string;
  readonly transport: "http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly auth?: McpAuthConfig;
  readonly trust?: "trusted" | "untrusted";
  readonly timeoutMs?: number;
  readonly toolAllowlist?: readonly string[];
  readonly toolBlocklist?: readonly string[];
  /** Host-owned matching terms for an explicitly requested ToolSource. */
  readonly aliases?: readonly string[];
  /** Host-owned vocabulary exposed to planning for this source. */
  readonly capabilities?: readonly ToolSourceCapability[];
}

export type McpAuthConfig =
  | { readonly kind: "none" }
  | { readonly kind: "bearer"; readonly tokenEnv: string }
  | { readonly kind: "headers"; readonly headers: Readonly<Record<string, string>> }
  | { readonly kind: "query"; readonly name: string; readonly secretEnv: string };

export interface LoadedMcpIntegration {
  readonly tools: readonly RuntimeTool<unknown>[];
  readonly loadedServers: readonly LoadedMcpServer[];
  readonly failedServers: readonly FailedMcpServer[];
}

export interface LoadedMcpServer {
  readonly key: string;
  readonly transport: "http";
  readonly toolCount: number;
}

export interface FailedMcpServer {
  readonly key: string;
  readonly transport: "http";
  readonly message: string;
}

export interface McpSessionFactory {
  create(server: McpServerRegistration): Promise<McpSession>;
}

export interface McpSession {
  request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function loadMcpToolsFromConfigFile(path: string): Promise<LoadedMcpIntegration> {
  const raw = await fs.readFile(resolve(path), "utf8");
  return loadMcpToolsFromConfigDocument(raw, `MCP server configuration file ${resolve(path)}`);
}

export async function loadOptionalMcpToolsFromConfigFile(path: string): Promise<LoadedMcpIntegration> {
  const resolved = resolve(path);
  try {
    const raw = await fs.readFile(resolved, "utf8");
    return loadMcpToolsFromConfigDocument(raw, `MCP server configuration file ${resolved}`);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { tools: [], loadedServers: [], failedServers: [] };
    }
    throw error;
  }
}

export async function loadMcpToolsFromConfigDocument(raw: string, label: string): Promise<LoadedMcpIntegration> {
  return loadMcpToolsFromConfig(parseMcpServersConfig(JSON.parse(raw), label));
}

export async function loadMcpToolsFromConfig(config: McpServersConfig): Promise<LoadedMcpIntegration> {
  return loadMcpToolsFromConfigWithFactory(config, {
    create: async (server) => createHttpMcpSession(server),
  });
}

export async function loadMcpToolsFromConfigWithFactory(
  config: McpServersConfig,
  factory: McpSessionFactory,
): Promise<LoadedMcpIntegration> {
  const loadedServers: LoadedMcpServer[] = [];
  const failedServers: FailedMcpServer[] = [];
  const tools: RuntimeTool<unknown>[] = [];
  for (const server of config.servers) {
    try {
      const session = await factory.create(server);
      const discoveredTools = await listAllTools(session);
      const filteredTools = applyToolFilters(server, discoveredTools);
      const trust = server.trust ?? config.defaultTrust ?? "untrusted";
      const materialized = filteredTools.map((tool) => createRuntimeTool(server, trust, session, tool));
      loadedServers.push({ key: server.key, transport: server.transport, toolCount: materialized.length });
      tools.push(...materialized);
    } catch (error) {
      failedServers.push({
        key: server.key,
        transport: server.transport,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  validateUniqueToolNames(tools);
  return { tools, loadedServers, failedServers };
}

export function parseMcpServersConfig(value: unknown, label = "MCP server configuration"): McpServersConfig {
  const record = requireRecord(value, label);
  const serversValue = record.servers;
  if (!Array.isArray(serversValue)) throw badRequest(`${label}.servers must be an array`);
  const servers = serversValue.map((server, index) => parseMcpServerRegistration(server, `${label}.servers[${index}]`));
  const defaultTrust = record.defaultTrust === undefined ? undefined : parseTrust(record.defaultTrust, `${label}.defaultTrust`);
  return { ...(defaultTrust === undefined ? {} : { defaultTrust }), servers };
}

function parseMcpServerRegistration(value: unknown, label: string): McpServerRegistration {
  const record = requireRecord(value, label);
  const key = requireString(record.key, `${label}.key`, { min: 1, max: 80 });
  const transport = requireString(record.transport, `${label}.transport`);
  if (transport !== "http") throw badRequest(`${label}.transport must be "http"`);
  const timeoutMs = record.timeoutMs === undefined ? undefined : parsePositiveInteger(record.timeoutMs, `${label}.timeoutMs`);
  return {
    key,
    transport: "http",
    url: requireString(record.url, `${label}.url`, { min: 1 }),
    ...(record.headers === undefined ? {} : { headers: parseStringRecord(record.headers, `${label}.headers`) }),
    ...(record.auth === undefined ? {} : { auth: parseMcpAuthConfig(record.auth, `${label}.auth`) }),
    ...(record.trust === undefined ? {} : { trust: parseTrust(record.trust, `${label}.trust`) }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(record.toolAllowlist === undefined ? {} : { toolAllowlist: parseStringArray(record.toolAllowlist, `${label}.toolAllowlist`) }),
    ...(record.toolBlocklist === undefined ? {} : { toolBlocklist: parseStringArray(record.toolBlocklist, `${label}.toolBlocklist`) }),
    ...(record.aliases === undefined ? {} : { aliases: parseStringArray(record.aliases, `${label}.aliases`) }),
    ...(record.capabilities === undefined ? {} : { capabilities: parseToolSourceCapabilities(record.capabilities, `${label}.capabilities`) }),
  };
}

function parseMcpAuthConfig(value: unknown, label: string): McpAuthConfig {
  const record = requireRecord(value, label);
  const kind = requireString(record.kind, `${label}.kind`);
  if (kind === "none") return { kind };
  if (kind === "bearer") return { kind, tokenEnv: requireString(record.tokenEnv, `${label}.tokenEnv`, { min: 1 }) };
  if (kind === "headers") return { kind, headers: parseStringRecord(record.headers, `${label}.headers`) };
  if (kind === "query") {
    return {
      kind,
      name: requireString(record.name, `${label}.name`, { min: 1 }),
      secretEnv: requireString(record.secretEnv, `${label}.secretEnv`, { min: 1 }),
    };
  }
  throw badRequest(`${label}.kind must be one of none|bearer|headers|query`);
}

function applyToolFilters(server: McpServerRegistration, tools: readonly McpToolDefinition[]): readonly McpToolDefinition[] {
  const allowlist = server.toolAllowlist === undefined ? undefined : new Set(server.toolAllowlist);
  const blocklist = server.toolBlocklist === undefined ? new Set<string>() : new Set(server.toolBlocklist);
  return tools.filter((tool) => {
    if (allowlist !== undefined && !allowlist.has(tool.name)) return false;
    if (blocklist.has(tool.name)) return false;
    return true;
  });
}

interface McpToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

interface JsonRpcResponse {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
  readonly _mcpSessionId?: string;
}

function createRuntimeTool(
  server: McpServerRegistration,
  trust: "trusted" | "untrusted",
  session: McpSession,
  tool: McpToolDefinition,
): RuntimeTool<unknown> {
  const toolName = `mcp_${normalizeNamePart(server.key)}_${normalizeNamePart(tool.name)}`;
  return {
    name: toolName,
    description: [tool.title, tool.description, `source=${server.key}`, `trust=${trust}`].filter(Boolean).join(" "),
    source: {
      id: server.key,
      ...(server.aliases === undefined ? {} : { aliases: server.aliases }),
      transport: "mcp",
      capabilities: server.capabilities ?? [],
    },
    inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema as Record<string, unknown> : { type: "object" },
    executionMode: "exclusive",
    replaySafe: false,
    timeoutMs: server.timeoutMs,
    maxResultCharacters: 120_000,
    parse(value) {
      return value;
    },
    async execute(context, input) {
      const result = await session.request("tools/call", { name: tool.name, arguments: input }, context.signal);
      return normalizeToolCallResult(server, tool, result);
    },
  };
}

function normalizeToolCallResult(server: McpServerRegistration, tool: McpToolDefinition, result: Record<string, unknown>): Record<string, unknown> {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(item)))
    .join("\n");
  const structuredSourceSummary = structuredMcpSourceSummary(result, server, tool);
  return {
    schema: "agentloop.mcpToolResult/v1",
    serverKey: server.key,
    toolName: tool.name,
    ...(text.length === 0 ? {} : { text }),
    content,
    isError: result.isError === true,
    raw: result,
    evidenceReceipt: structuredSourceSummary ?? {
      schema: "agentloop.toolEvidenceReceipt/v1",
      sourceType: "mcp",
      receiptId: createHash("sha256").update(`${server.key}:${tool.name}:${JSON.stringify(result)}`).digest("hex").slice(0, 32),
      sourceRefs: [{ serverKey: server.key, toolName: tool.name, transport: server.transport, url: server.url }],
      facts: [],
      caveats: [],
      evidenceKinds: { satisfied: ["mcp_tool_call"], caveated: [], failed: [] },
    },
  };
}

function structuredMcpSourceSummary(
  result: Record<string, unknown>,
  server: McpServerRegistration,
  tool: McpToolDefinition,
): Record<string, unknown> | undefined {
  if (result.isError === true) return undefined;
  const payload = parseStructuredMcpPayload(result);
  if (payload === undefined || !looksLikeStructuredSourcePayload(payload)) return undefined;
  const fields = summarizeStructuredMcpPayload(payload);
  const receiptId = createHash("sha256").update(`${server.key}:${tool.name}:${JSON.stringify({ payload, fields })}`).digest("hex").slice(0, 32);
  return {
    schema: "agentloop.toolEvidenceReceipt/v1",
    sourceType: "mcp",
    receiptId,
    sourceRefs: [{ serverKey: server.key, toolName: tool.name, transport: server.transport, url: server.url }],
    facts: [{
      kind: "source_summary",
      toolName: tool.name,
      textPreview: summarizeStructuredMcpTextPreview(fields),
      fields,
    }],
    caveats: [],
    evidenceKinds: {
      satisfied: ["mcp_tool_call", "source_summary"],
      caveated: [],
      failed: [],
    },
  };
}

function parseStructuredMcpPayload(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidates: unknown[] = [];
  if (typeof result.text === "string") candidates.push(result.text);
  if (Array.isArray(result.content)) candidates.push(...result.content);
  for (const candidate of candidates) {
    const text = typeof candidate === "string"
      ? candidate
      : isRecord(candidate) && typeof candidate.text === "string"
        ? candidate.text
        : undefined;
    if (text === undefined) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return undefined;
}

function looksLikeStructuredSourcePayload(payload: Record<string, unknown>): boolean {
  return Array.isArray(payload.results)
    || Array.isArray(payload.rows)
    || Array.isArray(payload.paths)
    || isRecord(payload.origin)
    || isRecord(payload.destination)
    || typeof payload.location === "string"
    || typeof payload.totalRows === "number"
    || typeof payload.totalRecords === "number"
    || typeof payload.distance === "string"
    || typeof payload.duration === "string";
}

function summarizeStructuredMcpPayload(payload: Record<string, unknown>, maxFields = 12): Array<{ readonly name: string; readonly value: string }> {
  const fields: Array<{ readonly name: string; readonly value: string }> = [];
  const pushField = (name: string, value: unknown): void => {
    if (fields.length >= maxFields) return;
    const text = stringifyStructuredValue(value);
    if (text === undefined) return;
    fields.push({ name, value: text });
  };
  const visit = (value: unknown, path: string, depth: number): void => {
    if (fields.length >= maxFields) return;
    if (isScalarValue(value)) {
      pushField(path, value);
      return;
    }
    if (Array.isArray(value)) {
      pushField(`${path}Count`, value.length);
      if (value.length === 0 || depth >= 2) return;
      const sampleLimit = Math.min(value.length, path.includes("steps") ? 1 : 2);
      for (let index = 0; index < sampleLimit && fields.length < maxFields; index += 1) {
        visit(value[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }
    if (!isRecord(value)) return;
    for (const key of Object.keys(value).sort()) {
      if (fields.length >= maxFields) return;
      visit((value as Record<string, unknown>)[key], path.length === 0 ? key : `${path}.${key}`, depth + 1);
    }
  };
  visit(payload, "", 0);
  return fields;
}

function summarizeStructuredMcpTextPreview(fields: readonly { readonly name: string; readonly value: string }[]): string {
  return fields.slice(0, 6).map((field) => `${field.name}=${field.value}`).join("; ");
}

function isScalarValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function stringifyStructuredValue(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

async function listAllTools(session: McpSession): Promise<readonly McpToolDefinition[]> {
  const result = await session.request("tools/list");
  const tools = Array.isArray(result.tools) ? result.tools : [];
  return tools.flatMap((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string") return [];
    return [{
      name: tool.name,
      ...(typeof tool.title === "string" ? { title: tool.title } : {}),
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    }];
  });
}

async function createHttpMcpSession(server: McpServerRegistration): Promise<McpSession> {
  const baseUrl = resolveHttpRequestUrl(server);
  const headers = createMcpRequestHeaders(server, "initialize", { includeProtocolVersion: false });
  const initResponse = await postJsonRpc(baseUrl, headers, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    },
  });
  if (initResponse._mcpSessionId !== undefined) headers.set("mcp-session-id", initResponse._mcpSessionId);
  await postNotification(baseUrl, createMcpRequestHeaders(server, "notifications/initialized"), {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  let requestId = 2;
  return {
    request: (method, params, signal) => requestHttpJsonRpc(baseUrl, headers, method, params, signal, requestId++),
    close: async () => undefined,
  };
}

async function requestHttpJsonRpc(
  url: URL,
  headers: Headers,
  method: string,
  params: Record<string, unknown> | undefined,
  signal?: AbortSignal,
  requestId = 99,
): Promise<Record<string, unknown>> {
  headers = createMcpRequestHeadersFrom(headers, method, params);
  const response = await postJsonRpc(url, headers, {
    jsonrpc: "2.0",
    id: requestId,
    method,
    ...(params === undefined ? {} : { params }),
  }, signal);
  if (response.error !== undefined) {
    throw new AppError("TOOL_EXECUTION_ERROR", response.error.message, 502, { code: response.error.code, data: response.error.data });
  }
  return response.result ?? {};
}

async function postJsonRpc(
  url: URL,
  headers: Headers,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<JsonRpcResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok && response.status !== 202) {
    const errorBody = await response.text().catch(() => "");
    const suffix = errorBody.trim().length > 0 ? `: ${errorBody.trim().slice(0, 500)}` : "";
    throw new AppError("INTERNAL_ERROR", `MCP server responded with HTTP ${response.status}${suffix}`, response.status);
  }
  const sessionId = response.headers.get("mcp-session-id") ?? undefined;
  const json = await readJsonRpcResponse(response, payload.id);
  return { ...json, ...(sessionId === undefined ? {} : { _mcpSessionId: sessionId }) };
}

async function postNotification(
  url: URL,
  headers: Headers,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok && response.status !== 202 && response.status !== 204) {
    const errorBody = await response.text().catch(() => "");
    const suffix = errorBody.trim().length > 0 ? `: ${errorBody.trim().slice(0, 500)}` : "";
    throw new AppError("INTERNAL_ERROR", `MCP server responded with HTTP ${response.status}${suffix}`, response.status);
  }
}

function createMcpRequestHeaders(
  server: McpServerRegistration,
  method: string,
  options: { readonly includeProtocolVersion?: boolean } = {},
): Headers {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-method": method,
    ...resolveHttpAuthHeaders(server),
    ...(server.headers ?? {}),
  });
  if (options.includeProtocolVersion !== false) {
    headers.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
  }
  return headers;
}

function createMcpRequestHeadersFrom(
  headers: Headers,
  method: string,
  params?: Record<string, unknown>,
): Headers {
  const cloned = new Headers(headers);
  cloned.set("accept", "application/json, text/event-stream");
  cloned.set("content-type", "application/json");
  cloned.set("mcp-method", method);
  cloned.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
  if (method === "tools/call" && typeof params?.name === "string" && params.name.length > 0) {
    cloned.set("mcp-name", params.name);
  } else if (method === "resources/read" && typeof params?.uri === "string" && params.uri.length > 0) {
    cloned.set("mcp-name", params.uri);
  } else if (method === "prompts/get" && typeof params?.name === "string" && params.name.length > 0) {
    cloned.set("mcp-name", params.name);
  } else {
    cloned.delete("mcp-name");
  }
  return cloned;
}

async function readJsonRpcResponse(response: Response, requestId: unknown): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("application/json")) {
    return await response.json() as JsonRpcResponse;
  }
  if (contentType.startsWith("text/event-stream")) {
    return await readSseJsonRpcResponse(response, requestId);
  }
  return await response.json() as JsonRpcResponse;
}

async function readSseJsonRpcResponse(response: Response, requestId: unknown): Promise<JsonRpcResponse> {
  if (response.body === null) {
    throw new AppError("INTERNAL_ERROR", "MCP server returned an empty SSE response", response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value !== undefined) buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const separatorIndex = buffer.indexOf("\n\n");
        if (separatorIndex < 0) break;
        const eventText = buffer.slice(0, separatorIndex).replace(/\r\n/g, "\n");
        buffer = buffer.slice(separatorIndex + 2);
        const json = parseSseJsonRpcEvent(eventText, requestId);
        if (json !== undefined) {
          await reader.cancel().catch(() => undefined);
          return json;
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  throw new AppError("INTERNAL_ERROR", "MCP server returned SSE without a JSON-RPC response", response.status);
}

function parseSseJsonRpcEvent(eventText: string, requestId: unknown): JsonRpcResponse | undefined {
  const dataLines = eventText
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return undefined;
  const payload = dataLines.join("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if ("id" in parsed && parsed.id !== requestId && parsed.id !== String(requestId)) return undefined;
  if (parsed.result === undefined && parsed.error === undefined) return undefined;
  return parsed as JsonRpcResponse;
}

function resolveHttpAuthHeaders(server: McpServerRegistration): Readonly<Record<string, string>> {
  const auth = server.auth;
  if (auth === undefined || auth.kind === "none") return {};
  if (auth.kind === "bearer") {
    const token = process.env[auth.tokenEnv];
    if (token === undefined || token.trim().length === 0) {
      throw new AppError("MODEL_ERROR", `Missing MCP bearer token env ${auth.tokenEnv} for server ${server.key}`, 503);
    }
    return { authorization: `Bearer ${token}` };
  }
  if (auth.kind === "headers") return auth.headers;
  return {};
}

function resolveHttpRequestUrl(server: McpServerRegistration): URL {
  const url = new URL(server.url);
  const auth = server.auth;
  if (auth === undefined || auth.kind !== "query") return url;
  const token = process.env[auth.secretEnv];
  if (token === undefined || token.trim().length === 0) {
    throw new AppError("MODEL_ERROR", `Missing MCP query secret env ${auth.secretEnv} for server ${server.key}`, 503);
  }
  url.searchParams.set(auth.name, token);
  return url;
}

function parseTrust(value: unknown, label: string): "trusted" | "untrusted" {
  if (value === "trusted" || value === "untrusted") return value;
  throw badRequest(`${label} must be "trusted" or "untrusted"`);
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw badRequest(`${label} must be a positive integer`);
  return value;
}

function parseStringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  const record = requireRecord(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) result[key] = requireString(entry, `${label}.${key}`, { min: 1 });
  return result;
}

function parseStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw badRequest(`${label} must be an array`);
  return value.map((item, index) => requireString(item, `${label}[${index}]`, { min: 1 }));
}

function parseToolSourceCapabilities(value: unknown, label: string): readonly ToolSourceCapability[] {
  if (!Array.isArray(value)) throw badRequest(`${label} must be an array`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const record = requireRecord(entry, itemLabel);
    const id = requireString(record.id, `${itemLabel}.id`, { min: 1, max: 160 });
    if (seen.has(id)) throw badRequest(`${label} contains duplicate capability ${id}`);
    seen.add(id);
    const category = requireString(record.category, `${itemLabel}.category`, { min: 1, max: 80 });
    const labelValue = record.label === undefined ? undefined : requireString(record.label, `${itemLabel}.label`, { min: 1, max: 160 });
    const description = record.description === undefined ? undefined : requireString(record.description, `${itemLabel}.description`, { min: 1, max: 1_000 });
    return {
      id,
      category,
      ...(labelValue === undefined ? {} : { label: labelValue }),
      ...(description === undefined ? {} : { description }),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNamePart(value: string): string {
  const lower = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return lower.length === 0 ? "unnamed" : lower;
}

function validateUniqueToolNames(tools: readonly RuntimeTool<unknown>[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new AppError("CONFLICT", `Duplicate MCP tool name after normalization: ${tool.name}`, 409);
    seen.add(tool.name);
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
