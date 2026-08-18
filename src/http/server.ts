import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AgentService } from "../agents/agent-service.ts";
import type { BatchService } from "../batch/batch-service.ts";
import type { AuthService, AuthenticatedUser } from "../auth/auth-service.ts";
import type { RunService } from "../runtime/run-service.ts";
import type { LlmProviderRegistry } from "../runtime/provider-registry.ts";
import type { SkillService } from "../skills/skill-service.ts";
import { AppError, asAppError, badRequest, notFound } from "../shared/errors.ts";
import { requireRecord } from "../shared/validation.ts";
import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_JS } from "./console.ts";

const MAX_REQUEST_BYTES = 1_000_000;

export interface HttpDependencies {
  readonly auth: AuthService;
  readonly skills: SkillService;
  readonly agents: AgentService;
  readonly runs: RunService;
  readonly batches: BatchService;
  readonly providers?: LlmProviderRegistry;
}

export function createAgentLoopServer(dependencies: HttpDependencies): Server {
  return createServer(async (request, response) => {
    const traceId = randomUUID();
    setSecurityHeaders(response, traceId);
    try {
      const url = new URL(request.url ?? "/", "http://agentloop.local");
      if (request.method === "GET" && url.pathname === "/healthz") {
        return sendJson(response, 200, { status: "ok" });
      }
      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        return sendJson(response, 204, undefined);
      }
      if (request.method === "GET" && url.pathname === "/") return sendText(response, 200, CONSOLE_HTML, "text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/assets/app.css") return sendText(response, 200, CONSOLE_CSS, "text/css; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/assets/app.js") return sendText(response, 200, CONSOLE_JS, "text/javascript; charset=utf-8");

      if (request.method === "POST" && url.pathname === "/v1/auth/register") {
        const body = requireRecord(await readJson(request));
        return sendJson(response, 201, await dependencies.auth.register(body.email, body.password));
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/login") {
        const body = requireRecord(await readJson(request));
        return sendJson(response, 200, await dependencies.auth.login(body.email, body.password));
      }

      const { user, token } = authenticate(request, dependencies.auth);
      if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
        dependencies.auth.revoke(token);
        return sendJson(response, 204, undefined);
      }
      if (request.method === "GET" && url.pathname === "/v1/me") {
        return sendJson(response, 200, { user });
      }
      if (request.method === "GET" && url.pathname === "/v1/providers") {
        return sendJson(response, 200, {
          providers: dependencies.providers?.catalog() ?? [],
          ...(dependencies.providers === undefined ? {} : { defaultProviderKey: dependencies.providers.defaultProviderKey }),
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/skills") {
        return sendJson(response, 200, { skills: await dependencies.skills.listAvailable(user.id) });
      }
      if (request.method === "GET" && url.pathname === "/v1/skills/discovered") {
        return sendJson(response, 200, { skills: dependencies.skills.discovered() });
      }
      if (request.method === "POST" && url.pathname === "/v1/skills") {
        const body = requireRecord(await readJson(request));
        const skill = dependencies.skills.create(user.id, {
          name: body.name,
          description: body.description,
          instructions: body.instructions,
        });
        return sendJson(response, 201, { skill });
      }
      if (request.method === "POST" && url.pathname === "/v1/skills/import-directory") {
        const body = requireRecord(await readJson(request));
        const skill = await dependencies.skills.installFromDirectory(user.id, {
          sourceDirectory: body.sourceDirectory,
          sourceUrl: body.sourceUrl,
          sourceRevision: body.sourceRevision,
          expectedPackageHash: body.expectedPackageHash,
        });
        return sendJson(response, 201, { skill });
      }
      const skillMatch = url.pathname.match(/^\/v1\/skills\/([^/]+)$/);
      if (request.method === "GET" && skillMatch !== null) {
        return sendJson(response, 200, {
          skill: dependencies.skills.get(user.id, decodeURIComponent(skillMatch[1])),
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/agents") {
        return sendJson(response, 200, { agents: dependencies.agents.list(user.id) });
      }
      if (request.method === "POST" && url.pathname === "/v1/agents") {
        const body = requireRecord(await readJson(request));
        const agent = dependencies.agents.create(user.id, {
          name: body.name,
          systemPrompt: body.systemPrompt,
          providerKey: body.providerKey,
          modelId: body.modelId,
          maxSteps: body.maxSteps,
          maxDepth: body.maxDepth,
          skillIds: body.skillIds,
          childAgentIds: body.childAgentIds,
          toolNames: body.toolNames,
        });
        return sendJson(response, 201, { agent });
      }
      const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
      if (request.method === "GET" && agentMatch !== null) {
        return sendJson(response, 200, {
          agent: dependencies.agents.get(user.id, decodeURIComponent(agentMatch[1])),
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/runs/async") {
        const body = requireRecord(await readJson(request));
        const run = await dependencies.runs.start(user.id, body.agentId, body.input, {
          allowDangerousTools: body.allowDangerousTools,
        });
        return sendJson(response, 202, { run });
      }
      if (request.method === "POST" && url.pathname === "/v1/runs") {
        const body = requireRecord(await readJson(request));
        const run = await dependencies.runs.execute(user.id, body.agentId, body.input, {
          allowDangerousTools: body.allowDangerousTools,
        });
        return sendJson(response, 201, { run });
      }
      if (request.method === "GET" && url.pathname === "/v1/tools") {
        return sendJson(response, 200, { tools: dependencies.runs.toolCatalog() });
      }
      const runPlanMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/plan$/);
      if (request.method === "GET" && runPlanMatch !== null) {
        return sendJson(response, 200, dependencies.runs.plan(user.id, decodeURIComponent(runPlanMatch[1])));
      }
      const runEventsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
      if (request.method === "GET" && runEventsMatch !== null) {
        return sendJson(response, 200, {
          events: dependencies.runs.events(user.id, decodeURIComponent(runEventsMatch[1])),
        });
      }
      const runEventsStreamMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events\/stream$/);
      if (request.method === "GET" && runEventsStreamMatch !== null) {
        return streamRunEvents(request, response, dependencies, user.id, decodeURIComponent(runEventsStreamMatch[1]));
      }
      const runActionsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/actions$/);
      if (request.method === "GET" && runActionsMatch !== null) {
        return sendJson(response, 200, {
          actions: dependencies.runs.actionsForRun(user.id, decodeURIComponent(runActionsMatch[1])),
        });
      }
      const runRecoveryMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/recovery$/);
      if (request.method === "GET" && runRecoveryMatch !== null) {
        return sendJson(response, 200, dependencies.runs.recoveryForRun(user.id, decodeURIComponent(runRecoveryMatch[1])));
      }
      const runRecoveryAdvanceMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/recovery\/advance$/);
      if (request.method === "POST" && runRecoveryAdvanceMatch !== null) {
        return sendJson(response, 200, await dependencies.runs.advanceRecovery(user.id, decodeURIComponent(runRecoveryAdvanceMatch[1])));
      }
      const runRecoveryResponseMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/recovery\/respond$/);
      if (request.method === "POST" && runRecoveryResponseMatch !== null) {
        const body = requireRecord(await readJson(request));
        return sendJson(response, 200, dependencies.runs.respondRecovery(
          user.id,
          decodeURIComponent(runRecoveryResponseMatch[1]),
          body.response,
        ));
      }
      const runRecoveryResumeMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/recovery\/resume$/);
      if (request.method === "POST" && runRecoveryResumeMatch !== null) {
        return sendJson(response, 200, {
          run: await dependencies.runs.resumeRecovery(user.id, decodeURIComponent(runRecoveryResumeMatch[1])),
        });
      }
      const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
      if (request.method === "GET" && runMatch !== null) {
        return sendJson(response, 200, {
          run: dependencies.runs.get(user.id, decodeURIComponent(runMatch[1])),
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/batches") {
        const batch = await dependencies.batches.create(user.id, await readJson(request));
        return sendJson(response, 201, { batch });
      }
      const batchItemsMatch = url.pathname.match(/^\/v1\/batches\/([^/]+)\/items$/);
      if (request.method === "GET" && batchItemsMatch !== null) {
        return sendJson(response, 200, {
          items: dependencies.batches.items(user.id, decodeURIComponent(batchItemsMatch[1])),
        });
      }
      const batchMatch = url.pathname.match(/^\/v1\/batches\/([^/]+)$/);
      if (request.method === "GET" && batchMatch !== null) {
        return sendJson(response, 200, {
          batch: dependencies.batches.get(user.id, decodeURIComponent(batchMatch[1])),
        });
      }

      throw notFound("Route");
    } catch (error) {
      const appError = error instanceof SyntaxError
        ? badRequest("Request body must be valid JSON")
        : asAppError(error);
      sendError(response, appError, traceId);
    }
  });
}

function authenticate(
  request: IncomingMessage,
  auth: AuthService,
): { user: AuthenticatedUser; token: string } {
  const header = request.headers.authorization;
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  const token = match?.[1];
  return { user: auth.authenticate(token), token: token ?? "" };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw badRequest(`Request body exceeds ${MAX_REQUEST_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BYTES) throw badRequest(`Request body exceeds ${MAX_REQUEST_BYTES} bytes`);
    chunks.push(buffer);
  }
  if (length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function setSecurityHeaders(response: ServerResponse, traceId: string): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("x-trace-id", traceId);
}

interface StreamedEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

function streamRunEvents(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: HttpDependencies,
  userId: string,
  runId: string,
): void {
  dependencies.runs.get(userId, runId); // ownership check; throws notFound on mismatch

  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders?.();

  const seen = new Set<number>();
  const write = (event: StreamedEvent): void => {
    if (response.writableEnded || seen.has(event.seq)) return;
    seen.add(event.seq);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Subscribe first so no event published between the snapshot read and the
  // subscription is lost; the seq-dedupe set absorbs the small overlap.
  let live = false;
  const pending: StreamedEvent[] = [];
  const unsubscribe = dependencies.runs.subscribeRunEvents(runId, (event) => {
    if (live) write(event);
    else pending.push(event);
  });

  for (const event of dependencies.runs.events(userId, runId)) write(event);
  live = true;
  for (const event of pending) write(event);

  request.on("close", () => {
    unsubscribe();
    if (!response.writableEnded) response.end();
  });
}

function sendText(response: ServerResponse, status: number, payload: string, contentType: string): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.end(payload);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  if (payload === undefined) {
    response.end();
    return;
  }
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendError(response: ServerResponse, error: AppError, traceId: string): void {
  sendJson(response, error.status, {
    error: {
      code: error.code,
      message: error.message,
      traceId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  });
}
