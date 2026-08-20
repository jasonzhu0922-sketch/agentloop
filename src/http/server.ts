import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { BatchService } from "../batch/batch-service.ts";
import type { AuthService, AuthenticatedUser } from "../auth/auth-service.ts";
import type { RunService } from "../runtime/run-service.ts";
import type { LlmProviderRegistry } from "../runtime/provider-registry.ts";
import type { SkillService } from "../skills/skill-service.ts";
import { AppError, asAppError, badRequest, notFound } from "../shared/errors.ts";
import { requireRecord } from "../shared/validation.ts";

const MAX_REQUEST_BYTES = 1_000_000;

export interface HttpDependencies {
  readonly auth: AuthService;
  readonly skills: SkillService;
  readonly runs: RunService;
  readonly batches: BatchService;
  readonly providers?: LlmProviderRegistry;
}

export interface AgentLoopServerOptions {
  /**
   * Origin allowlist for cross-origin API requests. When absent, no
   * Access-Control-Allow-Origin header is emitted (same-origin only).
   */
  readonly webOrigins?: readonly string[];
}

export function createAgentLoopServer(
  dependencies: HttpDependencies,
  options: AgentLoopServerOptions = {},
): Server {
  return createServer(async (request, response) => {
    const traceId = randomUUID();
    const origin = request.headers.origin;
    const allowedOrigin = allowOrigin(origin, options.webOrigins);
    setSecurityHeaders(response, traceId, allowedOrigin);
    try {
      if (request.method === "OPTIONS") {
        if (allowedOrigin === undefined) throw notFound("Route");
        response.statusCode = 204;
        response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
        response.setHeader("access-control-allow-headers", "authorization, content-type");
        response.setHeader("access-control-max-age", "86400");
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://agentloop.local");
      if (request.method === "GET" && url.pathname === "/healthz") {
        return sendJson(response, 200, { status: "ok" });
      }
      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        return sendJson(response, 204, undefined);
      }
      if (!url.pathname.startsWith("/v1/")) throw notFound("Route");

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
          models: dependencies.providers?.modelCatalog() ?? [],
          ...(dependencies.providers === undefined ? {} : { defaultProviderKey: dependencies.providers.defaultProviderKey }),
          ...(dependencies.providers === undefined ? {} : { defaultModelKey: dependencies.providers.defaultModelKey }),
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return sendJson(response, 200, {
          models: dependencies.providers?.modelCatalog() ?? [],
          ...(dependencies.providers === undefined ? {} : { defaultModelKey: dependencies.providers.defaultModelKey }),
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

      if (request.method === "POST" && url.pathname === "/v1/runs/async") {
        const body = requireRecord(await readJson(request));
        const run = await dependencies.runs.start(user.id, body.input, {
          allowDangerousTools: body.allowDangerousTools,
          ...(body.modelKey === undefined ? {} : { modelKey: body.modelKey }),
          ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
          ...(body.conversationIntent === undefined ? {} : { conversationIntent: body.conversationIntent }),
        });
        return sendJson(response, 202, { run });
      }
      if (request.method === "POST" && url.pathname === "/v1/runs") {
        const body = requireRecord(await readJson(request));
        const run = await dependencies.runs.execute(user.id, body.input, {
          allowDangerousTools: body.allowDangerousTools,
          ...(body.modelKey === undefined ? {} : { modelKey: body.modelKey }),
          ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
          ...(body.conversationIntent === undefined ? {} : { conversationIntent: body.conversationIntent }),
        });
        return sendJson(response, 201, { run });
      }
      if (request.method === "GET" && url.pathname === "/v1/tools") {
        return sendJson(response, 200, { tools: dependencies.runs.toolCatalog() });
      }
      if (request.method === "GET" && url.pathname === "/v1/runs") {
        const rawLimit = url.searchParams.get("limit");
        return sendJson(response, 200, {
          runs: dependencies.runs.list(user.id, rawLimit === null ? undefined : Number(rawLimit)),
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/conversations") {
        return sendJson(response, 200, {
          conversations: dependencies.runs.listConversations(user.id),
        });
      }
      const conversationMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)$/);
      if (request.method === "GET" && conversationMatch !== null) {
        return sendJson(response, 200, dependencies.runs.getConversation(
          user.id,
          decodeURIComponent(conversationMatch[1]),
        ));
      }
      if (request.method === "DELETE" && conversationMatch !== null) {
        dependencies.runs.deleteConversation(user.id, decodeURIComponent(conversationMatch[1]));
        return sendJson(response, 204, undefined);
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
      const runArtifactMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/artifacts\/([a-f0-9]{64})$/);
      if (request.method === "GET" && runArtifactMatch !== null) {
        const artifact = await dependencies.runs.readProcessArtifact(
          user.id,
          decodeURIComponent(runArtifactMatch[1]),
          runArtifactMatch[2],
        );
        return sendBinary(response, 200, artifact.content, artifact.artifact.mimeType, artifact.artifact.name);
      }
      const runArtifactsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/artifacts$/);
      if (request.method === "GET" && runArtifactsMatch !== null) {
        return sendJson(response, 200, {
          artifacts: await dependencies.runs.processArtifacts(user.id, decodeURIComponent(runArtifactsMatch[1])),
        });
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

function setSecurityHeaders(response: ServerResponse, traceId: string, allowedOrigin: string | undefined): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("x-trace-id", traceId);
  if (allowedOrigin !== undefined) {
    response.setHeader("access-control-allow-origin", allowedOrigin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
}

function allowOrigin(origin: string | undefined, allowlist: readonly string[] | undefined): string | undefined {
  if (origin === undefined || allowlist === undefined || allowlist.length === 0) return undefined;
  if (allowlist.includes("*")) return "*";
  if (allowlist.includes(origin)) return origin;
  return undefined;
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

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  if (payload === undefined) {
    response.end();
    return;
  }
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendBinary(
  response: ServerResponse,
  status: number,
  payload: Uint8Array,
  contentType: string,
  filename: string,
): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("content-disposition", contentDispositionInline(filename));
  response.end(payload);
}

function contentDispositionInline(filename: string): string {
  const asciiName = filename
    .replaceAll("\\", "_")
    .replaceAll("/", "_")
    .replaceAll('"', "")
    .replace(/[^\x20-\x7E]/g, "_")
    || "artifact";
  return `inline; filename="${asciiName}"; filename*=UTF-8''${encodeRFC5987ValueChars(filename)}`;
}

function encodeRFC5987ValueChars(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
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
