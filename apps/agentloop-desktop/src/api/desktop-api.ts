import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError } from "@zhujun/agentloop";
import type { LocalRuntimeManager, ManagedLocalRuntime, LocalModelConfigurationInput } from "@zhujun/agentloop-local-runtime";
import { assertLoopback, assertWriteOrigin, DevelopmentSessions, HttpError, securityHeaders } from "../security/loopback.ts";
import { modelEndpoint } from "../security/model-endpoint.ts";

export const DEVELOPMENT_OWNER = "desktop-development";
export const DEFAULT_RUNTIME_ID = "desktop-default";
const context = Object.freeze({ ownerUserId: DEVELOPMENT_OWNER });
const MAX_BODY_BYTES = 1_500_000;

export interface StaticAsset { content: Buffer; type: string }
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body));
}
function text(body: Record<string, unknown>, key: string, max = 200_000): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, `${key}_invalid`);
  return value;
}
function fields(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, "unexpected_field");
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20 || value.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(id))) throw new HttpError(400, "source_ids_invalid");
  return value;
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await new Promise<Buffer>((resolve, reject) => {
    let size = 0; let rejected = false; const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { rejected = true; chunks.length = 0; reject(new HttpError(413, "body_too_large")); }
      else chunks.push(chunk);
    });
    request.on("end", () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    request.on("aborted", () => reject(new HttpError(400, "request_aborted")));
    request.on("error", reject);
  });
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new HttpError(400, "json_invalid"); }
}

/** HTTP transport only: no SQLite, RunService, Router or runtime internals. */
export class DesktopApi {
  origin = "";
  stopping = false;
  activeRequests = 0;
  manager?: LocalRuntimeManager;
  readonly #sessions = new DevelopmentSessions();
  readonly instanceId: string;
  readonly #assets: ReadonlyMap<string, StaticAsset>;
  constructor(instanceId: string, assets: ReadonlyMap<string, StaticAsset>) { this.instanceId = instanceId; this.#assets = assets; }

  handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    securityHeaders(response);
    this.activeRequests++;
    try {
      assertLoopback(request, this.origin);
      const url = new URL(request.url!, this.origin);
      if (request.method === "GET" && url.pathname === "/__desktop/instance") {
        json(response, 200, { instanceId: this.instanceId, ready: this.manager !== undefined && !this.stopping }); return;
      }
      if (this.stopping || !this.manager) throw new HttpError(503, "desktop_not_ready");
      const asset = this.#assets.get(url.pathname);
      if (request.method === "GET" && asset !== undefined) {
        response.writeHead(200, { "Content-Type": asset.type }); response.end(asset.content); return;
      }
      const write = request.method === "POST";
      if (write) assertWriteOrigin(request, this.origin);
      if (request.method === "POST" && url.pathname === "/api/dev/session") {
        fields(await readJson(request), []);
        const session = this.#sessions.issue(request, response);
        json(response, 200, { mode: "development", csrfToken: session.csrf, expiresAt: session.expiresAt }); return;
      }
      const session = this.#sessions.require(request, write);
      if (request.method === "GET" && url.pathname === "/api/session") {
        json(response, 200, { mode: "development", csrfToken: session.csrf, expiresAt: session.expiresAt }); return;
      }
      const runtime = this.manager.runtime(DEFAULT_RUNTIME_ID);
      if (request.method === "GET" && url.pathname === "/api/model-configuration") {
        json(response, 200, await this.manager.modelConfiguration()); return;
      }
      if (request.method === "POST" && url.pathname === "/api/model-configuration") {
        const body = await readJson(request); fields(body, ["configuration", "revision"]);
        const input = body.configuration as LocalModelConfigurationInput;
        // Same model egress policy as the environment-configured CLI. This is
        // independent of the loopback-only Desktop listener and its auth gates.
        if (!input || typeof input !== "object" || Array.isArray(input) || input.reuseCloudModels !== false || !Array.isArray(input.providers)) throw new HttpError(400, "model_configuration_invalid");
        for (const provider of input.providers) {
          try { modelEndpoint(provider?.baseUrl); } catch { throw new HttpError(400, "model_endpoint_invalid"); }
        }
        try { json(response, 200, await this.manager.configureModels(input, text(body, "revision", 64))); }
        catch (error) { if (error instanceof TypeError) throw new HttpError(400, "model_configuration_invalid"); throw error; }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/models") { json(response, 200, { models: await runtime.models() }); return; }
      if (request.method === "GET" && url.pathname === "/api/conversations") { json(response, 200, { conversations: await runtime.conversations(context) }); return; }
      if (request.method === "POST" && url.pathname === "/api/runs") {
        const body = await readJson(request);
        fields(body, ["requestId", "input", "modelKey", "conversationId", "uploadedSourceIds"]);
        const run = await runtime.startRun(context, { requestId: text(body, "requestId", 256), input: text(body, "input"), modelKey: text(body, "modelKey", 200),
          ...(body.conversationId === undefined ? {} : { conversationId: text(body, "conversationId", 200) }),
          uploadedSourceIds: body.uploadedSourceIds === undefined ? [] : ids(body.uploadedSourceIds),
          connectorConnectionIds: [], allowDangerousTools: false });
        json(response, 200, { run }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/sources") {
        const body = await readJson(request); fields(body, ["conversationId", "originalName", "contentBase64"]);
        const encoded = text(body, "contentBase64", 1_400_000); const content = Buffer.from(encoded, "base64");
        if (content.length > 1_048_576 || content.toString("base64") !== encoded) throw new HttpError(400, "source_content_invalid");
        const source = await runtime.upload(context, { conversationId: text(body, "conversationId", 200), originalName: text(body, "originalName", 255), content });
        json(response, 200, { source }); return;
      }
      const parts = url.pathname.split("/").slice(1).map(part => {
        let decoded: string; try { decoded = decodeURIComponent(part); } catch { throw new HttpError(400, "path_invalid"); }
        if (!/^[a-zA-Z0-9_-]{1,200}$/.test(decoded)) throw new HttpError(400, "path_invalid"); return decoded;
      });
      if (request.method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "conversations") {
        json(response, 200, await runtime.conversation(context, parts[2]!)); return;
      }
      if (request.method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "sources") {
        json(response, 200, { source: await runtime.source(context, parts[2]!) }); return;
      }
      await this.runRoute(request, response, runtime, parts, url);
    } catch (error) {
      // Never reflect provider exceptions, paths, URLs, prompts or credentials.
      if (error instanceof HttpError) json(response, error.status, { error: error.code });
      else if (error instanceof AppError) {
        const safe = new Set(["request_id_payload_conflict", "admission_outcome_unknown", "admission_run_deleted", "runtime_capacity_exhausted", "local_model_unavailable", "model_configuration_stale", "model_configuration_read_only", "model_configuration_invalid", "runtime_active_runs_prevent_reconfiguration", "runtime_operation_in_progress"]);
        json(response, error.status, { error: safe.has(error.message) ? error.message : error.code });
      } else json(response, 500, { error: "desktop_operation_failed" });
    } finally { this.activeRequests--; }
  };

  private async runRoute(request: IncomingMessage, response: ServerResponse, runtime: ManagedLocalRuntime, parts: string[], url: URL) {
    if (parts[0] !== "api" || parts[1] !== "runs" || !parts[2]) throw new HttpError(404, "route_not_found");
    const id = parts[2];
    if (request.method === "GET" && parts.length === 3) { json(response, 200, { run: await runtime.getRun(context, id) }); return; }
    if (request.method === "GET" && parts.length === 4 && parts[3] === "events") {
      const after = url.searchParams.get("afterSeq") ?? "0";
      if (!/^\d{1,15}$/.test(after)) throw new HttpError(400, "event_sequence_invalid");
      json(response, 200, { events: await runtime.events(context, id, Number(after)) }); return;
    }
    if (request.method === "POST" && parts.length === 4 && parts[3] === "cancel") {
      fields(await readJson(request), []); json(response, 200, { run: await runtime.cancelRun(context, id) }); return;
    }
    if (request.method === "GET" && parts.length === 4 && parts[3] === "artifacts") { json(response, 200, { artifacts: await runtime.artifacts(context, id) }); return; }
    if (request.method === "GET" && parts.length === 6 && parts[3] === "artifacts" && parts[5] === "download") {
      const { artifact, content } = await runtime.readArtifact(context, id, parts[4]!);
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        "Content-Security-Policy": "sandbox; default-src 'none'" }); response.end(content); return;
    }
    throw new HttpError(404, "route_not_found");
  }
  clearSessions(): void { this.#sessions.clear(); }
}
