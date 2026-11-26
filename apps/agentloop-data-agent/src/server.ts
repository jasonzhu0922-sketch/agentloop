import { streamRuntimeRun } from "@zhujun/agentloop";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { AppError, MODEL_CONFIGURATION_EDITOR_SCHEMA } from "@zhujun/agentloop";
import { OWNER, type DataAgent, type StartMessage } from "./agent.ts";
import { createMcpService } from "./mcp.ts";
import type { SettingsService } from "./settings.ts";

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

/** Project operational fields for the browser without exposing prompts, SQL, rows or credentials. */
function publicEvent(event: { seq: number; type: string; createdAt: number; data: Record<string, unknown> }) {
  const data = event.data;
  const safeKeys = [
    "phase", "purpose", "step", "stepId", "turn", "toolName", "name", "status", "code",
    "finishReason", "durationMs", "timeToFirstEventMs", "contentLength", "toolCallCount",
    "invocationStatus", "operationStatus", "exitCode", "isError", "approved", "assessmentMethod",
    "assessmentProfile", "model", "providerRequestId", "providerResponseId", "requestId",
  ];
  const projected: Record<string, unknown> = {};
  for (const key of safeKeys) {
    const value = data[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") projected[key] = value;
  }
  const usage = data.usage;
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    const inputTokens = (usage as Record<string, unknown>).inputTokens;
    const outputTokens = (usage as Record<string, unknown>).outputTokens;
    if (typeof inputTokens === "number" || typeof outputTokens === "number") projected.usage = {
      ...(typeof inputTokens === "number" ? { inputTokens } : {}),
      ...(typeof outputTokens === "number" ? { outputTokens } : {}),
    };
  }
  const request = data.request;
  if (request && typeof request === "object" && !Array.isArray(request)) {
    const value = request as Record<string, unknown>;
    const requestKeys = ["model", "phase", "stream", "providerMessageCount", "canonicalMessageCount", "toolCount", "toolChoice"];
    const projectedRequest: Record<string, unknown> = {};
    for (const key of requestKeys) {
      const item = value[key];
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") projectedRequest[key] = item;
    }
    if (Object.keys(projectedRequest).length) projected.request = projectedRequest;
  }
  if (event.type === "plan.admitted" && Array.isArray(data.steps)) {
    projected.steps = data.steps.map((step: unknown) => {
      if (!step || typeof step !== "object") return undefined;
      const value = step as Record<string, unknown>;
      return { id: value.id, objective: value.objective, status: value.status };
    }).filter(Boolean);
  }
  return { seq: event.seq, type: event.type, createdAt: event.createdAt, data: projected,
    ...(typeof data.content === "string" ? { content: data.content } : {}) };
}
function required(body: Record<string, unknown>, key: string, max = 256): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new AppError("BAD_REQUEST", `字段 ${key} 无效`, 400);
  return value;
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new AppError("BAD_REQUEST", "需要 JSON 请求", 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4_000_000) throw new AppError("BAD_REQUEST", "消息过长", 413);
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new AppError("BAD_REQUEST", "JSON 请求无效", 400); }
}

/** Local single-user UI: no accounts or login. Cookie only blocks cross-site API access. */
export function createChatServer(agent: DataAgent, options: {
  webRoot: string; models: readonly { key: string; displayName: string }[]; defaultModelKey: string;
  settings?: SettingsService;
}) {
  const session = randomBytes(32).toString("hex");
  const mcp = createMcpService({ agent, defaultModelKey: options.settings?.models.defaultModelKey ?? options.defaultModelKey,
    searchTables: options.settings ? async question => options.settings!.catalog("search", { query: question }) : undefined });
  const files: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/markdown.js": ["markdown.js", "text/javascript; charset=utf-8"],
    "/history-state.js": ["history-state.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
    "/settings": ["settings.html", "text/html; charset=utf-8"],
    "/settings.js": ["settings.js", "text/javascript; charset=utf-8"],
    "/settings.css": ["settings.css", "text/css; charset=utf-8"],
  };
  return createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = (response.socket?.localPort ?? 0).toString();
      if (!["127.0.0.1", "localhost"].some(host => request.headers.host === `${host}:${port}`)) {
        json(response, 403, { error: "仅允许本机访问" }); return;
      }
      const origin = `http://${request.headers.host}`;
      if (request.headers.origin && request.headers.origin !== origin) { json(response, 403, { error: "请求来源无效" }); return; }
      const url = new URL(request.url ?? "/", origin);
      const staticFile = files[url.pathname];
      if (request.method === "GET" && staticFile) {
        if (["/", "/settings"].includes(url.pathname)) response.setHeader("Set-Cookie", `data_agent_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
        response.writeHead(200, { "Content-Type": staticFile[1], "Cache-Control": "no-store" });
        response.end(await readFile(join(options.webRoot, staticFile[0]))); return;
      }
      if (await mcp.handle(request, response, url)) return;
      if (!request.headers.cookie?.split(/;\s*/).includes(`data_agent_session=${session}`)) {
        json(response, 403, { error: "请刷新对话页面" }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/model-configuration/schema") {
        json(response, 200, MODEL_CONFIGURATION_EDITOR_SCHEMA); return;
      }
      if (request.method === "GET" && url.pathname === "/api/config") {
        json(response, 200, { title: "经营问数", skill: "data-analysis", scenario: "group", models: options.settings?.models.registry.modelCatalog() ?? options.models,
          defaultModelKey: options.settings?.models.defaultModelKey ?? options.defaultModelKey }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/mcp/server") {
        json(response, 200, mcp.describe(origin)); return;
      }
      const mcpCall = url.pathname.match(/^\/api\/mcp\/calls\/([^/]+)$/);
      if (request.method === "GET" && mcpCall) {
        const call = await agent.mcpCalls.get(decodeURIComponent(mcpCall[1]));
        if (!call) { json(response, 404, { error: "MCP 调用不存在" }); return; }
        json(response, 200, call); return;
      }
      if (request.method === "GET" && url.pathname === "/api/mcp/calls") {
        const limit = Number(url.searchParams.get("limit") ?? "50");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError("BAD_REQUEST", "MCP 调用数量无效", 400);
        json(response, 200, { calls: await agent.mcpCalls.list(limit) }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/mcp/verify") {
        const value = await body(request);
        const tool = value.tool === undefined ? undefined : required(value, "tool", 191);
        const args = value.arguments;
        if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
          throw new AppError("BAD_REQUEST", "MCP 调用参数必须是 JSON 对象", 400);
        }
        json(response, 200, await mcp.verify(tool, (args ?? undefined) as Record<string, unknown> | undefined)); return;
      }
      if (request.method === "GET" && url.pathname === "/api/sample-questions" && options.settings) {
        const catalog = await options.settings.catalog("load");
        json(response, 200, { questions: (catalog.sample_questions ?? []).map((item: { question: string }) => item.question) }); return;
      }
      if (url.pathname.startsWith("/api/settings/") && options.settings) {
        const settings = options.settings;
        const route = url.pathname.slice("/api/settings/".length);
        if (request.method === "GET" && route === "models") { json(response, 200, settings.models.publicConfig()); return; }
        if (request.method === "PUT" && route === "models") {
          const value = await body(request);
          const result = await agent.configure(async () => {
            const result = await settings.models.save(value);
            agent.setModelKeys(settings.models.registry.modelKeys());
            return result;
          });
          json(response, 200, result); return;
        }
        const readActions: Record<string, string> = { catalog: url.searchParams.get("inspect") === "true" ? "inspect" : "load", connection: "connection-get", search: "search" };
        if (request.method === "GET" && readActions[route]) {
          json(response, 200, await settings.catalog(readActions[route], { query: url.searchParams.get("query") })); return;
        }
        if (request.method === "PUT" && ["catalog", "connection"].includes(route)) {
          const value = await body(request);
          json(response, 200, await agent.configure(() => settings.catalog(route === "catalog" ? "save" : "connection-save", value), route === "connection")); return;
        }
        if (request.method === "POST" && route === "connection/test") {
          json(response, 200, await settings.catalog("connection-test", await body(request))); return;
        }
        if (request.method === "GET" && route === "status") {
          json(response, 200, { service: "AgentLoop Data Agent", storage: agent.runtimeStateStatus?.().backend ?? "sqlite", skill: agent.skill, url: origin,
            mcp: mcp.describe(origin),
            workflow: [
              { name: "固定能力计划", description: "由应用绑定 data-analysis 主 Skill，领域问题交给当前模型理解。" },
              { name: "读取业务目录", description: "读取授权数据表、表知识、实体、指标和期间定义。" },
              { name: "领域规划与澄清", description: "模型绑定分析口径；有歧义时通过结构化确认继续。" },
              { name: "SQL 生成与受控查询", description: "按 Skill 执行只读查询，校验权限与实体、指标、期间约束。" },
              { name: "结果核对与回答", description: "基于查询回执核对答案，由内核评估并持久化结果。" },
            ] }); return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/history/status") { json(response, 200, await agent.historyStatus()); return; }
      if (request.method === "GET" && url.pathname === "/api/conversations") {
        if (agent.history) {
          json(response, 200, { ...await agent.history.listConversations(OWNER, { limit: Number(url.searchParams.get("limit") ?? 50), cursor: url.searchParams.get("cursor") ?? undefined }), source: "tidb" });
        } else json(response, 200, { conversations: await agent.runs.listConversations(OWNER) }); return;
      }
      const conversation = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (request.method === "GET" && conversation) {
        json(response, 200, await (agent.history ?? agent.runs).getConversation(OWNER, decodeURIComponent(conversation[1]))); return;
      }
      if (request.method === "POST" && url.pathname === "/api/messages") {
        const value = await body(request);
        const message: StartMessage = {
          requestId: required(value, "requestId", 191), conversationId: required(value, "conversationId", 191),
          input: required(value, "input", 20_000), modelKey: required(value, "modelKey"),
        };
        json(response, 202, { run: await agent.start(message) }); return;
      }
      const route = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(cancel|human-loop|events))?$/);
      if (route) {
        const id = decodeURIComponent(route[1]);
        if (request.method === "GET" && route[2] === "events") {
          const after = Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0");
          if (!Number.isSafeInteger(after) || after < 0) throw new AppError("BAD_REQUEST", "事件游标无效", 400);
          await streamRuntimeRun({ runs: agent.runs, actorUserId: OWNER, runId: id, after, request, response, project: publicEvent }); return;
        }
        if (request.method === "GET" && !route[2]) {
          const after = Number(url.searchParams.get("after") ?? "0");
          if (!Number.isSafeInteger(after) || after < 0) throw new AppError("BAD_REQUEST", "事件游标无效", 400);
          if (agent.history) {
            const snapshot = await agent.history.getRun(OWNER, id);
            const events = await agent.history.eventsAfter(OWNER, id, after);
            json(response, 200, { ...snapshot, events: events.map(publicEvent) }); return;
          }
          const [run, events, humanLoop] = await Promise.all([
            agent.runs.get(OWNER, id), agent.runs.eventsAfter(OWNER, id, after), agent.runs.currentHumanLoop(OWNER, id),
          ]);
          // UI projects persisted events; no second transcript or synthetic completion state.
          json(response, 200, { run, humanLoop: humanLoop ?? null, events: events.map(publicEvent) }); return;
        }
        if (request.method === "POST" && route[2] === "cancel") {
          await body(request);
          json(response, 200, { run: await agent.runs.cancel(OWNER, id) }); return;
        }
        if (request.method === "POST" && route[2] === "human-loop") {
          const value = await body(request);
          if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) throw new AppError("BAD_REQUEST", "确认版本无效", 400);
          await agent.runs.respondHumanLoop(OWNER, id, required(value, "requestId"), value.value, Number(value.revision));
          json(response, 200, { accepted: true }); return;
        }
      }
      json(response, 404, { error: "接口不存在" });
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      console.error("Data Agent HTTP failure:", error instanceof Error ? error.message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/giu, "<url>") : "Unknown error");
      const status = error instanceof AppError ? error.status : 500;
      // Provider/filesystem errors can contain deployment details; keep those off the HTTP boundary.
      json(response, status, { error: status < 500 && error instanceof AppError ? error.message : "服务处理失败，请检查服务端运行记录", code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
        ...(error instanceof AppError && error.details?.reason === "runtime_execution_owner_mismatch" ? { reason: error.details.reason, executionRuntimeId: error.details.runtimeId } : {}) });
    }
  });
}
