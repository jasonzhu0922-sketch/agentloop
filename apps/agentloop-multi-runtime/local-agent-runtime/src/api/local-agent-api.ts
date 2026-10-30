import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LocalAgentService } from "../service/local-agent-service.ts";
import type { LocalAgentOptions } from "../config/local-agent-options.ts";
import type { LocalRuntimeConfigurationInput, LocalRuntimeMcpServerInput } from "../persistence/local-runtime-configuration-store.ts";
import type { ToolSourceCapability } from "@zhujun/agentloop";
import type { LocalSkillUploadFile } from "../service/local-skill-package-installer.ts";

export type LocalAgentServerOptions = LocalAgentOptions;

/** Loopback HTTP adapter. Local Agent use cases and state stay in service/persistence. */
export async function createLocalAgentServer(input: LocalAgentServerOptions): Promise<Server> {
  const service = await LocalAgentService.create(input);
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (originAllowed(origin, input.webOrigin)) response.setHeader("access-control-allow-origin", origin!);
    response.setHeader("vary", "origin");
    if (request.method === "OPTIONS") return options(request, response, originAllowed(origin, input.webOrigin));
    const url = new URL(request.url ?? "/", "http://local-agent");
    try {
      if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, await service.health());
      if (request.method === "POST" && url.pathname === "/v1/device-registration") {
        const registered = await service.registerDevice(origin, stringValue((await body(request)).registrationToken, "registrationToken"));
        return json(response, alreadyRegistered(registered) ? 200 : 201, registered);
      }
      if (request.method === "POST" && url.pathname === "/v1/agent/reconnect") {
        await session(request, service);
        return json(response, 202, await service.reconnect());
      }

      if (request.method === "GET" && url.pathname === "/v1/local-runtimes") {
        await session(request, service);
        return json(response, 200, await service.localRuntimes());
      }
      if (request.method === "GET" && url.pathname === "/v1/agent/config") {
        await session(request, service);
        return json(response, 200, await service.agentConfiguration());
      }
      if (request.method === "POST" && url.pathname === "/v1/agent/config/shared-storage/pick") {
        await session(request, service);
        return json(response, 200, await service.pickSharedStorage());
      }
      if (request.method === "POST" && url.pathname === "/v1/agent/config/upload-storage/pick") {
        await session(request, service);
        return json(response, 200, await service.pickUploadStorage());
      }

      if (request.method === "GET" && url.pathname === "/v1/local-skill-packages") {
        await session(request, service);
        return json(response, 200, await service.listLocalSkillPackages());
      }
      const skillMetadata = url.pathname.match(/^\/v1\/local-skill-packages\/([^/]+)\/metadata$/);
      if (skillMetadata !== null && request.method === "GET") {
        await session(request, service);
        return json(response, 200, await service.localSkillMetadata(decodeURIComponent(skillMetadata[1])));
      }
      if (skillMetadata !== null && request.method === "PUT") {
        await session(request, service);
        const value = await body(request);
        return json(response, 200, await service.updateLocalSkillMetadata(decodeURIComponent(skillMetadata[1]), value.declaration ?? value));
      }
      if (request.method === "GET" && url.pathname === "/v1/local-models/configuration") {
        await session(request, service);
        return json(response, 200, await service.localModelConfiguration());
      }
      if (request.method === "GET" && url.pathname === "/v1/local-models") {
        await session(request, service);
        return json(response, 200, await service.localModels(url.searchParams.has("includeCloud") ? url.searchParams.get("includeCloud") === "true" : undefined));
      }
      if (request.method === "GET" && url.pathname === "/v1/local-memory/configuration") {
        await session(request, service);
        return json(response, 200, await service.localMemoryConfiguration());
      }
      if (request.method === "PUT" && url.pathname === "/v1/local-memory/configuration") {
        await session(request, service);
        const value = await body(request);
        return json(response, 200, await service.updateLocalMemoryConfiguration(parseMemoryConfigurationInput(value)));
      }
      const memorySettlement = url.pathname.match(/^\/v1\/local-memory\/settlements\/([^/]+)$/);
      if (memorySettlement !== null && request.method === "GET") {
        return json(response, 200, await service.localMemorySettlement(await session(request, service), decodeURIComponent(memorySettlement[1])));
      }
      const memoryReplay = url.pathname.match(/^\/v1\/local-memory\/settlements\/([^/]+)\/replay$/);
      if (memoryReplay !== null && request.method === "POST") {
        return json(response, 200, await service.replayLocalMemorySettlement(await session(request, service), decodeURIComponent(memoryReplay[1])));
      }
      if (request.method === "PUT" && url.pathname === "/v1/local-models/configuration") {
        await session(request, service);
        const value = await body(request);
        return json(response, 200, await service.updateLocalModelConfiguration(value as never));
      }
      if (request.method === "POST" && url.pathname === "/v1/local-skill-package-uploads") {
        await session(request, service);
        const value = await body(request, 90 * 1024 * 1024);
        if (value.files !== undefined) {
          if (value.contentBase64 !== undefined) throw new Error("skill_upload_input_ambiguous");
          return json(response, 201, await service.installLocalSkillDirectory(directoryFiles(value.files)));
        }
        return json(response, 201, await service.installLocalSkillPackage(
          stringValue(value.originalName, "originalName"),
          base64Content(value.contentBase64),
        ));
      }
      if (request.method === "POST" && url.pathname === "/v1/local-mcp-servers/test") {
        await session(request, service);
        const value = await body(request);
        return json(response, 200, await service.testLocalMcpServer(parseMcpServerInput(recordValue(value.server, "server"), 0)));
      }
      if (request.method === "POST" && url.pathname === "/v1/local-runtimes") {
        await session(request, service);
        const value = await body(request);
        return json(response, 201, await service.createLocalRuntime(
          stringValue(value.displayName, "displayName"),
          runtimeConfigurationInput(value),
        ));
      }
      const runtimeConfiguration = url.pathname.match(/^\/v1\/local-runtimes\/([^/]+)\/configuration$/);
      if (request.method === "GET" && runtimeConfiguration !== null) {
        await session(request, service);
        return json(response, 200, await service.localRuntimeConfiguration(decodeURIComponent(runtimeConfiguration[1])));
      }
      if (request.method === "PUT" && runtimeConfiguration !== null) {
        await session(request, service);
        const value = await body(request);
        return json(response, 200, await service.updateLocalRuntimeConfiguration(
          decodeURIComponent(runtimeConfiguration[1]),
          runtimeConfigurationInput(value),
          value.displayName === undefined ? undefined : stringValue(value.displayName, "displayName"),
        ));
      }
      const runtimeDelete = url.pathname.match(/^\/v1\/local-runtimes\/([^/]+)$/);
      if (request.method === "DELETE" && runtimeDelete !== null) {
        await session(request, service);
        return json(response, 200, await service.removeLocalRuntime(decodeURIComponent(runtimeDelete[1])));
      }
      const runtimeLifecycle = url.pathname.match(/^\/v1\/local-runtimes\/([^/]+)\/(start|stop|drain|restart)$/);
      if (request.method === "POST" && runtimeLifecycle !== null) {
        await session(request, service);
        const runtimeId = decodeURIComponent(runtimeLifecycle[1]);
        const action = runtimeLifecycle[2];
        if (action === "start") return json(response, 200, await service.startLocalRuntime(runtimeId));
        if (action === "stop") return json(response, 200, await service.stopLocalRuntime(runtimeId));
        if (action === "drain") return json(response, 200, await service.drainLocalRuntime(runtimeId));
        return json(response, 200, await service.restartLocalRuntime(runtimeId));
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
function options(request: IncomingMessage, response: ServerResponse, allowedOrigin: boolean): void {
  response.statusCode = 204;
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type, x-local-session");
  if (allowedOrigin && request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("access-control-allow-private-network", "true");
  }
  response.end();
}
async function body(request: IncomingMessage, maxBytes = 26 * 1024 * 1024): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length; if (bytes > maxBytes) throw Object.assign(new Error("request_body_too_large"), { status: 413 }); chunks.push(buffer); } const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request_body_invalid"); return parsed as Record<string, unknown>; }
function queryRuntimeId(url: URL): string { const runtimeId = url.searchParams.get("runtimeId"); if (runtimeId === null) throw new Error("runtimeId_required"); return runtimeId; }
function stringValue(value: unknown, name: string): string { if (typeof value !== "string" || value.length === 0 || value.length > 200_000) throw new Error(`${name}_invalid`); return value; }
function stringArray(value: unknown, name: string): readonly string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new Error(`${name}_invalid`); return value as string[]; }
function base64Content(value: unknown, maxBytes = 25 * 1024 * 1024): Buffer { const max = Math.ceil(maxBytes / 3) * 4; if (typeof value !== "string" || value.length === 0 || value.length > max || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("contentBase64_invalid"); const content = Buffer.from(value, "base64"); if (content.length === 0 || content.length > maxBytes) throw new Error("contentBase64_invalid"); return content; }
function directoryFiles(value: unknown): readonly LocalSkillUploadFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2_000) throw new Error("skill_upload_files_invalid");
  return value.map((item, index) => {
    const entry = recordValue(item, `files[${index}]`);
    return { path: stringValue(entry.path, `files[${index}].path`), content: base64Content(entry.contentBase64, 16 * 1024 * 1024) };
  });
}
function json(response: ServerResponse, status: number, value: unknown): void { response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8"); response.end(value === undefined ? "" : JSON.stringify(value)); }
function originAllowed(origin: string | undefined, configured: string | undefined): boolean { return origin !== undefined && configured !== undefined && configured.split(",").map((value) => value.trim()).includes(origin); }
function errorStatus(error: unknown): number { return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 400; }
function alreadyRegistered(value: unknown): boolean { return typeof value === "object" && value !== null && "alreadyRegistered" in value && value.alreadyRegistered === true; }

function runtimeConfigurationInput(value: Record<string, unknown>): LocalRuntimeConfigurationInput {
  const skillPackageIds = value.skills === undefined
    ? []
    : objectArray(value.skills, "skills").map((skill, index) => stringValue(skill.packageId, `skills[${index}].packageId`));
  const mcpServers = value.mcpServers === undefined
    ? []
    : objectArray(value.mcpServers, "mcpServers").map(parseMcpServerInput);
  if (value.memory !== undefined) throw new Error("memory_configuration_is_device_scoped");
  return { skillPackageIds, mcpServers };
}

function parseMemoryConfigurationInput(value: Record<string, unknown>): { enabled?: boolean; settlementModelKey?: string } {
  const input = recordValue(value.memory ?? value, "memory");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("memory.enabled_invalid");
  if (input.settlementModelKey !== undefined && typeof input.settlementModelKey !== "string") throw new Error("memory.settlementModelKey_invalid");
  return {
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.settlementModelKey === undefined ? {} : { settlementModelKey: input.settlementModelKey }),
  };
}

function parseMcpServerInput(value: Record<string, unknown>, index: number): LocalRuntimeMcpServerInput {
  const label = `mcpServers[${index}]`;
  const auth = recordValue(value.auth, `${label}.auth`);
  const kind = stringValue(auth.kind, `${label}.auth.kind`);
  const common = {
    ...(value.id === undefined ? {} : { id: stringValue(value.id, `${label}.id`) }),
    displayName: stringValue(value.displayName, `${label}.displayName`),
    key: stringValue(value.key, `${label}.key`),
    transport: literalHttp(value.transport, `${label}.transport`),
    url: stringValue(value.url, `${label}.url`),
    ...(value.protocolVersion === undefined ? {} : { protocolVersion: stringValue(value.protocolVersion, `${label}.protocolVersion`) }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: positiveInteger(value.timeoutMs, `${label}.timeoutMs`) }),
    ...(value.toolAllowlist === undefined ? {} : { toolAllowlist: stringArray(value.toolAllowlist, `${label}.toolAllowlist`) }),
    ...(value.toolBlocklist === undefined ? {} : { toolBlocklist: stringArray(value.toolBlocklist, `${label}.toolBlocklist`) }),
    ...(value.trust === undefined ? {} : { trust: trustValue(value.trust, `${label}.trust`) }),
    ...(value.aliases === undefined ? {} : { aliases: stringArray(value.aliases, `${label}.aliases`) }),
    ...(value.capabilities === undefined ? {} : { capabilities: objectArray(value.capabilities, `${label}.capabilities`) as unknown as readonly ToolSourceCapability[] }),
  };
  if (kind === "none") return { ...common, auth: { kind } };
  if (kind === "bearer") return { ...common, auth: { kind, ...(auth.token === undefined ? {} : { token: stringValue(auth.token, `${label}.auth.token`) }) } };
  if (kind === "api_key_header") return { ...common, auth: {
    kind,
    headerName: stringValue(auth.headerName, `${label}.auth.headerName`),
    ...(auth.value === undefined ? {} : { value: stringValue(auth.value, `${label}.auth.value`) }),
  } };
  if (kind === "basic") return { ...common, auth: {
    kind,
    username: stringValue(auth.username, `${label}.auth.username`),
    ...(auth.password === undefined ? {} : { password: stringValue(auth.password, `${label}.auth.password`) }),
  } };
  if (kind === "query_parameter") return { ...common, auth: {
    kind,
    parameterName: stringValue(auth.parameterName, `${label}.auth.parameterName`),
    ...(auth.value === undefined ? {} : { value: stringValue(auth.value, `${label}.auth.value`) }),
  } };
  if (kind === "custom_headers") return { ...common, auth: {
    kind,
    ...(auth.headers === undefined ? {} : { headers: stringRecord(auth.headers, `${label}.auth.headers`) }),
    ...(auth.headerNames === undefined ? {} : { headerNames: stringArray(auth.headerNames, `${label}.auth.headerNames`) }),
  } };
  throw new Error(`${label}.auth.kind_invalid`);
}

function objectArray(value: unknown, name: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${name}_invalid`);
  return value.map((item, index) => recordValue(item, `${name}[${index}]`));
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}_invalid`);
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown, name: string): Readonly<Record<string, string>> {
  const record = recordValue(value, name);
  for (const [key, item] of Object.entries(record)) {
    if (key.length === 0 || typeof item !== "string" || item.length === 0) throw new Error(`${name}_invalid`);
  }
  return record as Readonly<Record<string, string>>;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name}_invalid`);
  return Number(value);
}

function literalHttp(value: unknown, name: string): "http" {
  if (value !== "http") throw new Error(`${name}_invalid`);
  return value;
}

function trustValue(value: unknown, name: string): "trusted" | "untrusted" {
  if (value !== "trusted" && value !== "untrusted") throw new Error(`${name}_invalid`);
  return value;
}
