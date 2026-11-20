import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { DataAgent, DataAgentMcpCall } from "./agent.ts";
import { OWNER } from "./agent.ts";

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown };
type SseSession = { id: string; response: ServerResponse; closed: boolean };

const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"] as const;
const SERVER_VERSION = "0.1.0";
const MAX_BODY_BYTES = 1_000_000;
const MAX_EVENTS = 200;

const queryDescription = "Execute one natural-language business data question through the fixed data-analysis AgentLoop workflow and return the evidence-backed answer. Read-only TiDB queries only.";
const searchDescription = "Search the configured business catalog for table candidates before asking a data question. Ranking narrows planning scope; it does not authorize a table or replace query evidence.";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} 必须是 1-${max} 个字符`);
  return value.trim();
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, name, max);
}

function publicEvent(event: { seq: number; type: string; createdAt: number; data: Record<string, unknown> }): Record<string, unknown> {
  const data = event.data ?? {};
  const safeKeys = ["phase", "purpose", "step", "stepId", "turn", "toolName", "name", "status", "code",
    "finishReason", "durationMs", "timeToFirstEventMs", "operationStatus", "exitCode", "isError", "approved",
    "assessmentMethod", "assessmentProfile", "model", "requestId"];
  const projected: Record<string, unknown> = {};
  for (const key of safeKeys) {
    const value = data[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") projected[key] = value;
  }
  return { seq: event.seq, type: event.type, createdAt: event.createdAt, data: projected };
}

function compactResult(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded.length <= 200_000) return value;
  const source = record(value);
  return {
    schema: "agentloop.dataQueryResult/v1",
    run_id: source.run_id,
    status: source.status,
    output: typeof source.output === "string" ? source.output.slice(0, 16_000) : undefined,
    result_truncated: true,
  };
}

function sse(response: ServerResponse, event: string, payload: unknown): void {
  if (response.writableEnded) return;
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  response.write(`event: ${event}\ndata: ${data}\n\n`);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY_BYTES) throw new Error("MCP 请求过大");
    chunks.push(Buffer.from(chunk));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MCP 请求必须是 JSON 对象");
  return parsed as Record<string, unknown>;
}

function jsonRpcError(id: JsonRpcId | undefined, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export interface McpServiceOptions {
  agent: DataAgent;
  defaultModelKey: string;
  searchTables?: (question: string) => Promise<unknown>;
}

export interface McpService {
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
  describe(origin: string): Record<string, unknown>;
  verify(tool?: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

export function createMcpService(options: McpServiceOptions): McpService {
  const sessions = new Map<string, SseSession>();
  const tools = [
    {
      name: "query",
      description: queryDescription,
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: {
          question: { type: "string", minLength: 1, maxLength: 20_000, description: "自然语言业务问题" },
          conversation_id: { type: "string", maxLength: 191, description: "可选；复用同一对话上下文" },
          model_key: { type: "string", maxLength: 191, description: "可选；默认使用应用当前模型" },
          clarification_run_id: { type: "string", maxLength: 191, description: "需要继续 HIL 时填写原 Run ID" },
          clarification_response: { type: "object", description: "HIL 响应：request_id、revision、value" },
        }, required: ["question"],
      }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "search_tables",
      description: searchDescription,
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: { question: { type: "string", minLength: 1, maxLength: 4_000, description: "业务问题或指标线索" } }, required: ["question"],
      }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];

  function emit(session: SseSession | undefined, event: string, payload: unknown): void {
    if (session && !session.closed) sse(session.response, event, payload);
  }

  async function persist(call: DataAgentMcpCall, create = false): Promise<void> {
    await options.agent.mcpCalls.save(call, create);
  }

  async function publicRun(runId: string): Promise<Record<string, unknown>> {
    const run = await options.agent.runs.get(OWNER, runId);
    const clarification = await options.agent.runs.currentHumanLoop(OWNER, runId);
    return {
      schema: "agentloop.dataQueryResult/v1",
      run_id: run.id,
      conversation_id: run.conversationId,
      status: clarification ? "needs_clarification" : run.status,
      question: run.input,
      model_key: run.modelKey,
      output: run.output,
      error_code: run.errorCode,
      created_at: run.createdAt,
      finished_at: run.finishedAt,
      clarification: clarification ?? null,
    };
  }

  async function waitForRun(runId: string, call: DataAgentMcpCall & { events: Record<string, unknown>[] }, session: SseSession | undefined, progressToken: string): Promise<Record<string, unknown>> {
    let cursor = 0;
    for (;;) {
      const events = await options.agent.runs.eventsAfter(OWNER, runId, cursor);
      for (const event of events) {
        cursor = Math.max(cursor, event.seq);
        const projected = publicEvent(event);
        call.events.push(projected);
        if (call.events.length > MAX_EVENTS) call.events.splice(0, call.events.length - MAX_EVENTS);
        await persist(call);
        emit(session, "message", { jsonrpc: "2.0", method: "notifications/progress", params: {
          progressToken, progress: event.seq, message: JSON.stringify({ call_id: call.id, type: event.type, data: projected.data }, undefined, 0),
        } });
      }
      const result = await publicRun(runId);
      if (result.status !== "running") return result;
      await delay(250);
    }
  }

  async function callQuery(args: Record<string, unknown>, call: DataAgentMcpCall & { events: Record<string, unknown>[] }, session: SseSession | undefined, progressToken: string): Promise<Record<string, unknown>> {
    const question = text(args.question, "question", 20_000);
    const conversationId = optionalText(args.conversation_id, "conversation_id", 191);
    const modelKey = optionalText(args.model_key, "model_key", 191) ?? options.defaultModelKey;
    const clarificationRunId = optionalText(args.clarification_run_id, "clarification_run_id", 191);
    const response = args.clarification_response;
    let runId: string;
    if (clarificationRunId) {
      const parent = await options.agent.runs.get(OWNER, clarificationRunId);
      if (parent.input !== question) throw new Error("澄清问题必须与原 Run 的问题完全一致");
      if (conversationId !== undefined && conversationId !== parent.conversationId) throw new Error("澄清对话与原 Run 不一致");
      const current = await options.agent.runs.currentHumanLoop(OWNER, clarificationRunId);
      if (!current) throw new Error("原 Run 没有待处理的 Human-in-the-Loop 请求");
      if (response === undefined) {
        call.runId = clarificationRunId;
        return await publicRun(clarificationRunId);
      }
      const value = record(response);
      const requestId = text(value.request_id, "clarification_response.request_id", 191);
      const revision = value.revision;
      if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new Error("clarification_response.revision 无效");
      if (!("value" in value)) throw new Error("clarification_response.value 必填");
      await options.agent.runs.respondHumanLoop(OWNER, clarificationRunId, requestId, value.value, revision);
      runId = clarificationRunId;
    } else {
      if (response !== undefined) throw new Error("clarification_response 必须和 clarification_run_id 一起提供");
      const run = await options.agent.start({ requestId: `mcp_${call.id}`, conversationId: conversationId ?? randomUUID(), input: question, modelKey });
      runId = run.id;
    }
    call.runId = runId;
    return await waitForRun(runId, call, session, progressToken);
  }

  async function invoke(name: string, args: Record<string, unknown>, call: DataAgentMcpCall & { events: Record<string, unknown>[] }, session: SseSession | undefined, progressToken: string): Promise<Record<string, unknown>> {
    if (name === "query") {
      const result = await callQuery(args, call, session, progressToken);
      if (result.status === "failed") throw new Error(String(result.error_code || "问数 Run 执行失败"));
      return result;
    }
    if (name === "search_tables") {
      const question = text(args.question, "question", 4_000);
      if (!options.searchTables) throw new Error("目录检索服务未配置");
      return { schema: "agentloop.tableSearchResult/v1", scenario_id: "group", ...(await options.searchTables(question) as Record<string, unknown>) };
    }
    throw new Error(`未知 MCP 工具：${name}`);
  }

  async function rpc(session: SseSession | undefined, request: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
    const id = request.id;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return jsonRpcError(id, -32600, "Invalid Request");
    if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return undefined;
    if (request.method === "ping") return { jsonrpc: "2.0", id: id ?? null, result: {} };
    if (request.method === "initialize") {
      const requested = record(request.params).protocolVersion;
      const protocolVersion = typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested as typeof PROTOCOL_VERSIONS[number]) ? requested : PROTOCOL_VERSIONS[0];
      return { jsonrpc: "2.0", id: id ?? null, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "AgentLoop Data Agent", version: SERVER_VERSION }, instructions: "固定 data-analysis 问数服务；先用 search_tables 缩小目录范围，再用 query 执行只读问数。" } };
    }
    if (request.method === "tools/list") return { jsonrpc: "2.0", id: id ?? null, result: { tools } };
    if (request.method !== "tools/call") return jsonRpcError(id, -32601, `Method not found: ${request.method}`);
    const params = record(request.params);
    const name = text(params.name, "tool name", 191);
    const args = record(params.arguments);
    const progressToken = String(record(params._meta).progressToken ?? `mcp_${randomUUID()}`);
    const call: DataAgentMcpCall & { events: Record<string, unknown>[] } = { id: `mcp_${randomUUID().replaceAll("-", "").slice(0, 16)}`, tool: name, scenarioId: "group", status: "running", requestId: typeof id === "string" ? id : undefined, startedAt: Date.now(), arguments: args, events: [] };
    await persist(call, true);
    emit(session, "message", { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: 0, message: JSON.stringify({ call_id: call.id, type: "call_started", data: { tool: name } }) } });
    try {
      const result = await invoke(name, args, call, session, progressToken);
      call.status = String(result.status ?? "completed");
      call.result = compactResult(result);
      return { jsonrpc: "2.0", id: id ?? null, result: { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
    } catch (error) {
      call.status = "failed";
      call.error = error instanceof Error ? error.message : String(error);
      return { jsonrpc: "2.0", id: id ?? null, result: { isError: true, content: [{ type: "text", text: call.error }] } };
    } finally {
      call.finishedAt = Date.now(); call.durationMs = call.finishedAt - call.startedAt;
      await persist(call);
      emit(session, "message", { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: call.events.at(-1)?.seq ?? 0, message: JSON.stringify({ call_id: call.id, type: "call_finished", data: { status: call.status, run_id: call.runId, duration_ms: call.durationMs, error: call.error } }) } });
    }
  }

  async function verify(tool = "search_tables", args: Record<string, unknown> = { question: "验证 MCP Server" }): Promise<Record<string, unknown>> {
    const initialize = await rpc(undefined, {
      jsonrpc: "2.0", id: "verify-initialize", method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSIONS[0] },
    });
    const listed = await rpc(undefined, { jsonrpc: "2.0", id: "verify-tools", method: "tools/list" });
    const call = await rpc(undefined, {
      jsonrpc: "2.0", id: "verify-call", method: "tools/call",
      params: { name: text(tool, "tool", 191), arguments: record(args), _meta: { progressToken: `verify_${randomUUID()}` } },
    });
    const callResult = record(call?.result);
    return {
      ok: callResult.isError !== true,
      verified_at: Date.now(),
      initialize: compactResult(initialize),
      tools: compactResult(record(listed?.result).tools),
      call: compactResult(call),
    };
  }

  async function handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (request.method === "GET" && url.pathname === "/mcp/sse") {
      const id = randomUUID();
      const session: SseSession = { id, response, closed: false };
      sessions.set(id, session);
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      response.write(`event: endpoint\ndata: /mcp/messages/?session_id=${encodeURIComponent(id)}\n\n`);
      request.on("close", () => { session.closed = true; sessions.delete(id); });
      return true;
    }
    if (request.method === "POST" && (url.pathname === "/mcp/messages" || url.pathname === "/mcp/messages/")) {
      const id = url.searchParams.get("session_id");
      const session = id ? sessions.get(id) : undefined;
      if (!session) { response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ error: "MCP 会话不存在" })); return true; }
      let body: Record<string, unknown>;
      try { body = await readJson(request); } catch (error) { response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(jsonRpcError(null, -32700, error instanceof Error ? error.message : "Invalid JSON"))); return true; }
      response.writeHead(202, { "Content-Type": "application/json; charset=utf-8" }); response.end();
      void rpc(session, body as JsonRpcRequest).then(result => { if (result !== undefined) emit(session, "message", result); }).catch(error => emit(session, "message", jsonRpcError(typeof body.id === "string" || typeof body.id === "number" ? body.id : null, -32603, error instanceof Error ? error.message : "Internal error")));
      return true;
    }
    return false;
  }

  return {
    handle,
    describe(origin: string) {
      return { name: "AgentLoop Data Agent", version: SERVER_VERSION, transport: "sse", endpoint: `${origin}/mcp/sse`, messageEndpoint: `${origin}/mcp/messages/`, tools };
    },
    verify,
    close() { for (const session of sessions.values()) { session.closed = true; session.response.end(); } sessions.clear(); },
  };
}
