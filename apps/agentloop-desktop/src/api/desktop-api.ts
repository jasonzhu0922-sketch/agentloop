import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError } from "@zhujun/agentloop";
import type { LocalRuntimeManager, ManagedLocalRuntime, LocalModelConfigurationInput, LocalExecutionContext } from "@zhujun/agentloop-local-runtime";
import { assertLoopback, assertWriteOrigin, AccountSessions, HttpError, securityHeaders } from "../security/loopback.ts";
import type { CloudAuthPort } from "../auth/cloud-auth.ts";
import { modelEndpoint } from "../security/model-endpoint.ts";
import { LocalManagementError, LocalRuntimeConfigurationStoreError, LocalRuntimeSupervisorError, type ConnectorSettingInput } from "@zhujun/agentloop-local-runtime";
import { configurationInput, mcpInput, memoryInput, storageInput, record, skillImportInput } from "./settings-input.ts";
import { DesktopAccountManagers } from "../accounts/account-managers.ts";
import { localAccountId } from "../auth/cloud-auth.ts";
import { pickNativeDirectory } from "../platform/directory-picker.ts";

export const DEFAULT_RUNTIME_ID = "desktop-default";
const MAX_BODY_BYTES = 1_500_000;

function operationRoute(request: IncomingMessage, origin: string): string | undefined {
  let pathname: string;
  try { pathname = new URL(request.url ?? "/", origin || "http://127.0.0.1").pathname; }
  catch { return undefined; }
  if (!pathname.startsWith("/api/")) return undefined;
  const [, api, resource] = pathname.split("/");
  return `/${api}/${resource ?? "unknown"}`;
}

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
async function readJson(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const body = await new Promise<Buffer>((resolve, reject) => {
    let size = 0; let rejected = false; const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) { rejected = true; chunks.length = 0; reject(new HttpError(413, "body_too_large")); }
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
  accounts?: DesktopAccountManagers;
  readonly #sessions = new AccountSessions();
  readonly #cloud?: CloudAuthPort;
  #loginInFlight = 0;
  #loginAttempts: number[] = [];
  readonly instanceId: string;
  readonly #assets: ReadonlyMap<string, StaticAsset>;
  readonly #log?: (entry: string) => void;
  private readonly pickDirectory: typeof pickNativeDirectory;
  constructor(instanceId: string, assets: ReadonlyMap<string, StaticAsset>, cloud?: CloudAuthPort, log?: (entry: string) => void, pickDirectory = pickNativeDirectory) {
    this.instanceId = instanceId; this.#assets = assets; this.#cloud = cloud; this.#log = log;
    this.pickDirectory = pickDirectory;
  }

  handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const startedAt = Date.now(), route = operationRoute(request, this.origin);
    response.once("finish", () => {
      // Keep terminal output operationally useful without writing prompts,
      // credentials, query strings, generated IDs, or response bodies.
      if (route !== undefined && (request.method !== "GET" || response.statusCode >= 400)) {
        this.#log?.(`${request.method} ${route} → ${response.statusCode} (${Date.now() - startedAt}ms)`);
      }
    });
    securityHeaders(response);
    this.activeRequests++;
    try {
      assertLoopback(request, this.origin);
      const url = new URL(request.url!, this.origin);
      if (request.method === "GET" && url.pathname === "/__desktop/instance") {
        json(response, 200, { instanceId: this.instanceId, ready: this.accounts !== undefined && !this.stopping }); return;
      }
      if (this.stopping || !this.accounts) throw new HttpError(503, "desktop_not_ready");
      const asset = this.#assets.get(url.pathname);
      if (request.method === "GET" && asset !== undefined) {
        response.writeHead(200, { "Content-Type": asset.type }); response.end(asset.content); return;
      }
      const write = request.method === "POST";
      if (write) assertWriteOrigin(request, this.origin);
      if (url.pathname === "/api/dev/session") throw new HttpError(404, "route_not_found");
      if (request.method === "GET" && url.pathname === "/api/auth/config") {
        json(response, 200, { configured: this.#cloud !== undefined, issuer: this.#cloud?.issuer }); return;
      }
      if (write && ["/api/auth/login", "/api/auth/register"].includes(url.pathname)) {
        if (!this.#cloud) throw new HttpError(503, "cloud_auth_not_configured");
        // Account switching is explicit logout + login, never a hidden mutation
        // of an existing browser capability while requests may still be active.
        let authenticated = false;
        try { this.#sessions.require(request, false); authenticated = true; } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 401) throw error;
        }
        if (authenticated) throw new HttpError(409, "logout_before_account_switch");
        const body = await readJson(request); fields(body, ["email", "password"]);
        const email = text(body, "email", 254).trim(), password = text(body, "password", 256);
        this.#loginAttempts = this.#loginAttempts.filter(time => Date.now() - time < 60_000);
        if (this.#loginInFlight >= 2 || this.#loginAttempts.length >= 10) throw new HttpError(429, "cloud_auth_rate_limited");
        this.#loginAttempts.push(Date.now()); this.#loginInFlight++;
        try {
          const cloud = await this.#cloud.authenticate(url.pathname.endsWith("register") ? "register" : "login", email, password);
          await this.accounts.forOwner(localAccountId(this.#cloud.issuer, cloud.principal));
          const session = this.#sessions.issue(response, this.#cloud.issuer, cloud);
          json(response, 200, this.sessionView(session)); return;
        } finally { this.#loginInFlight--; }
      }
      const session = this.#sessions.require(request, write);
      if (!this.#cloud) throw new HttpError(503, "cloud_auth_not_configured");
      // A locally authenticated browser must be able to end its session even
      // when cloud verification is unavailable. This token grants no access to
      // account data and remains protected by the loopback origin boundary.
      if (request.method === "GET" && url.pathname === "/api/auth/logout-token") {
        json(response, 200, { csrfToken: session.csrf }); return;
      }
      if (write && url.pathname === "/api/auth/logout") {
        fields(await readJson(request), []);
        this.#sessions.revoke(session, response);
        let cloudRevoked = true;
        try { await this.#cloud.logout(session.cloudToken); } catch { cloudRevoked = false; }
        json(response, 200, { loggedOut: true, cloudRevoked }); return;
      }
      await this.#sessions.verify(session, this.#cloud, url.pathname === "/api/session");
      if (request.method === "GET" && url.pathname === "/api/session") {
        json(response, 200, this.sessionView(session)); return;
      }
      const context = Object.freeze({ ownerUserId: session.ownerUserId });
      const manager = await this.accounts.forOwner(context.ownerUserId);
      if (await this.managementRoute(request, response, url.pathname, context.ownerUserId, manager)) return;
      const runtimeId = url.searchParams.get("runtimeId") ?? DEFAULT_RUNTIME_ID;
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(runtimeId)) throw new HttpError(400, "runtime_id_invalid");
      const runtime = manager.runtime(runtimeId);
      if (request.method === "GET" && url.pathname === "/api/device-storage") {
        json(response, 200, { storage: await manager.deviceStorageConfiguration() }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/device-storage") {
        const body = await readJson(request); fields(body, ["workspaceRoot", "uploadStorageRoot"]);
        json(response, 200, { storage: await manager.configureDeviceStorage(storageInput(body)) }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/device-storage/pick") {
        const body = await readJson(request); fields(body, ["kind"]);
        if (body.kind !== "workspace" && body.kind !== "uploads") throw new HttpError(400, "device_storage_kind_invalid");
        const selected = await this.pickDirectory();
        const current = this.#sessions.require(request, true);
        if (current !== session) throw new HttpError(401, "session_invalid");
        await this.#sessions.verify(session, this.#cloud, false);
        const path = selected ? await this.accounts.grantSelectedStorage(context.ownerUserId, selected, body.kind) : undefined;
        json(response, 200, { path: path ?? null }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/model-configuration") {
        json(response, 200, await manager.modelConfiguration()); return;
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
        try { json(response, 200, await manager.configureModels(input, text(body, "revision", 64))); }
        catch (error) { if (error instanceof TypeError) throw new HttpError(400, "model_configuration_invalid"); throw error; }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/memory-configuration") {
        json(response, 200, { memory: await manager.deviceMemoryConfiguration() }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/memory-configuration") {
        const body = await readJson(request); fields(body, ["enabled", "settlementModelKey"]);
        json(response, 200, { memory: await manager.configureDeviceMemory(memoryInput(body)) }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/models") { json(response, 200, { models: await runtime.models() }); return; }
      if (request.method === "GET" && url.pathname === "/api/conversations") { json(response, 200, { conversations: await runtime.conversations(context) }); return; }
      if (request.method === "POST" && url.pathname === "/api/runs") {
        const body = await readJson(request);
        fields(body, ["requestId", "input", "modelKey", "conversationId", "uploadedSourceIds", "connectorConnectionIds"]);
        const connections = body.connectorConnectionIds === undefined ? [] : ids(body.connectorConnectionIds);
        if (connections.length) {
          const permitted = new Set((await manager.connectors(context.ownerUserId)).filter(c => c.enabled && c.moduleAvailable).map(c => c.id));
          if (connections.some(id => !permitted.has(id))) throw new HttpError(403, "connector_connection_not_authorized");
        }
        const run = await runtime.startRun(context, { requestId: text(body, "requestId", 256), input: text(body, "input"), modelKey: text(body, "modelKey", 200),
          ...(body.conversationId === undefined ? {} : { conversationId: text(body, "conversationId", 200) }),
          uploadedSourceIds: body.uploadedSourceIds === undefined ? [] : ids(body.uploadedSourceIds),
          connectorConnectionIds: connections, allowDangerousTools: true });
        json(response, 200, { run }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/sources") {
        const body = await readJson(request); fields(body, ["conversationId", "originalName", "contentBase64"]);
        const encoded = text(body, "contentBase64", 1_400_000); const content = Buffer.from(encoded, "base64");
        if (content.length > 1_048_576 || content.toString("base64") !== encoded) throw new HttpError(400, "source_content_invalid");
        const conversationId = text(body, "conversationId", 200); const originalName = text(body, "originalName", 255);
        await runtime.ensureConversation(context, conversationId, `已上传文件：${originalName}`);
        const source = await runtime.upload(context, { conversationId, originalName, content });
        json(response, 200, { source }); return;
      }
      const parts = url.pathname.split("/").slice(1).map(part => {
        let decoded: string; try { decoded = decodeURIComponent(part); } catch { throw new HttpError(400, "path_invalid"); }
        if (!/^[a-zA-Z0-9_-]{1,200}$/.test(decoded)) throw new HttpError(400, "path_invalid"); return decoded;
      });
      if (request.method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "conversations") {
        json(response, 200, await runtime.conversation(context, parts[2]!)); return;
      }
      if (request.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "conversations" && parts[3] === "remove") {
        fields(await readJson(request), []);
        await runtime.deleteConversation(context, parts[2]!);
        json(response, 200, { removed: true }); return;
      }
      if (request.method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "sources") {
        json(response, 200, { source: await runtime.source(context, parts[2]!) }); return;
      }
      await this.runRoute(request, response, runtime, parts, url, context);
    } catch (error) {
      // Never reflect provider exceptions, paths, URLs, prompts or credentials.
      if (error instanceof HttpError) json(response, error.status, { error: error.code });
      else if (error instanceof LocalManagementError || error instanceof LocalRuntimeConfigurationStoreError || error instanceof LocalRuntimeSupervisorError) {
        json(response, error.status, { error: /^[a-z][a-z0-9_]{1,100}$/.test(error.message) ? error.message : "settings_operation_failed" });
      }
      else if (error instanceof AppError) {
        const safe = new Set(["account_storage_outside_scope", "account_data_migration_failed", "request_id_payload_conflict", "admission_outcome_unknown", "admission_run_deleted", "runtime_capacity_exhausted", "local_model_unavailable", "model_configuration_stale", "model_configuration_read_only", "model_configuration_invalid", "runtime_active_runs_prevent_reconfiguration", "runtime_operation_in_progress"]);
        json(response, error.status, { error: safe.has(error.message) ? error.message : error.code });
      } else json(response, 500, { error: "desktop_operation_failed" });
    } finally { this.activeRequests--; }
  };

  private async managementRoute(request: IncomingMessage, response: ServerResponse, path: string, owner: string, manager: LocalRuntimeManager): Promise<boolean> {
    const get = request.method === "GET", post = request.method === "POST";
    if (path === "/api/runtimes") {
      if (get) { json(response, 200, { runtimes: await manager.runtimes() }); return true; }
      if (post) { const b = await readJson(request); fields(b, ["displayName"]); json(response, 200, { runtime: await manager.createRuntime(text(b, "displayName", 100)) }); return true; }
    }
    if (get && path === "/api/skills") { json(response, 200, { skills: await manager.skillPackages() }); return true; }
    if (post && path === "/api/skills/import") { json(response, 200, { skills: await manager.importSkills(skillImportInput(await readJson(request, 46 * 1024 * 1024))) }); return true; }
    if (path === "/api/mcp") {
      if (get) { json(response, 200, { servers: await manager.deviceMcpServers() }); return true; }
      if (post) { const b = await readJson(request); fields(b, ["server"]); json(response, 200, { server: await manager.configureDeviceMcpServer(mcpInput(b.server)) }); return true; }
    }
    if (post && path === "/api/mcp/test") { const b = await readJson(request); fields(b, ["server"]); json(response, 200, await manager.testDeviceMcpServer(mcpInput(b.server))); return true; }
    const deviceMcp = /^\/api\/mcp\/([a-zA-Z0-9_-]{1,200})\/(remove|test)$/.exec(path);
    if (deviceMcp && post) {
      const [, id, action] = deviceMcp;
      const b = await readJson(request);
      if (action === "remove") { fields(b, []); await manager.removeDeviceMcpServer(id!); json(response, 200, { removed: true }); return true; }
      fields(b, ["server"]); json(response, 200, await manager.testDeviceMcpServer(mcpInput({ ...(record(b.server, ["id", "displayName", "key", "transport", "url", "protocolVersion", "timeoutMs", "auth", "toolAllowlist", "toolBlocklist", "trust", "aliases", "capabilities"])), id }))); return true;
    }
    const skill = /^\/api\/skills\/([a-zA-Z0-9_-]{1,200})\/metadata$/.exec(path);
    if (skill) {
      if (get) { json(response, 200, await manager.skillMetadata(skill[1]!)); return true; }
      if (post) { const b = await readJson(request); fields(b, ["declaration"]); json(response, 200, await manager.updateSkillMetadata(skill[1]!, b.declaration)); return true; }
    }
    if (get && path === "/api/connectors/catalog") { json(response, 200, { connectors: await manager.connectorCatalog() }); return true; }
    if (path === "/api/connectors") {
      if (get) { json(response, 200, { connections: await manager.connectors(owner) }); return true; }
      if (post) { const b = await readJson(request); fields(b, ["connector"]); const c = record(b.connector, ["id", "connectorKey", "displayName", "enabled", "scopes", "credentials"]); json(response, 200, await manager.configureConnector(owner, c as unknown as ConnectorSettingInput)); return true; }
    }
    const connectorRemoval = /^\/api\/connectors\/([a-zA-Z0-9_-]{1,200})\/remove$/.exec(path);
    if (connectorRemoval && post) { const b = await readJson(request); fields(b, []); json(response, 200, await manager.removeConnector(owner, connectorRemoval[1]!)); return true; }
    const match = /^\/api\/runtimes\/([a-zA-Z0-9_-]{1,200})\/(configuration|start|stop|drain|restart|rename|remove|mcp\/test)$/.exec(path);
    if (!match) return false;
    const id = match[1]!, action = match[2]!;
    if (!(await manager.runtimes()).some(runtime => runtime.id === id)) throw new HttpError(404, "runtime_not_found");
    if (action === "configuration") {
      if (get) { json(response, 200, await manager.runtimeSettings(id)); return true; }
      if (post) { const b = await readJson(request); fields(b, ["configuration", "revision"]); await manager.configureRuntime(id, configurationInput(b.configuration), text(b, "revision", 64)); json(response, 200, await manager.runtimeSettings(id)); return true; }
    }
    if (post) {
      const b = await readJson(request);
      if (action === "mcp/test") { fields(b, ["server"]); json(response, 200, await manager.testMcpServer(id, mcpInput(b.server))); return true; }
      if (action === "rename") { fields(b, ["displayName"]); json(response, 200, { runtime: await manager.renameRuntime(id, text(b, "displayName", 100)) }); return true; }
      fields(b, []);
      switch (action) {
        case "start": json(response, 200, { runtime: await manager.startRuntime(id) }); break;
        case "stop": json(response, 200, { runtime: await manager.stopRuntime(id) }); break;
        case "drain": json(response, 200, { runtime: await manager.drainRuntime(id) }); break;
        case "restart": json(response, 200, { runtime: await manager.restartRuntime(id) }); break;
        case "remove": json(response, 200, await manager.removeRuntime(id)); break;
        default: return false;
      }
      return true;
    }
    return false;
  }

  private sessionView(session: ReturnType<AccountSessions["require"]>) {
    return { mode: "cloud", user: { id: session.principal.userId, email: session.principal.email }, tenant: { id: session.principal.tenantId },
      accountId: session.ownerUserId, csrfToken: session.csrf, expiresAt: session.expiresAt,
      migration: this.accounts?.migration(session.ownerUserId) };
  }
  private async runRoute(request: IncomingMessage, response: ServerResponse, runtime: ManagedLocalRuntime, parts: string[], url: URL, context: LocalExecutionContext) {
    if (parts[0] !== "api" || parts[1] !== "runs" || !parts[2]) throw new HttpError(404, "route_not_found");
    const id = parts[2];
    if (request.method === "GET" && parts.length === 5 && parts[3] === "human-loop" && parts[4] === "current") {
      json(response, 200, { request: await runtime.currentHumanLoop(context, id) }); return;
    }
    if (request.method === "POST" && parts.length === 6 && parts[3] === "human-loop" && parts[5] === "respond") {
      const body = await readJson(request); fields(body, ["value", "expectedRevision"]);
      if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) throw new HttpError(400, "expected_revision_invalid");
      if (!Object.hasOwn(body, "value")) throw new HttpError(400, "value_required");
      json(response, 200, { response: await runtime.respondHumanLoop(context, id, parts[4]!, body.value, body.expectedRevision as number) }); return;
    }
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
    if (request.method === "GET" && parts.length === 6 && parts[3] === "artifacts" && parts[5] === "preview") {
      json(response, 200, await runtime.previewArtifact(context, id, parts[4]!)); return;
    }
    if (request.method === "GET" && parts.length === 6 && parts[3] === "artifacts" && parts[5] === "content") {
      const { artifact, content } = await runtime.readArtifact(context, id, parts[4]!);
      // HTML gets an opaque sandbox origin even when opened directly. Its own
      // inline styles/scripts can render, but cannot access Desktop or its API.
      response.writeHead(200, { "Content-Type": artifact.mimeType, "Content-Disposition": "inline",
        "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'" });
      response.end(content); return;
    }
    if (request.method === "GET" && parts.length === 6 && parts[3] === "artifacts" && parts[5] === "download") {
      const { artifact, content } = await runtime.readArtifact(context, id, parts[4]!);
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        "Content-Security-Policy": "sandbox; default-src 'none'" }); response.end(content); return;
    }
    throw new HttpError(404, "route_not_found");
  }
  clearSessions(): void { this.#sessions.clear(); }
}
