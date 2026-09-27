import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { hostname } from "node:os";
import { AppDatabase, LlmProviderRegistry, RunService, SkillService, createStepExecutionStrategyProfile, createWebTools } from "@zhujun/agentloop";
import { bundledSkillDirectories } from "@zhujun/agentloop-skills";
import { loadSkillDirectoriesConfig, loadStepExecutionStrategyProfileConfig, mergeSkillDirectories, webToolsOptionsFromEnvironment } from "../../src/config/config.ts";
import { LocalDirectoryScopeStore } from "./local-directory-scope-store.ts";
import { RuntimeConnectionClient } from "./runtime-connection-client.ts";
import { LocalRuntimeSupervisor, LocalRuntimeSupervisorError, type LocalRuntimeControl, type LocalRuntimeDefinition } from "./local-runtime-supervisor.ts";
import { pickNativeDirectory } from "./native-directory-picker.ts";

interface LocalAgentState {
  readonly deviceIdentity: { readonly publicKey: string; readonly privateKey: string };
  readonly defaultRuntimeId: string;
  readonly sharedStorageRoot?: string;
  readonly uploadStorageRoot?: string;
  readonly device?: { readonly id: string; readonly agentToken: string; readonly displayName: string };
}

export const LOCAL_AGENT_VERSION = "0.1.0";
export const LOCAL_AGENT_PROTOCOL_VERSION = "1";

export interface LocalAgentServerOptions {
  readonly appRoot: string;
  readonly routerUrl?: string;
  readonly statePath: string;
  readonly databasePath: string;
  readonly workspaceRoot: string;
  readonly skillPackageStoreRoot: string;
  readonly runtimeDataRoot?: string;
  readonly supervisorDatabasePath?: string;
  readonly providerConfigPath: string;
  readonly skillDirectoriesConfigPath: string;
  readonly stepExecutionStrategyConfigPath: string;
  /** Deployment-owned non-secret paths passed only to local Skill commands. */
  readonly computerCommandEnvironment?: Readonly<Record<string, string>>;
  /** Device-owned model and integration settings; never passed to Skill commands. */
  readonly integrationEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly webOrigin?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly directoryPicker?: () => Promise<string | undefined>;
  /** Device-local observability only. Event data never crosses the Router. */
  readonly runEventLogSink?: (runtime: LocalRuntimeDefinition, line: string) => void;
}

/** Loopback device Agent. Router control and strict-local data are separate planes. */
export async function createLocalAgentServer(input: LocalAgentServerOptions): Promise<Server> {
  let state = await readState(input.statePath);
  let sharedStorageRoot = resolve(state.sharedStorageRoot ?? input.workspaceRoot);
  let uploadStorageRoot = resolve(state.uploadStorageRoot ?? join(dirname(input.databasePath), "uploads"));
  if (state.sharedStorageRoot === undefined || state.uploadStorageRoot === undefined) {
    state = { ...state, sharedStorageRoot, uploadStorageRoot };
    await writeState(input.statePath, state);
  }
  await mkdir(sharedStorageRoot, { recursive: true });
  await mkdir(uploadStorageRoot, { recursive: true });
  // The Local Runtime Agent is device-local by contract. These constructors
  // select the SQLite-only AppDatabase path and must never be replaced with
  // openStateDatabase(), which is reserved for Router/cloud Host shared state.
  const supervisorDatabase = new AppDatabase(input.supervisorDatabasePath ?? join(dirname(input.databasePath), "supervisor.db"));
  const supervisor = new LocalRuntimeSupervisor(
    supervisorDatabase,
    (definition) => createLocalRuntime(input, definition, sharedStorageRoot, uploadStorageRoot),
    async (definition) => {
      const runtimeRoot = runtimeRootFor(input, definition);
      if (runtimeRoot !== undefined) await rm(runtimeRoot, { recursive: true, force: true });
      const uploadRoot = runtimeUploadRootFor(definition, uploadStorageRoot);
      if (uploadRoot !== undefined) await rm(uploadRoot, { recursive: true, force: true });
    },
  );
  await supervisor.ready(state.defaultRuntimeId);
  const picker = input.directoryPicker ?? pickNativeDirectory;
  let connection: RuntimeConnectionClient | undefined;
  const agentControl = async (method: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (method === "agent.status") {
      const latest = await readState(input.statePath);
      return agentStatus(latest, supervisor, sharedStorageRoot, uploadStorageRoot, connection?.isConnected() ?? false, input.routerUrl);
    }
    if (method === "agent.runtimes.list") return { runtimes: await supervisor.list() };
    if (method === "agent.runtimes.create") return { runtime: await supervisor.create(stringValue(payload.displayName, "displayName")) };
    if (method === "agent.runtimes.rename") return { runtime: await supervisor.rename(stringValue(payload.runtimeId, "runtimeId"), stringValue(payload.displayName, "displayName")) };
    if (method === "agent.runtimes.remove") return await supervisor.remove(stringValue(payload.runtimeId, "runtimeId"));
    if (method === "agent.runtimes.lifecycle") {
      const action = stringValue(payload.action, "action");
      if (action !== "drain" && action !== "restart" && action !== "stop" && action !== "start") throw new LocalRuntimeSupervisorError(400, "runtime_lifecycle_action_invalid");
      return { runtime: await supervisor[action](stringValue(payload.runtimeId, "runtimeId")) };
    }
    if (method === "agent.config.get") return {
      agentVersion: LOCAL_AGENT_VERSION, protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
      router: { configured: input.routerUrl !== undefined, ...(input.routerUrl === undefined ? {} : { url: input.routerUrl }) },
      sharedStorage: { path: sharedStorageRoot, displayName: basename(sharedStorageRoot) },
      uploadStorage: { path: uploadStorageRoot, displayName: basename(uploadStorageRoot) },
      skillLoading: { mode: "runtime_startup", packageStoreRoot: input.skillPackageStoreRoot },
    };
    if (method === "agent.config.sharedStorage.pick") {
      if (supervisor.hasActiveWork()) throw new LocalRuntimeSupervisorError(409, "runtime_active_runs_prevent_storage_change");
      const path = await picker();
      if (path === undefined) return { cancelled: true };
      const nextRoot = resolve(path);
      await mkdir(nextRoot, { recursive: true });
      const previousRoot = sharedStorageRoot;
      sharedStorageRoot = nextRoot;
      try {
        await supervisor.reloadRunningInstances();
        const latest = await readState(input.statePath);
        state = { ...latest, sharedStorageRoot: nextRoot };
        await writeState(input.statePath, state);
      } catch (error) {
        sharedStorageRoot = previousRoot;
        await supervisor.reloadRunningInstances().catch(() => undefined);
        throw error;
      }
      return { sharedStorage: { path: sharedStorageRoot, displayName: basename(sharedStorageRoot) } };
    }
    if (method === "agent.config.uploadStorage.pick") {
      if (supervisor.hasActiveWork()) throw new LocalRuntimeSupervisorError(409, "runtime_active_runs_prevent_storage_change");
      const path = await picker();
      if (path === undefined) return { cancelled: true };
      const nextRoot = resolve(path);
      await mkdir(nextRoot, { recursive: true });
      const previousRoot = uploadStorageRoot;
      uploadStorageRoot = nextRoot;
      try {
        await supervisor.reloadRunningInstances();
        const latest = await readState(input.statePath);
        state = { ...latest, uploadStorageRoot: nextRoot };
        await writeState(input.statePath, state);
      } catch (error) {
        uploadStorageRoot = previousRoot;
        await supervisor.reloadRunningInstances().catch(() => undefined);
        throw error;
      }
      return { uploadStorage: { path: uploadStorageRoot, displayName: basename(uploadStorageRoot) } };
    }
    if (method === "agent.reconnect") {
      connection?.reconnectNow();
      return { accepted: true };
    }
    throw new LocalAgentError(404, "agent_control_method_not_found");
  };
  const liveConnection = new RuntimeConnectionClient(input.routerUrl, supervisor, agentControl);
  connection = liveConnection;
  await liveConnection.ready();
  if (state.device !== undefined) liveConnection.setDevice(state.device);

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (originAllowed(origin, input.webOrigin)) response.setHeader("access-control-allow-origin", origin!);
    response.setHeader("vary", "origin");
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type, x-local-session");
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://local-agent");
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        const latest = await readState(input.statePath);
        return json(response, 200, await agentStatus(latest, supervisor, sharedStorageRoot, uploadStorageRoot, connection?.isConnected() ?? false, input.routerUrl));
      }
      if (request.method === "POST" && url.pathname === "/v1/device-registration") {
        if (!originAllowed(origin, input.webOrigin)) return json(response, 403, { error: "local_agent_origin_denied" });
        if (input.routerUrl === undefined) throw new LocalAgentError(409, "local_agent_router_not_configured");
        const registrationToken = stringValue((await body(request)).registrationToken, "registrationToken");
        const latest = await readState(input.statePath);
        if (latest.device !== undefined) return json(response, 200, { device: { id: latest.device.id, displayName: latest.device.displayName, status: "active" }, alreadyRegistered: true });
        const displayName = `Local Runtime · ${hostname()}`;
        const result = await fetch(new URL("/v1/device-agent/register", input.routerUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ registrationToken, displayName, publicKey: latest.deviceIdentity.publicKey }) });
        const registered = await result.json().catch(() => ({}));
        if (!result.ok || typeof registered.agentToken !== "string" || typeof registered.device?.id !== "string") throw new Error(typeof registered.error === "string" ? registered.error : `Router HTTP ${result.status}`);
        await writeState(input.statePath, { ...latest, device: { id: registered.device.id, agentToken: registered.agentToken, displayName: registered.device.displayName } });
        connection.setDevice({ id: registered.device.id, agentToken: registered.agentToken });
        return json(response, 201, { device: registered.device, alreadyRegistered: false });
      }

      if (request.method === "GET" && url.pathname === "/v1/directory-scopes") {
        await authorize(request, input);
        const runtime = runtimeFromQuery(supervisor, url);
        return json(response, 200, { runtimeId: runtime.id, scopes: await runtime.scopes.list() });
      }
      if (request.method === "POST" && url.pathname === "/v1/directory-scopes/pick") {
        await authorize(request, input);
        const runtime = supervisor.runtime(stringValue((await body(request)).runtimeId, "runtimeId"), true);
        const path = await picker();
        if (path === undefined) return json(response, 200, { cancelled: true });
        return json(response, 201, { runtimeId: runtime.id, scope: await runtime.scopes.create(path, basename(path)) });
      }
      const revokeScope = url.pathname.match(/^\/v1\/directory-scopes\/([^/]+)\/revoke$/);
      if (request.method === "POST" && revokeScope !== null) {
        await authorize(request, input);
        const value = await body(request);
        await supervisor.runtime(stringValue(value.runtimeId, "runtimeId")).scopes.revoke(decodeURIComponent(revokeScope[1]));
        return json(response, 204, undefined);
      }

      // A local upload is a Runtime-owned immutable Source, not a directory
      // grant and not a Router attachment. Its bytes stay on this device.
      if (request.method === "POST" && url.pathname === "/v1/uploads") {
        const session = await authorize(request, input);
        const value = await body(request);
        const runtime = supervisor.runtime(stringValue(value.runtimeId, "runtimeId"), true);
        const conversationId = stringValue(value.conversationId, "conversationId");
        const originalName = stringValue(value.originalName, "originalName");
        const content = base64Content(value.contentBase64);
        await runtime.runs.ensureConversation(session.ownerUserId, conversationId, `已上传文件：${originalName}`);
        const source = await runtime.runs.uploadSource(session.ownerUserId, {
          conversationId,
          originalName,
          ...(value.mediaType === undefined ? {} : { mimeType: stringValue(value.mediaType, "mediaType") }),
          content,
        });
        return json(response, 201, { runtimeId: runtime.id, source });
      }

      const localConversationMatch = url.pathname.match(/^\/v1\/local-runtimes\/([^/]+)\/conversations\/([^/]+)$/);
      if (request.method === "DELETE" && localConversationMatch !== null) {
        const session = await authorize(request, input);
        const runtime = supervisor.runtime(decodeURIComponent(localConversationMatch[1]));
        await runtime.runs.deleteConversation(session.ownerUserId, decodeURIComponent(localConversationMatch[2]));
        return json(response, 204, undefined);
      }

      if (request.method === "POST" && url.pathname === "/v1/strict-local-runs") {
        const session = await authorize(request, input);
        const value = await body(request);
        const runtimeId = stringValue(value.runtimeId, "runtimeId");
        const conversationId = stringValue(value.conversationId, "conversationId");
        const clientMessageId = stringValue(value.clientMessageId, "clientMessageId");
        const inputText = stringValue(value.input, "input");
        const dispatchId = `strict:${session.ownerUserId}:${clientMessageId}`;
        const currentRuntime = supervisor.runtime(runtimeId);
        const existing = await currentRuntime.database.prepare("SELECT remote_run_id FROM local_runtime_dispatches WHERE dispatch_key = ? AND owner_user_id = ?")
          .get(dispatchId, session.ownerUserId) as { remote_run_id: string } | undefined;
        if (existing !== undefined) {
          const run = await currentRuntime.runs.get(session.ownerUserId, existing.remote_run_id);
          return json(response, 200, { runtimeId: currentRuntime.id, run: toStatus(run), replayed: true });
        }
        const result = await supervisor.admitRun(runtimeId, async (runtime) => {
          const visibleDirectories = await runtime.scopes.paths(stringArray(value.localDirectoryScopeIds ?? [], "localDirectoryScopeIds"));
          await runtime.runs.ensureConversation(session.ownerUserId, conversationId, inputText);
          const run = await runtime.runs.startConversation(session.ownerUserId, inputText, {
            conversationId, visibleDirectories, sourceIds: stringArray(value.localUploadedSourceIds ?? [], "localUploadedSourceIds"), allowDangerousTools: value.allowDangerousTools !== false,
            ...(value.requestedModelKey === undefined ? {} : { modelKey: stringValue(value.requestedModelKey, "requestedModelKey") }),
          });
          await runtime.database.prepare(`
            INSERT INTO local_runtime_dispatches(dispatch_key, assignment_id, owner_user_id, remote_run_id, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(dispatchId, dispatchId, session.ownerUserId, run.id, Date.now());
          return { runId: run.id, value: { runtimeId: runtime.id, run: toStatus(run) } };
        });
        return json(response, 202, result);
      }
      const strictRunMatch = url.pathname.match(/^\/v1\/strict-local-runs\/([^/]+)\/([^/]+)$/);
      if (request.method === "GET" && strictRunMatch !== null) {
        const session = await authorize(request, input);
        const runtime = supervisor.runtime(decodeURIComponent(strictRunMatch[1]));
        const run = await runtime.runs.get(session.ownerUserId, decodeURIComponent(strictRunMatch[2]));
        if (run.status !== "running") await supervisor.runSettled(runtime.id, run.id);
        return json(response, 200, { runtimeId: runtime.id, run: toStatus(run) });
      }
      const strictEventsMatch = url.pathname.match(/^\/v1\/strict-local-runs\/([^/]+)\/([^/]+)\/events$/);
      if (request.method === "GET" && strictEventsMatch !== null) {
        const session = await authorize(request, input);
        const runtime = supervisor.runtime(decodeURIComponent(strictEventsMatch[1]));
        const events = await runtime.runs.events(session.ownerUserId, decodeURIComponent(strictEventsMatch[2]));
        const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0);
        return json(response, 200, { events: events.filter((event) => event.seq > afterSeq) });
      }
      const strictCancelMatch = url.pathname.match(/^\/v1\/strict-local-runs\/([^/]+)\/([^/]+)\/cancel$/);
      if (request.method === "POST" && strictCancelMatch !== null) {
        const session = await authorize(request, input);
        const runtime = supervisor.runtime(decodeURIComponent(strictCancelMatch[1]));
        const run = await runtime.runs.cancel(session.ownerUserId, decodeURIComponent(strictCancelMatch[2]));
        await supervisor.runSettled(runtime.id, run.id);
        return json(response, 200, { runtimeId: runtime.id, run: toStatus(run) });
      }

      const artifactsMatch = url.pathname.match(/^\/v1\/local-runtimes\/([^/]+)\/runs\/([^/]+)\/artifacts$/);
      if (request.method === "GET" && artifactsMatch !== null) {
        const session = await authorize(request, input);
        const runtime = supervisor.runtime(decodeURIComponent(artifactsMatch[1]));
        const artifacts = await runtime.runs.processArtifacts(session.ownerUserId, decodeURIComponent(artifactsMatch[2]));
        return json(response, 200, { artifacts: artifacts.map((artifact) => ({ ...artifact, path: `local-artifact:${artifact.id}`, location: "local" })) });
      }
      const previewMatch = url.pathname.match(/^\/v1\/local-runtimes\/([^/]+)\/runs\/([^/]+)\/artifacts\/([^/]+)\/preview$/);
      if (request.method === "GET" && previewMatch !== null) {
        const session = await authorize(request, input);
        const runtime = supervisor.runtime(decodeURIComponent(previewMatch[1]));
        return json(response, 200, await runtime.runs.previewProcessArtifact(session.ownerUserId, decodeURIComponent(previewMatch[2]), decodeURIComponent(previewMatch[3])));
      }
      const artifactMatch = url.pathname.match(/^\/v1\/local-runtimes\/([^/]+)\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
      if (request.method === "GET" && artifactMatch !== null) {
        const session = await authorize(request, input);
        const runtime = supervisor.runtime(decodeURIComponent(artifactMatch[1]));
        const artifact = await runtime.runs.readProcessArtifact(session.ownerUserId, decodeURIComponent(artifactMatch[2]), decodeURIComponent(artifactMatch[3]));
        response.statusCode = 200;
        response.setHeader("content-type", artifact.artifact.mimeType || "application/octet-stream");
        response.setHeader("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(artifact.artifact.name)}`);
        response.end(Buffer.from(artifact.content));
        return;
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      const status = error instanceof LocalAgentError || error instanceof LocalRuntimeSupervisorError ? error.status : 400;
      return json(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.on("close", () => { connection?.stop(); void supervisor.close(); });
  return server;
}

async function createLocalRuntime(input: LocalAgentServerOptions, definition: LocalRuntimeDefinition, sharedStorageRoot: string, uploadStorageRoot: string): Promise<LocalRuntimeControl> {
  const environment = input.environment ?? process.env;
  const integrationEnvironment = input.integrationEnvironment ?? {};
  const runtimeRoot = runtimeRootFor(input, definition) ?? dirname(input.databasePath);
  const databasePath = definition.isDefault ? input.databasePath : join(runtimeRoot, "agentloop.db");
  // Both roots are device-level settings. Runtime identity namespaces the
  // upload root only for authorization and child-data reclamation.
  const sourceStorageRoot = runtimeUploadRootFor(definition, uploadStorageRoot)!;
  const workspaceRoot = sharedStorageRoot;
  await mkdir(dirname(databasePath), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(input.skillPackageStoreRoot, { recursive: true });
  const database = new AppDatabase(databasePath);
  await database.exec(`
    CREATE TABLE IF NOT EXISTS local_runtime_dispatches (
      dispatch_key TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      remote_run_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS local_runtime_dispatches_run_idx ON local_runtime_dispatches(remote_run_id);
  `);
  const scopes = new LocalDirectoryScopeStore(database);
  await scopes.ready();
  const provider = await LlmProviderRegistry.fromConfigFile(input.providerConfigPath, integrationEnvironment);
  const custom = await loadSkillDirectoriesConfig({ appRoot: input.appRoot, configPath: input.skillDirectoriesConfigPath });
  const packagedSkillDirectories = environment.AGENTLOOP_BUNDLED_SKILL_DIRECTORIES?.split(",").map((path) => path.trim()).filter(Boolean);
  const skills = new SkillService(database, {
    packageStoreRoot: input.skillPackageStoreRoot,
    skillDirectories: mergeSkillDirectories(packagedSkillDirectories?.length ? packagedSkillDirectories : bundledSkillDirectories(), custom),
  });
  await skills.syncSkillDirectories();
  const strategyConfig = await loadStepExecutionStrategyProfileConfig(input.stepExecutionStrategyConfigPath);
  const runs = new RunService({
    database, skills, modelFactory: (onRetry, modelKey) => provider.create(modelKey, onRetry),
    defaultModelKey: provider.defaultModelKey, modelKeys: provider.modelKeys(), workspaceRoot, sourceStorageRoot,
    ownerScopedWorkspace: true,
    stepExecutionStrategy: createStepExecutionStrategyProfile(strategyConfig.profile, strategyConfig.projection),
    tools: integrationEnvironment.WEB_SEARCH_DISABLED === "1" ? [] : createWebTools(webToolsOptionsFromEnvironment(integrationEnvironment)),
    computerCommandEnvironment: input.computerCommandEnvironment,
    ...(input.runEventLogSink === undefined ? {} : { runEventLogSink: (line) => input.runEventLogSink!(definition, line) }),
  });
  const activeRunIds = new Set<string>();
  const dispatched = await database.prepare("SELECT owner_user_id, remote_run_id FROM local_runtime_dispatches").all() as Array<{ owner_user_id: string; remote_run_id: string }>;
  for (const row of dispatched) {
    try { if ((await runs.get(row.owner_user_id, row.remote_run_id)).status === "running") activeRunIds.add(row.remote_run_id); }
    catch { /* Orphaned ledger rows are not active admissions. */ }
  }
  return { ...definition, database, scopes, runs, modelKeys: provider.modelKeys(), activeRunIds };
}

/** Returns only the dedicated child-Runtime root; the default owns device data. */
function runtimeRootFor(input: LocalAgentServerOptions, definition: LocalRuntimeDefinition): string | undefined {
  if (definition.isDefault) return undefined;
  const dataRoot = resolve(input.runtimeDataRoot ?? join(dirname(input.databasePath), "runtimes"));
  const runtimeRoot = resolve(dataRoot, definition.storageKey);
  const suffix = relative(dataRoot, runtimeRoot);
  if (suffix === "" || suffix === ".." || suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new LocalRuntimeSupervisorError(500, "runtime_storage_key_outside_data_root");
  }
  return runtimeRoot;
}

function runtimeUploadRootFor(definition: LocalRuntimeDefinition, uploadStorageRoot: string): string | undefined {
  if (definition.isDefault) return resolve(uploadStorageRoot, definition.storageKey);
  const root = resolve(uploadStorageRoot);
  const target = resolve(root, definition.storageKey);
  const suffix = relative(root, target);
  if (suffix === "" || suffix === ".." || suffix.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`)) {
    throw new LocalRuntimeSupervisorError(500, "runtime_upload_storage_key_outside_root");
  }
  return target;
}

async function authorize(request: IncomingMessage, input: LocalAgentServerOptions): Promise<{ readonly ownerUserId: string }> {
  if (!originAllowed(request.headers.origin, input.webOrigin)) throw new LocalAgentError(403, "local_agent_origin_denied");
  const sessionToken = request.headers["x-local-session"];
  if (typeof sessionToken !== "string" || sessionToken.length < 32) throw new LocalAgentError(401, "local_session_required");
  const state = await readState(input.statePath);
  if (state.device === undefined) throw new LocalAgentError(409, "device_not_registered");
  const result = await fetch(new URL("/v1/device-agent/authorize-session", input.routerUrl), { method: "POST", headers: { authorization: `Bearer ${state.device.agentToken}`, "content-type": "application/json" }, body: JSON.stringify({ sessionToken }) });
  const value = await result.json().catch(() => ({}));
  if (!result.ok || typeof value.session?.ownerUserId !== "string") throw new LocalAgentError(result.status === 401 ? 401 : 409, typeof value.error === "string" ? value.error : "local_session_invalid");
  return { ownerUserId: value.session.ownerUserId };
}

function runtimeFromQuery(supervisor: LocalRuntimeSupervisor, url: URL): LocalRuntimeControl {
  const runtimeId = url.searchParams.get("runtimeId");
  if (runtimeId === null) throw new LocalRuntimeSupervisorError(400, "runtimeId_required");
  return supervisor.runtime(runtimeId);
}

async function agentStatus(state: LocalAgentState, supervisor: LocalRuntimeSupervisor, sharedStorageRoot: string, uploadStorageRoot: string, routerConnected: boolean, routerUrl: string | undefined) {
  return {
    status: "ready",
    agentVersion: LOCAL_AGENT_VERSION,
    protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
    deviceId: state.device?.id,
    runtimeId: state.defaultRuntimeId,
    runtimes: await supervisor.list(),
    registered: state.device !== undefined,
    routerConnected,
    router: { configured: routerUrl !== undefined, ...(routerUrl === undefined ? {} : { url: routerUrl }) },
    displayName: state.device?.displayName,
    sharedStorage: { configured: true, displayName: basename(sharedStorageRoot) },
    uploadStorage: { configured: true, displayName: basename(uploadStorageRoot) },
  };
}

function toStatus(run: { readonly id: string; readonly status: "running" | "completed" | "failed" | "cancelled"; readonly modelKey?: string; readonly output?: string; readonly errorCode?: string; readonly finishedAt?: number }) {
  return { remoteRunId: run.id, status: run.status, ...(run.modelKey === undefined ? {} : { modelKey: run.modelKey }), ...(run.output === undefined ? {} : { output: run.output }), ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }), ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }) };
}

async function readState(statePath: string): Promise<LocalAgentState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Omit<LocalAgentState, "defaultRuntimeId"> & { defaultRuntimeId?: string; runtimeId?: string };
    if (parsed.defaultRuntimeId !== undefined) return parsed as LocalAgentState;
    const migrated: LocalAgentState = { ...parsed, defaultRuntimeId: parsed.runtimeId ?? `local_runtime_${randomUUID()}` };
    await writeState(statePath, migrated);
    return migrated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const pair = generateKeyPairSync("ed25519");
    const state: LocalAgentState = {
      defaultRuntimeId: `local_runtime_${randomUUID()}`,
      deviceIdentity: { publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    };
    await writeState(statePath, state);
    return state;
  }
}

async function writeState(statePath: string, state: LocalAgentState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const pending = `${statePath}.${randomUUID()}.tmp`;
  await writeFile(pending, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  await chmod(pending, 0o600);
  await rename(pending, statePath);
  await chmod(statePath, 0o600);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request_body_invalid");
  return parsed as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string { if (typeof value !== "string" || value.length === 0 || value.length > 200_000) throw new Error(`${name}_invalid`); return value; }
function stringArray(value: unknown, name: string): readonly string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new Error(`${name}_invalid`); return value as string[]; }
function base64Content(value: unknown): Buffer {
  // 25 MiB is the same source intake limit. Decode strictly so malformed data
  // cannot be silently changed before the Runtime hashes and stores it.
  const maxEncodedLength = Math.ceil((25 * 1024 * 1024) / 3) * 4;
  if (typeof value !== "string" || value.length === 0 || value.length > maxEncodedLength || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new LocalAgentError(400, "contentBase64_invalid");
  }
  const content = Buffer.from(value, "base64");
  if (content.length === 0 || content.length > 25 * 1024 * 1024) throw new LocalAgentError(400, "contentBase64_invalid");
  return content;
}
function json(response: ServerResponse, status: number, value: unknown): void { response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8"); response.end(value === undefined ? "" : JSON.stringify(value)); }
function originAllowed(origin: string | undefined, configured: string | undefined): boolean { return origin !== undefined && configured !== undefined && configured.split(",").map((value) => value.trim()).includes(origin); }
class LocalAgentError extends Error { readonly status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
