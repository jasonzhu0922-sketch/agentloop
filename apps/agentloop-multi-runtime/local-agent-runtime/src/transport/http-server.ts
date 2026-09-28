import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LocalAgentService } from "../application/local-agent-service.ts";
import type { LocalAgentOptions } from "../application/local-agent-options.ts";

export type LocalAgentServerOptions = LocalAgentOptions;

/** Loopback HTTP adapter. Local Agent use cases and state stay in application/persistence. */
export async function createLocalAgentServer(input: LocalAgentServerOptions): Promise<Server> {
  const service = await LocalAgentService.create(input);
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (originAllowed(origin, input.webOrigin)) response.setHeader("access-control-allow-origin", origin!);
    response.setHeader("vary", "origin");
    if (request.method === "OPTIONS") return options(response);
    const url = new URL(request.url ?? "/", "http://local-agent");
    try {
      if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, await service.health());
      if (request.method === "POST" && url.pathname === "/v1/device-registration") {
        const registered = await service.registerDevice(origin, stringValue((await body(request)).registrationToken, "registrationToken"));
        return json(response, alreadyRegistered(registered) ? 200 : 201, registered);
      }

      if (request.method === "GET" && url.pathname === "/v1/directory-scopes") { await session(request, service); return json(response, 200, await service.listDirectoryScopes(queryRuntimeId(url))); }
      if (request.method === "POST" && url.pathname === "/v1/directory-scopes/pick") { await session(request, service); return json(response, 201, await service.pickDirectoryScope(stringValue((await body(request)).runtimeId, "runtimeId"))); }
      const revokeScope = url.pathname.match(/^\/v1\/directory-scopes\/([^/]+)\/revoke$/);
      if (request.method === "POST" && revokeScope !== null) { await session(request, service); await service.revokeDirectoryScope(stringValue((await body(request)).runtimeId, "runtimeId"), decodeURIComponent(revokeScope[1])); return json(response, 204, undefined); }

      if (request.method === "POST" && url.pathname === "/v1/uploads") {
        const localSession = await session(request, service); const value = await body(request);
        return json(response, 201, await service.upload(localSession, {
          runtimeId: stringValue(value.runtimeId, "runtimeId"), conversationId: stringValue(value.conversationId, "conversationId"), originalName: stringValue(value.originalName, "originalName"), content: base64Content(value.contentBase64),
          ...(value.mediaType === undefined ? {} : { mediaType: stringValue(value.mediaType, "mediaType") }),
        }));
      }
      const localConversation = url.pathname.match(/^\/v1\/local-runtimes\/([^/]+)\/conversations\/([^/]+)$/);
      if (request.method === "DELETE" && localConversation !== null) { await service.deleteConversation(await session(request, service), decodeURIComponent(localConversation[1]), decodeURIComponent(localConversation[2])); return json(response, 204, undefined); }

      if (request.method === "POST" && url.pathname === "/v1/strict-local-runs") {
        const localSession = await session(request, service); const value = await body(request);
        return json(response, 202, await service.startStrictLocalRun(localSession, {
          runtimeId: stringValue(value.runtimeId, "runtimeId"), conversationId: stringValue(value.conversationId, "conversationId"), clientMessageId: stringValue(value.clientMessageId, "clientMessageId"), input: stringValue(value.input, "input"),
          localDirectoryScopeIds: stringArray(value.localDirectoryScopeIds ?? [], "localDirectoryScopeIds"), localUploadedSourceIds: stringArray(value.localUploadedSourceIds ?? [], "localUploadedSourceIds"), allowDangerousTools: value.allowDangerousTools !== false,
          ...(value.requestedModelKey === undefined ? {} : { requestedModelKey: stringValue(value.requestedModelKey, "requestedModelKey") }),
        }));
      }
      const strictRun = url.pathname.match(/^\/v1\/strict-local-runs\/([^/]+)\/([^/]+)$/);
      if (request.method === "GET" && strictRun !== null) return json(response, 200, await service.strictLocalRun(await session(request, service), decodeURIComponent(strictRun[1]), decodeURIComponent(strictRun[2])));
      const strictEvents = url.pathname.match(/^\/v1\/strict-local-runs\/([^/]+)\/([^/]+)\/events$/);
      if (request.method === "GET" && strictEvents !== null) return json(response, 200, await service.strictLocalEvents(await session(request, service), decodeURIComponent(strictEvents[1]), decodeURIComponent(strictEvents[2]), Number(url.searchParams.get("afterSeq") ?? 0)));
      const strictCancel = url.pathname.match(/^\/v1\/strict-local-runs\/([^/]+)\/([^/]+)\/cancel$/);
      if (request.method === "POST" && strictCancel !== null) return json(response, 200, await service.cancelStrictLocalRun(await session(request, service), decodeURIComponent(strictCancel[1]), decodeURIComponent(strictCancel[2])));

      const artifacts = url.pathname.match(/^\/v1\/local-runtimes\/([^/]+)\/runs\/([^/]+)\/artifacts$/);
      if (request.method === "GET" && artifacts !== null) return json(response, 200, await service.artifacts(await session(request, service), decodeURIComponent(artifacts[1]), decodeURIComponent(artifacts[2])));
      const preview = url.pathname.match(/^\/v1\/local-runtimes\/([^/]+)\/runs\/([^/]+)\/artifacts\/([^/]+)\/preview$/);
      if (request.method === "GET" && preview !== null) return json(response, 200, await service.previewArtifact(await session(request, service), decodeURIComponent(preview[1]), decodeURIComponent(preview[2]), decodeURIComponent(preview[3])));
      const artifact = url.pathname.match(/^\/v1\/local-runtimes\/([^/]+)\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
      if (request.method === "GET" && artifact !== null) {
        const result = await service.readArtifact(await session(request, service), decodeURIComponent(artifact[1]), decodeURIComponent(artifact[2]), decodeURIComponent(artifact[3]));
        response.statusCode = 200; response.setHeader("content-type", result.artifact.mimeType || "application/octet-stream"); response.setHeader("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(result.artifact.name)}`); response.end(Buffer.from(result.content)); return;
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) { return json(response, errorStatus(error), { error: error instanceof Error ? error.message : String(error) }); }
  });
  server.on("close", () => { void service.close(); });
  return server;
}

async function session(request: IncomingMessage, service: LocalAgentService) {
  const value = request.headers["x-local-session"];
  return await service.authorize(request.headers.origin, typeof value === "string" ? value : undefined);
}
function options(response: ServerResponse): void { response.statusCode = 204; response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS"); response.setHeader("access-control-allow-headers", "content-type, x-local-session"); response.end(); }
async function body(request: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request_body_invalid"); return parsed as Record<string, unknown>; }
function queryRuntimeId(url: URL): string { const runtimeId = url.searchParams.get("runtimeId"); if (runtimeId === null) throw new Error("runtimeId_required"); return runtimeId; }
function stringValue(value: unknown, name: string): string { if (typeof value !== "string" || value.length === 0 || value.length > 200_000) throw new Error(`${name}_invalid`); return value; }
function stringArray(value: unknown, name: string): readonly string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new Error(`${name}_invalid`); return value as string[]; }
function base64Content(value: unknown): Buffer { const max = Math.ceil((25 * 1024 * 1024) / 3) * 4; if (typeof value !== "string" || value.length === 0 || value.length > max || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("contentBase64_invalid"); const content = Buffer.from(value, "base64"); if (content.length === 0 || content.length > 25 * 1024 * 1024) throw new Error("contentBase64_invalid"); return content; }
function json(response: ServerResponse, status: number, value: unknown): void { response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8"); response.end(value === undefined ? "" : JSON.stringify(value)); }
function originAllowed(origin: string | undefined, configured: string | undefined): boolean { return origin !== undefined && configured !== undefined && configured.split(",").map((value) => value.trim()).includes(origin); }
function errorStatus(error: unknown): number { return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 400; }
function alreadyRegistered(value: unknown): boolean { return typeof value === "object" && value !== null && "alreadyRegistered" in value && value.alreadyRegistered === true; }
