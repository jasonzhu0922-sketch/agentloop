import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { BatchService, LlmProviderRegistry, RunService, SkillService } from "@zhujun/agentloop";
import { AppError, asAppError, badRequest, notFound } from "@zhujun/agentloop";
import { requireRecord } from "@zhujun/agentloop";
import type { AuthService, AuthenticatedUser } from "../auth/auth-service.ts";

const MAX_REQUEST_BYTES = 1_000_000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 + 16_384;
const execFileAsync = promisify(execFile);

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
        response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
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

      const { user, token } = await authenticate(request, dependencies.auth);
      if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
        await dependencies.auth.revoke(token);
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
      if (request.method === "GET" && url.pathname === "/v1/host/protocol") {
        return sendJson(response, 200, hostProtocolDescriptor());
      }
      if (request.method === "POST" && url.pathname === "/v1/host/runs/async") {
        const body = requireRecord(await readJson(request));
        const run = await dependencies.runs.start(user.id, body.input, runOptionsFromBody(body));
        return sendJson(response, 202, {
          schema: "agentloop.hostRunStart/v1",
          run: await dependencies.runs.hostRun(user.id, run.id),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/host/runs") {
        const body = requireRecord(await readJson(request));
        const run = await dependencies.runs.execute(user.id, body.input, runOptionsFromBody(body));
        return sendJson(response, 201, {
          schema: "agentloop.hostRunStart/v1",
          run: await dependencies.runs.hostRun(user.id, run.id),
        });
      }
      const hostRunEventsStreamMatch = url.pathname.match(/^\/v1\/host\/runs\/([^/]+)\/events\/stream$/);
      if (request.method === "GET" && hostRunEventsStreamMatch !== null) {
        return streamHostRunEvents(request, response, dependencies, user.id, decodeURIComponent(hostRunEventsStreamMatch[1]));
      }
      const hostRunEventsMatch = url.pathname.match(/^\/v1\/host\/runs\/([^/]+)\/events$/);
      if (request.method === "GET" && hostRunEventsMatch !== null) {
        const events = await dependencies.runs.events(user.id, decodeURIComponent(hostRunEventsMatch[1]));
        return sendJson(response, 200, {
          schema: "agentloop.hostRunEvents/v1",
          events: events.map(toHostRunEvent),
        });
      }
      const hostRunMatch = url.pathname.match(/^\/v1\/host\/runs\/([^/]+)$/);
      if (request.method === "GET" && hostRunMatch !== null) {
        return sendJson(response, 200, {
          run: await dependencies.runs.hostRun(user.id, decodeURIComponent(hostRunMatch[1])),
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/local-directories") {
        const path = url.searchParams.get("path") ?? undefined;
        return sendJson(response, 200, await listLocalDirectories(path));
      }
      if (request.method === "POST" && url.pathname === "/v1/uploads") {
        const upload = await readMultipartUpload(request);
        return sendJson(response, 201, {
          source: await dependencies.runs.uploadSource(user.id, {
            originalName: upload.filename,
            mimeType: upload.contentType,
            content: upload.content,
            ...(upload.conversationId === undefined ? {} : { conversationId: upload.conversationId }),
          }),
        });
      }
      const sourceMatch = url.pathname.match(/^\/v1\/sources\/([^/]+)$/);
      if (request.method === "GET" && sourceMatch !== null) {
        return sendJson(response, 200, {
          source: await dependencies.runs.source(user.id, decodeURIComponent(sourceMatch[1])),
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
        const skill = await dependencies.skills.create(user.id, {
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
          skill: await dependencies.skills.get(user.id, decodeURIComponent(skillMatch[1])),
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/runs/async") {
        const body = requireRecord(await readJson(request));
        const run = await dependencies.runs.start(user.id, body.input, runOptionsFromBody(body));
        return sendJson(response, 202, { run });
      }
      if (request.method === "POST" && url.pathname === "/v1/runs") {
        const body = requireRecord(await readJson(request));
        const run = await dependencies.runs.execute(user.id, body.input, runOptionsFromBody(body));
        return sendJson(response, 201, { run });
      }
      if (request.method === "GET" && url.pathname === "/v1/tools") {
        return sendJson(response, 200, { tools: dependencies.runs.toolCatalog() });
      }
      if (request.method === "GET" && url.pathname === "/v1/runs") {
        const rawLimit = url.searchParams.get("limit");
        return sendJson(response, 200, {
          runs: await dependencies.runs.list(user.id, rawLimit === null ? undefined : Number(rawLimit)),
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/conversations") {
        return sendJson(response, 200, {
          ...(await dependencies.runs.listConversations(user.id, {
            limit: conversationPageInteger(url.searchParams.get("limit"), "limit", 20, 1, 100),
            offset: conversationPageInteger(url.searchParams.get("offset"), "offset", 0, 0, 10_000),
          })),
        });
      }
      const conversationMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)$/);
      if (request.method === "GET" && conversationMatch !== null) {
        return sendJson(response, 200, await dependencies.runs.getConversation(
          user.id,
          decodeURIComponent(conversationMatch[1]),
        ));
      }
      const conversationVisibleDirectoriesMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/visible-directories$/);
      if (request.method === "PATCH" && conversationVisibleDirectoriesMatch !== null) {
        const body = requireRecord(await readJson(request));
        return sendJson(response, 200, {
          conversation: await dependencies.runs.updateConversationVisibleDirectories(
            user.id,
            decodeURIComponent(conversationVisibleDirectoriesMatch[1]),
            body.visibleDirectories,
          ),
        });
      }
      if (request.method === "DELETE" && conversationMatch !== null) {
        await dependencies.runs.deleteConversation(user.id, decodeURIComponent(conversationMatch[1]));
        return sendJson(response, 204, undefined);
      }
      const runPlanMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/plan$/);
      if (request.method === "GET" && runPlanMatch !== null) {
        return sendJson(response, 200, await dependencies.runs.plan(user.id, decodeURIComponent(runPlanMatch[1])));
      }
      const runEventsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
      if (request.method === "GET" && runEventsMatch !== null) {
        return sendJson(response, 200, {
          events: await dependencies.runs.events(user.id, decodeURIComponent(runEventsMatch[1])),
        });
      }
      const runCommandOutputMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/commands\/([^/]+)\/(stdout|stderr)$/);
      if (request.method === "GET" && runCommandOutputMatch !== null) {
        return sendJson(response, 200, {
          output: await dependencies.runs.readCommandOutput(
            user.id,
            decodeURIComponent(runCommandOutputMatch[1]),
            decodeURIComponent(runCommandOutputMatch[2]),
            runCommandOutputMatch[3] as "stdout" | "stderr",
          ),
        });
      }
      const runToolArgumentsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/tool-arguments\/([^/]+)$/);
      if (request.method === "GET" && runToolArgumentsMatch !== null) {
        return sendJson(response, 200, {
          arguments: await dependencies.runs.readToolArguments(
            user.id,
            decodeURIComponent(runToolArgumentsMatch[1]),
            decodeURIComponent(runToolArgumentsMatch[2]),
          ),
        });
      }
      const runEventsStreamMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events\/stream$/);
      if (request.method === "GET" && runEventsStreamMatch !== null) {
        return streamRunEvents(request, response, dependencies, user.id, decodeURIComponent(runEventsStreamMatch[1]));
      }
      const runCancelMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && runCancelMatch !== null) {
        return sendJson(response, 200, {
          run: await dependencies.runs.cancel(user.id, decodeURIComponent(runCancelMatch[1])),
        });
      }
      const runArtifactPreviewMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/artifacts\/([a-f0-9]{64})\/preview$/);
      if (request.method === "GET" && runArtifactPreviewMatch !== null) {
        return sendJson(response, 200, {
          preview: await dependencies.runs.previewProcessArtifact(
            user.id,
            decodeURIComponent(runArtifactPreviewMatch[1]),
            runArtifactPreviewMatch[2],
          ),
        });
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
          actions: await dependencies.runs.actionsForRun(user.id, decodeURIComponent(runActionsMatch[1])),
        });
      }
      const currentHumanLoopMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/human-loop\/current$/);
      if (request.method === "GET" && currentHumanLoopMatch !== null) {
        return sendJson(response, 200, {
          request: await dependencies.runs.currentHumanLoop(user.id, decodeURIComponent(currentHumanLoopMatch[1])),
        });
      }
      const humanLoopHistoryMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/human-loop\/history$/);
      if (request.method === "GET" && humanLoopHistoryMatch !== null) {
        return sendJson(response, 200, {
          requests: await dependencies.runs.humanLoopHistory(user.id, decodeURIComponent(humanLoopHistoryMatch[1])),
        });
      }
      const humanLoopResponseMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/human-loop\/([^/]+)\/respond$/);
      if (request.method === "POST" && humanLoopResponseMatch !== null) {
        const body = requireRecord(await readJson(request));
        return sendJson(response, 200, {
          response: await dependencies.runs.respondHumanLoop(
            user.id,
            decodeURIComponent(humanLoopResponseMatch[1]),
            decodeURIComponent(humanLoopResponseMatch[2]),
            body.value,
            body.expectedRevision,
          ),
        });
      }
      const runRecoveryMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/recovery$/);
      if (request.method === "GET" && runRecoveryMatch !== null) {
        return sendJson(response, 200, await dependencies.runs.recoveryForRun(user.id, decodeURIComponent(runRecoveryMatch[1])));
      }
      const runRecoveryAdvanceMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/recovery\/advance$/);
      if (request.method === "POST" && runRecoveryAdvanceMatch !== null) {
        return sendJson(response, 200, await dependencies.runs.advanceRecovery(user.id, decodeURIComponent(runRecoveryAdvanceMatch[1])));
      }
      const runRecoveryResponseMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/recovery\/respond$/);
      if (request.method === "POST" && runRecoveryResponseMatch !== null) {
        const body = requireRecord(await readJson(request));
        return sendJson(response, 200, await dependencies.runs.respondRecovery(
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
          run: await dependencies.runs.get(user.id, decodeURIComponent(runMatch[1])),
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/batches") {
        const batch = await dependencies.batches.create(user.id, await readJson(request));
        return sendJson(response, 201, { batch });
      }
      const batchItemsMatch = url.pathname.match(/^\/v1\/batches\/([^/]+)\/items$/);
      if (request.method === "GET" && batchItemsMatch !== null) {
        return sendJson(response, 200, {
          items: await dependencies.batches.items(user.id, decodeURIComponent(batchItemsMatch[1])),
        });
      }
      const batchMatch = url.pathname.match(/^\/v1\/batches\/([^/]+)$/);
      if (request.method === "GET" && batchMatch !== null) {
        return sendJson(response, 200, {
          batch: await dependencies.batches.get(user.id, decodeURIComponent(batchMatch[1])),
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

async function authenticate(
  request: IncomingMessage,
  auth: AuthService,
): Promise<{ user: AuthenticatedUser; token: string }> {
  const header = request.headers.authorization;
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  const token = match?.[1];
  return { user: await auth.authenticate(token), token: token ?? "" };
}

function hostProtocolDescriptor(): Readonly<Record<string, unknown>> {
  return {
    schema: "agentloop.hostProtocol/v1",
    engine: "agentloop",
    endpoints: {
      createRun: "POST /v1/host/runs",
      startRun: "POST /v1/host/runs/async",
      getRun: "GET /v1/host/runs/{runId}",
      listEvents: "GET /v1/host/runs/{runId}/events",
      streamEvents: "GET /v1/host/runs/{runId}/events/stream",
      readArtifact: "GET /v1/runs/{runId}/artifacts/{artifactId}",
      previewArtifact: "GET /v1/runs/{runId}/artifacts/{artifactId}/preview",
    },
    contracts: {
      run: "agentloop.hostRun/v1",
      outcome: "agentloop.hostOutcome/v1",
      event: "agentloop.hostRunEvent/v1",
    },
    completionAuthority: [
      "OutcomePlan",
      "tool evidence",
      "approved assessment",
      "TerminalCommitter",
      "run_outcomes",
    ],
  };
}

function runOptionsFromBody(body: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    allowDangerousTools: body.allowDangerousTools,
    ...(body.modelKey === undefined ? {} : { modelKey: body.modelKey }),
    ...(body.visibleDirectories === undefined ? {} : { visibleDirectories: body.visibleDirectories }),
    ...(body.sourceIds === undefined ? {} : { sourceIds: body.sourceIds }),
    ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
    ...(body.conversationIntent === undefined ? {} : { conversationIntent: body.conversationIntent }),
  };
}

function conversationPageInteger(
  value: string | null,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw badRequest(`${label} must be an integer between ${minimum} and ${maximum}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw badRequest(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readRequestBody(request, MAX_REQUEST_BYTES);
  if (body.length === 0) return {};
  return JSON.parse(body.toString("utf8"));
}

interface MultipartUpload {
  readonly filename: string;
  readonly contentType?: string;
  readonly content: Buffer;
  readonly conversationId?: string;
}

async function readMultipartUpload(request: IncomingMessage): Promise<MultipartUpload> {
  const contentType = request.headers["content-type"] ?? "";
  const boundaryMatch = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))$/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (boundary === undefined || boundary.length === 0) throw badRequest("Upload must use multipart/form-data");
  const body = await readRequestBody(request, MAX_UPLOAD_BYTES);
  const parts = parseMultipart(body, boundary);
  const file = parts.find((part) => part.name === "file");
  if (file === undefined || file.filename === undefined) throw badRequest("Upload requires a file field");
  return {
    filename: file.filename,
    contentType: file.contentType,
    content: file.content,
    conversationId: parts.find((part) => part.name === "conversationId")?.content.toString("utf8").trim() || undefined,
  };
}

interface MultipartPart {
  readonly name: string;
  readonly filename?: string;
  readonly contentType?: string;
  readonly content: Buffer;
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const marker = `--${boundary}`;
  const raw = body.toString("binary");
  const sections = raw.split(marker).slice(1, -1);
  const parts: MultipartPart[] = [];
  for (const section of sections) {
    const trimmed = section.startsWith("\r\n") ? section.slice(2) : section;
    const headerEnd = trimmed.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headerText = trimmed.slice(0, headerEnd);
    const contentText = trimmed.slice(headerEnd + 4).replace(/\r\n$/, "");
    const headers = new Map(headerText.split("\r\n").map((line) => {
      const index = line.indexOf(":");
      return index < 0
        ? ["", ""] as const
        : [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()] as const;
    }));
    const disposition = headers.get("content-disposition") ?? "";
    const name = dispositionParameter(disposition, "name");
    if (name === undefined) continue;
    parts.push({
      name,
      filename: dispositionFilename(disposition),
      contentType: headers.get("content-type"),
      content: Buffer.from(contentText, "binary"),
    });
  }
  return parts;
}

function dispositionFilename(disposition: string): string | undefined {
  const encoded = dispositionParameter(disposition, "filename*");
  if (encoded !== undefined) return decodeRFC5987MultipartValue(encoded);
  const filename = dispositionParameter(disposition, "filename");
  return filename === undefined ? undefined : decodeMultipartHeaderUtf8(filename);
}

function dispositionParameter(disposition: string, key: string): string | undefined {
  const pattern = new RegExp(`${escapeRegExp(key)}=(?:"([^"]*)"|([^;\\s]*))`, "i");
  const match = pattern.exec(disposition);
  return match?.[1] ?? match?.[2];
}

function decodeMultipartHeaderUtf8(value: string): string {
  return Buffer.from(value, "binary").toString("utf8");
}

function decodeRFC5987MultipartValue(value: string): string {
  const match = /^utf-8''(.+)$/i.exec(value);
  if (match === null) return decodeMultipartHeaderUtf8(value);
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return decodeMultipartHeaderUtf8(value);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw badRequest(`Request body exceeds ${maxBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) throw badRequest(`Request body exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
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

interface HostRunEvent {
  readonly schema: "agentloop.hostRunEvent/v1";
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

function toHostRunEvent(event: StreamedEvent): HostRunEvent {
  return {
    schema: "agentloop.hostRunEvent/v1",
    seq: event.seq,
    type: event.type,
    data: event.data,
    createdAt: event.createdAt,
  };
}

async function streamRunEvents(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: HttpDependencies,
  userId: string,
  runId: string,
): Promise<void> {
  await dependencies.runs.get(userId, runId); // ownership check; throws notFound on mismatch

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

  for (const event of await dependencies.runs.events(userId, runId)) write(event);
  live = true;
  for (const event of pending) write(event);

  request.on("close", () => {
    unsubscribe();
    if (!response.writableEnded) response.end();
  });
}

async function streamHostRunEvents(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: HttpDependencies,
  userId: string,
  runId: string,
): Promise<void> {
  await dependencies.runs.get(userId, runId); // ownership check; throws notFound on mismatch

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
    const payload = toHostRunEvent(event);
    response.write(`event: ${payload.type}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  let live = false;
  const pending: StreamedEvent[] = [];
  const unsubscribe = dependencies.runs.subscribeRunEvents(runId, (event) => {
    if (live) write(event);
    else pending.push(event);
  });

  for (const event of await dependencies.runs.events(userId, runId)) write(event);
  live = true;
  for (const event of pending) write(event);

  request.on("close", () => {
    unsubscribe();
    if (!response.writableEnded) response.end();
  });
}

interface LocalDirectoryListing {
  readonly currentPath: string;
  readonly parentPath?: string;
  readonly entries: readonly LocalDirectoryEntry[];
}

interface LocalDirectoryEntry {
  readonly name: string;
  readonly path: string;
}

async function listLocalDirectories(pathValue: string | undefined): Promise<LocalDirectoryListing> {
  const requested = pathValue?.trim() || homedir() || process.cwd();
  if (!isAbsolute(requested)) throw badRequest("path must be an absolute directory path");
  const currentPath = await fs.realpath(resolve(requested)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw badRequest("Directory does not exist");
    throw error;
  });
  const stat = await fs.lstat(currentPath);
  if (stat.isSymbolicLink()) throw badRequest("Directory cannot be a symbolic link");
  if (!stat.isDirectory()) throw badRequest("path must be a directory");
  const entries = await directoryEntries(currentPath);
  const parent = dirname(currentPath);
  return {
    currentPath,
    ...(parent === currentPath ? {} : { parentPath: parent }),
    entries,
  };
}

async function directoryEntries(currentPath: string): Promise<LocalDirectoryEntry[]> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EACCES" || error.code === "EPERM") return [];
    throw error;
  });
  const directories: LocalDirectoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = resolve(currentPath, entry.name);
    const stat = await fs.lstat(child).catch(() => undefined);
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (await isHiddenDirectory(child, entry.name)) continue;
    directories.push({ name: entry.name, path: child });
  }
  return directories.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

async function isHiddenDirectory(path: string, name: string): Promise<boolean> {
  if (name.startsWith(".")) return true;
  if (process.platform === "darwin") return isHiddenDarwinDirectory(path);
  if (process.platform === "win32") return isHiddenWindowsDirectory(path);
  return false;
}

async function isHiddenDarwinDirectory(path: string): Promise<boolean> {
  const { stdout } = await execFileAsync("stat", ["-f", "%Sf", path]).catch(() => ({ stdout: "" }));
  return String(stdout).split(",").map((item) => item.trim().toLowerCase()).includes("hidden");
}

async function isHiddenWindowsDirectory(path: string): Promise<boolean> {
  const { stdout } = await execFileAsync("attrib", [path], { windowsHide: true }).catch(() => ({ stdout: "" }));
  const attributeColumn = String(stdout).split(/\r?\n/, 1)[0]?.slice(0, 16) ?? "";
  return /[HS]/i.test(attributeColumn);
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
