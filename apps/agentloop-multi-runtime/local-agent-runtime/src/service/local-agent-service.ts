import { basename, dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { mkdir, readFile, rm } from "node:fs/promises";
import { AppDatabase, loadMcpToolsFromConfig, parseMcpServersConfig, type McpServerRegistration, type McpServersConfig } from "@zhujun/agentloop";
import type { LocalAgentOptions } from "../config/local-agent-options.ts";
import { LocalRuntimeFactory, redactMcpDiagnostic } from "./local-runtime-factory.ts";
import { LocalRuntimeSupervisor, LocalRuntimeSupervisorError, type LocalRuntimeControl, type LocalRuntimeDefinition } from "./runtime-supervisor.ts";
import { RuntimeConnectionClient } from "../connection/router-runtime-control-client.ts";
import { pickNativeDirectory } from "../infrastructure/native-directory-picker.ts";
import { LocalAgentStateStore, type LocalAgentState } from "../persistence/local-agent-state-store.ts";
import { LocalRuntimeConfigurationStore, type LocalRuntimeConfigurationInput, type LocalRuntimeMcpServerInput } from "../persistence/local-runtime-configuration-store.ts";
import { LocalModelConfigurationStore, type LocalModelConfigurationInput } from "../persistence/local-model-configuration-store.ts";
import { EncryptedLocalRuntimeSecretStore } from "../persistence/encrypted-local-runtime-secret-store.ts";
import { loadSkillDirectoriesConfig } from "../../../src/shared/config.ts";
import { LocalSkillPackageInstaller, type LocalSkillUploadFile } from "./local-skill-package-installer.ts";
import { LOCAL_AGENT_VERSION } from "../config/local-agent-version.ts";

export { LOCAL_AGENT_VERSION };
export const LOCAL_AGENT_PROTOCOL_VERSION = "1";

export class LocalAgentApplicationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface LocalSession { readonly ownerUserId: string; }

/** Local Agent use cases and composition root. HTTP only decodes and encodes these operations. */
export class LocalAgentService {
  private connection?: RuntimeConnectionClient;
  private readonly input: LocalAgentOptions;
  private readonly stateStore: LocalAgentStateStore;
  private readonly supervisor: LocalRuntimeSupervisor;
  private readonly configurations: LocalRuntimeConfigurationStore;
  private readonly modelConfigurations: LocalModelConfigurationStore;
  private modelConfigurationUpdate: Promise<unknown> = Promise.resolve();
  private readonly skillPackageInstaller: LocalSkillPackageInstaller;
  private readonly picker: () => Promise<string | undefined>;
  private readonly sharedStorageRoot: { value: string };
  private readonly uploadStorageRoot: { value: string };
  private constructor(
    input: LocalAgentOptions, stateStore: LocalAgentStateStore,
    supervisor: LocalRuntimeSupervisor, configurations: LocalRuntimeConfigurationStore, modelConfigurations: LocalModelConfigurationStore, skillPackageInstaller: LocalSkillPackageInstaller, picker: () => Promise<string | undefined>,
    sharedStorageRoot: { value: string }, uploadStorageRoot: { value: string },
  ) {
    this.input = input; this.stateStore = stateStore;
    this.supervisor = supervisor; this.configurations = configurations; this.modelConfigurations = modelConfigurations; this.skillPackageInstaller = skillPackageInstaller; this.picker = picker; this.sharedStorageRoot = sharedStorageRoot; this.uploadStorageRoot = uploadStorageRoot;
  }

  static async create(input: LocalAgentOptions): Promise<LocalAgentService> {
    const stateStore = new LocalAgentStateStore(input.statePath);
    let state = await stateStore.read();
    const sharedStorageRoot = { value: resolve(state.sharedStorageRoot ?? input.workspaceRoot) };
    const uploadStorageRoot = { value: resolve(state.uploadStorageRoot ?? join(dirname(input.databasePath), "uploads")) };
    if (state.sharedStorageRoot === undefined || state.uploadStorageRoot === undefined) {
      state = { ...state, sharedStorageRoot: sharedStorageRoot.value, uploadStorageRoot: uploadStorageRoot.value };
      await stateStore.write(state);
    }
    await mkdir(sharedStorageRoot.value, { recursive: true });
    await mkdir(uploadStorageRoot.value, { recursive: true });
    // Device-local Runtime state deliberately remains SQLite-only. The shared
    // Router/Host database adapter is not a valid replacement at this boundary.
    const supervisorDatabasePath = input.supervisorDatabasePath ?? join(dirname(input.databasePath), "supervisor.db");
    const supervisorDatabase = new AppDatabase(supervisorDatabasePath);
    const customSkillDirectories = await loadSkillDirectoriesConfig({
      appRoot: input.appRoot,
      configPath: input.skillDirectoriesConfigPath,
    });
    const secretStore = new EncryptedLocalRuntimeSecretStore(join(dirname(supervisorDatabasePath), "runtime-secrets"));
    const modelSecretStore = new EncryptedLocalRuntimeSecretStore(join(dirname(supervisorDatabasePath), "model-secrets"));
    const modelConfigurations = new LocalModelConfigurationStore(supervisorDatabase, modelSecretStore);
    await modelConfigurations.ready();
    const factory = new LocalRuntimeFactory(input, modelConfigurations);
    const uploadedSkillPackageRoot = join(input.skillPackageStoreRoot, "uploaded");
    const skillPackageInstaller = new LocalSkillPackageInstaller(uploadedSkillPackageRoot);
    const configurations = new LocalRuntimeConfigurationStore(supervisorDatabase, secretStore, customSkillDirectories, uploadedSkillPackageRoot, modelConfigurations);
    const supervisor = new LocalRuntimeSupervisor(
      supervisorDatabase,
      (definition, configuration) => factory.create(definition, configuration, sharedStorageRoot.value, uploadStorageRoot.value),
      async (definition) => {
        const runtimeRoot = factory.runtimeRootFor(definition);
        if (runtimeRoot !== undefined) await rm(runtimeRoot, { recursive: true, force: true });
        await rm(factory.runtimeUploadRootFor(definition, uploadStorageRoot.value), { recursive: true, force: true });
      },
      input.maxConcurrentRuns,
      configurations,
    );
    await supervisor.ready(state.defaultRuntimeId, {
      mcpConfiguration: await readLegacyLocalMcpConfiguration(input.mcpServersConfigPath),
      integrationEnvironment: input.integrationEnvironment,
    });
    const service = new LocalAgentService(input, stateStore, supervisor, configurations, modelConfigurations, skillPackageInstaller, input.directoryPicker ?? pickNativeDirectory, sharedStorageRoot, uploadStorageRoot);
    service.connection = new RuntimeConnectionClient(input.routerUrl, supervisor, (method, payload) => service.agentControl(method, payload));
    await service.connection.ready();
    if (state.device !== undefined) service.connection.setDevice(state.device);
    return service;
  }

  async close(): Promise<void> {
    this.connection?.stop();
    await this.supervisor.close();
  }

  async health(): Promise<unknown> { return await this.status(await this.stateStore.read()); }

  async localModelConfiguration(): Promise<unknown> {
    return { configuration: await this.modelConfigurations.read() };
  }

  async localModels(includeCloud?: boolean): Promise<unknown> {
    const configuration = await this.modelConfigurations.read();
    const local = configuration.providers.flatMap((provider) => provider.models.map((model) => ({
      key: `local:${model.key}`, displayName: model.displayName, provider: provider.displayName, source: "local" as const,
    })));
    const state = await this.stateStore.read();
    let cloud: Array<{ key: string; displayName: string; source: "cloud" }> = [];
    if ((includeCloud ?? configuration.reuseCloudModels) && state.device !== undefined && this.input.routerUrl !== undefined) {
      const response = await fetch(new URL("/v1/device-agent/models", this.input.routerUrl), { headers: { authorization: `Bearer ${state.device.agentToken}` } });
      const body = await response.json().catch(() => ({})) as { models?: Array<{ key?: string; displayName?: string }> };
      if (response.ok && Array.isArray(body.models)) cloud = body.models.filter((model) => typeof model.key === "string").map((model) => ({ key: `cloud:${model.key}`, displayName: model.displayName ?? model.key!, source: "cloud" as const }));
    }
    return { models: [...local, ...cloud] };
  }

  async updateLocalModelConfiguration(configuration: LocalModelConfigurationInput): Promise<unknown> {
    // Serialize credential-preserving writes without locking Run admission or
    // touching Runtime lifecycle, Skills, MCP sessions, or Runtime databases.
    const update = this.modelConfigurationUpdate.then(async () => {
      const snapshot = await this.modelConfigurations.snapshot();
      const updated = await this.modelConfigurations.write(configuration);
      try {
        await this.modelConfigurations.commit(snapshot);
      } catch (error) {
        await this.modelConfigurations.restore(snapshot);
        throw error;
      }
      return { configuration: updated };
    });
    this.modelConfigurationUpdate = update.catch(() => undefined);
    return await update;
  }

  async registerDevice(origin: string | undefined, registrationToken: string): Promise<unknown> {
    this.requireOrigin(origin);
    if (this.input.routerUrl === undefined) throw new LocalAgentApplicationError(409, "local_agent_router_not_configured");
    const state = await this.stateStore.read();
    if (state.device !== undefined) return { device: { id: state.device.id, displayName: state.device.displayName, status: "active" }, alreadyRegistered: true };
    const displayName = `Local Runtime · ${hostname()}`;
    const result = await fetch(new URL("/v1/device-agent/register", this.input.routerUrl), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ registrationToken, displayName, publicKey: state.deviceIdentity.publicKey }),
    });
    const registered = await result.json().catch(() => ({}));
    if (!result.ok || typeof registered.agentToken !== "string" || typeof registered.device?.id !== "string") {
      throw new Error(typeof registered.error === "string" ? registered.error : `Router HTTP ${result.status}`);
    }
    const device = { id: registered.device.id, agentToken: registered.agentToken, displayName: registered.device.displayName };
    await this.stateStore.write({ ...state, device });
    this.connection?.setDevice(device);
    return { device: registered.device, alreadyRegistered: false };
  }

  async authorize(origin: string | undefined, sessionToken: string | undefined): Promise<LocalSession> {
    this.requireOrigin(origin);
    if (typeof sessionToken !== "string" || sessionToken.length < 32) throw new LocalAgentApplicationError(401, "local_session_required");
    if (this.input.routerUrl === undefined) throw new LocalAgentApplicationError(409, "local_agent_router_not_configured");
    const state = await this.stateStore.read();
    if (state.device === undefined) throw new LocalAgentApplicationError(409, "device_not_registered");
    const result = await fetch(new URL("/v1/device-agent/authorize-session", this.input.routerUrl), {
      method: "POST", headers: { authorization: `Bearer ${state.device.agentToken}`, "content-type": "application/json" }, body: JSON.stringify({ sessionToken }),
    });
    const value = await result.json().catch(() => ({}));
    if (!result.ok || typeof value.session?.ownerUserId !== "string") {
      throw new LocalAgentApplicationError(result.status === 401 ? 401 : 409,
        typeof value.code === "string" ? value.code : typeof value.error === "string" ? value.error : "local_session_invalid");
    }
    return { ownerUserId: value.session.ownerUserId };
  }

  async listDirectoryScopes(runtimeId: string): Promise<unknown> {
    const runtime = this.supervisor.runtime(runtimeId);
    return { runtimeId: runtime.id, scopes: await runtime.scopes.list() };
  }

  async pickDirectoryScope(runtimeId: string): Promise<unknown> {
    const runtime = this.supervisor.runtime(runtimeId, true);
    const path = await this.picker();
    if (path === undefined) return { cancelled: true };
    return { runtimeId: runtime.id, scope: await runtime.scopes.create(path, basename(path)) };
  }

  async revokeDirectoryScope(runtimeId: string, scopeId: string): Promise<void> {
    await this.supervisor.runtime(runtimeId).scopes.revoke(scopeId);
  }

  async listLocalSkillPackages(): Promise<unknown> {
    return { skills: await this.configurations.listSkillPackages() };
  }

  async localSkillMetadata(packageId: string): Promise<unknown> {
    return await this.configurations.skillMetadata(packageId);
  }

  async updateLocalSkillMetadata(packageId: string, value: unknown): Promise<unknown> {
    return { skill: await this.configurations.updateSkillMetadata(packageId, value) };
  }

  async installLocalSkillPackage(originalName: string, content: Buffer): Promise<unknown> {
    const installed = await this.skillPackageInstaller.installZip(content, originalName);
    const skills = await Promise.all(installed.map((packageInfo) => this.configurations.registerUploadedPackage({
      ...packageInfo,
      inspection: { ...packageInfo.inspection, metadataSource: packageInfo.metadataSource },
    })));
    return {
      skills,
      ...(skills.length === 1 ? { skill: skills[0] } : {}),
    };
  }

  async installLocalSkillDirectory(files: readonly LocalSkillUploadFile[]): Promise<unknown> {
    const installed = await this.skillPackageInstaller.installDirectory(files);
    const skills = await Promise.all(installed.map((packageInfo) => this.configurations.registerUploadedPackage({
      ...packageInfo,
      inspection: { ...packageInfo.inspection, metadataSource: packageInfo.metadataSource },
    })));
    return {
      skills,
      ...(skills.length === 1 ? { skill: skills[0] } : {}),
    };
  }

  async testLocalMcpServer(server: LocalRuntimeMcpServerInput): Promise<unknown> {
    const { registration, secretValues, environment } = transientMcpRegistration(server);
    const result = await loadMcpToolsFromConfig({ servers: [registration] }, { environment });
    const failure = result.failedServers[0];
    if (failure !== undefined) {
      const message = redactMcpDiagnostic(failure.message, secretValues);
      return { ok: false, stage: mcpFailureStage(message), error: message };
    }
    return {
      ok: true,
      toolCount: result.tools.length,
      tools: result.tools.map((tool) => tool.name),
    };
  }

  async createLocalRuntime(displayName: string, configuration: LocalRuntimeConfigurationInput): Promise<unknown> {
    const runtime = await this.supervisor.create(displayName, configuration);
    return { runtime, configuration: await this.supervisor.configuration(runtime.id) };
  }

  async localRuntimeConfiguration(runtimeId: string): Promise<unknown> {
    return { configuration: await this.supervisor.configuration(runtimeId) };
  }

  async updateLocalRuntimeConfiguration(runtimeId: string, configuration: LocalRuntimeConfigurationInput, displayName?: string): Promise<unknown> {
    const updated = await this.supervisor.updateConfiguration(runtimeId, configuration, displayName);
    return { runtime: (await this.supervisor.list()).find((runtime) => runtime.id === runtimeId), configuration: updated };
  }

  async startLocalRuntime(runtimeId: string): Promise<unknown> {
    return { runtime: await this.supervisor.start(runtimeId) };
  }

  async stopLocalRuntime(runtimeId: string): Promise<unknown> {
    return { runtime: await this.supervisor.stop(runtimeId) };
  }

  async upload(session: LocalSession, value: { runtimeId: string; conversationId: string; originalName: string; content: Buffer; mediaType?: string }): Promise<unknown> {
    const runtime = this.supervisor.runtime(value.runtimeId, true);
    await runtime.runs.ensureConversation(session.ownerUserId, value.conversationId, `已上传文件：${value.originalName}`);
    const source = await runtime.runs.uploadSource(session.ownerUserId, {
      conversationId: value.conversationId, originalName: value.originalName, content: value.content,
      ...(value.mediaType === undefined ? {} : { mimeType: value.mediaType }),
    });
    return { runtimeId: runtime.id, source };
  }

  async deleteConversation(session: LocalSession, runtimeId: string, conversationId: string): Promise<void> {
    await this.supervisor.runtime(runtimeId).runs.deleteConversation(session.ownerUserId, conversationId);
  }

  async startStrictLocalRun(session: LocalSession, value: { runtimeId: string; conversationId: string; clientMessageId: string; input: string; localDirectoryScopeIds: readonly string[]; localUploadedSourceIds: readonly string[]; allowDangerousTools: boolean; requestedModelKey?: string }): Promise<unknown> {
    if (typeof value.requestedModelKey !== "string" || value.requestedModelKey.trim().length === 0) {
      throw new LocalAgentApplicationError(400, "model_required");
    }
    const dispatchId = `strict:${session.ownerUserId}:${value.clientMessageId}`;
    const current = this.supervisor.runtime(value.runtimeId);
    const existing = await current.database.prepare("SELECT remote_run_id FROM local_runtime_dispatches WHERE dispatch_key = ? AND owner_user_id = ?").get(dispatchId, session.ownerUserId) as { remote_run_id: string } | undefined;
    if (existing !== undefined) {
      const run = await current.runs.get(session.ownerUserId, existing.remote_run_id);
      return { runtimeId: current.id, run: toStatus(run), replayed: true };
    }
    return await this.supervisor.admitRun(value.runtimeId, async (runtime) => {
      const visibleDirectories = await runtime.scopes.paths(value.localDirectoryScopeIds);
      await runtime.runs.ensureConversation(session.ownerUserId, value.conversationId, value.input);
      const run = await runtime.runs.startConversation(session.ownerUserId, value.input, {
        conversationId: value.conversationId, visibleDirectories, sourceIds: value.localUploadedSourceIds,
        allowDangerousTools: value.allowDangerousTools, ...(value.requestedModelKey === undefined ? {} : { modelKey: value.requestedModelKey }),
      });
      await runtime.database.prepare("INSERT INTO local_runtime_dispatches(dispatch_key, assignment_id, owner_user_id, remote_run_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(dispatchId, dispatchId, session.ownerUserId, run.id, Date.now());
      return { runId: run.id, value: { runtimeId: runtime.id, run: toStatus(run) } };
    });
  }

  async strictLocalRun(session: LocalSession, runtimeId: string, runId: string): Promise<unknown> {
    const runtime = this.supervisor.runtime(runtimeId);
    const run = await runtime.runs.get(session.ownerUserId, runId);
    if (run.status !== "running") await this.supervisor.runSettled(runtime.id, run.id);
    return { runtimeId: runtime.id, run: toStatus(run) };
  }

  async strictLocalEvents(session: LocalSession, runtimeId: string, runId: string, afterSeq: number): Promise<unknown> {
    const runtime = this.supervisor.runtime(runtimeId);
    return { events: (await runtime.runs.events(session.ownerUserId, runId)).filter((event) => event.seq > afterSeq) };
  }

  async cancelStrictLocalRun(session: LocalSession, runtimeId: string, runId: string): Promise<unknown> {
    const runtime = this.supervisor.runtime(runtimeId);
    const run = await runtime.runs.cancel(session.ownerUserId, runId);
    await this.supervisor.runSettled(runtime.id, run.id);
    return { runtimeId: runtime.id, run: toStatus(run) };
  }

  async artifacts(session: LocalSession, runtimeId: string, runId: string): Promise<unknown> {
    const artifacts = await this.supervisor.runtime(runtimeId).runs.processArtifacts(session.ownerUserId, runId);
    return { artifacts: artifacts.map((artifact) => ({ ...artifact, path: `local-artifact:${artifact.id}`, location: "local" })) };
  }

  async previewArtifact(session: LocalSession, runtimeId: string, runId: string, artifactId: string): Promise<unknown> {
    return await this.supervisor.runtime(runtimeId).runs.previewProcessArtifact(session.ownerUserId, runId, artifactId);
  }

  async readArtifact(session: LocalSession, runtimeId: string, runId: string, artifactId: string) {
    return await this.supervisor.runtime(runtimeId).runs.readProcessArtifact(session.ownerUserId, runId, artifactId);
  }

  private async agentControl(method: string, payload: Record<string, unknown>): Promise<unknown> {
    if (method === "agent.status") return await this.health();
    if (method === "agent.runtimes.list") return { runtimes: await this.supervisor.list() };
    if (method === "agent.runtimes.create") return { runtime: await this.supervisor.create(requiredString(payload.displayName, "displayName")) };
    if (method === "agent.runtimes.rename") return { runtime: await this.supervisor.rename(requiredString(payload.runtimeId, "runtimeId"), requiredString(payload.displayName, "displayName")) };
    if (method === "agent.runtimes.remove") return await this.supervisor.remove(requiredString(payload.runtimeId, "runtimeId"));
    if (method === "agent.runtimes.lifecycle") {
      const action = requiredString(payload.action, "action");
      if (action !== "drain" && action !== "restart" && action !== "stop" && action !== "start") throw new LocalRuntimeSupervisorError(400, "runtime_lifecycle_action_invalid");
      return { runtime: await this.supervisor[action](requiredString(payload.runtimeId, "runtimeId")) };
    }
    if (method === "agent.config.get") return {
      agentVersion: LOCAL_AGENT_VERSION, protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
      router: { configured: this.input.routerUrl !== undefined, ...(this.input.routerUrl === undefined ? {} : { url: this.input.routerUrl }) },
      sharedStorage: { path: this.sharedStorageRoot.value, displayName: basename(this.sharedStorageRoot.value) },
      uploadStorage: { path: this.uploadStorageRoot.value, displayName: basename(this.uploadStorageRoot.value) },
      skillLoading: { mode: "runtime_startup", packageStoreRoot: this.input.skillPackageStoreRoot },
    };
    if (method === "agent.config.sharedStorage.pick") return await this.pickStorage("shared");
    if (method === "agent.config.uploadStorage.pick") return await this.pickStorage("upload");
    if (method === "agent.reconnect") { this.connection?.reconnectNow(); return { accepted: true }; }
    throw new LocalAgentApplicationError(404, "agent_control_method_not_found");
  }

  private async pickStorage(kind: "shared" | "upload"): Promise<unknown> {
    if (this.supervisor.hasActiveWork()) throw new LocalRuntimeSupervisorError(409, "runtime_active_runs_prevent_storage_change");
    const path = await this.picker();
    if (path === undefined) return { cancelled: true };
    const root = kind === "shared" ? this.sharedStorageRoot : this.uploadStorageRoot;
    const next = resolve(path);
    await mkdir(next, { recursive: true });
    const previous = root.value;
    root.value = next;
    try {
      await this.supervisor.reloadRunningInstances();
      const latest = await this.stateStore.read();
      await this.stateStore.write({ ...latest, ...(kind === "shared" ? { sharedStorageRoot: next } : { uploadStorageRoot: next }) });
    } catch (error) {
      root.value = previous;
      await this.supervisor.reloadRunningInstances().catch(() => undefined);
      throw error;
    }
    const storage = { path: root.value, displayName: basename(root.value) };
    return kind === "shared" ? { sharedStorage: storage } : { uploadStorage: storage };
  }

  private async status(state: LocalAgentState): Promise<unknown> {
    return {
      status: "ready", agentVersion: LOCAL_AGENT_VERSION, protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
      deviceId: state.device?.id, runtimeId: state.defaultRuntimeId, runtimes: await this.supervisor.list(), registered: state.device !== undefined,
      routerConnected: this.connection?.isConnected() ?? false,
      router: { configured: this.input.routerUrl !== undefined, ...(this.input.routerUrl === undefined ? {} : { url: this.input.routerUrl }) },
      displayName: state.device?.displayName,
      sharedStorage: { configured: true, displayName: basename(this.sharedStorageRoot.value) },
      uploadStorage: { configured: true, displayName: basename(this.uploadStorageRoot.value) },
    };
  }

  private requireOrigin(origin: string | undefined): void {
    if (origin === undefined || this.input.webOrigin === undefined || !this.input.webOrigin.split(",").map((value) => value.trim()).includes(origin)) throw new LocalAgentApplicationError(403, "local_agent_origin_denied");
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200_000) throw new Error(`${name}_invalid`);
  return value;
}

function toStatus(run: { readonly id: string; readonly status: "running" | "completed" | "failed" | "cancelled"; readonly modelKey?: string; readonly output?: string; readonly errorCode?: string; readonly finishedAt?: number }) {
  return { remoteRunId: run.id, status: run.status, ...(run.modelKey === undefined ? {} : { modelKey: run.modelKey }), ...(run.output === undefined ? {} : { output: run.output }), ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }), ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }) };
}

export async function readLegacyLocalMcpConfiguration(path: string | undefined): Promise<McpServersConfig | undefined> {
  if (path === undefined) return undefined;
  const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (source === undefined) return undefined;
  return parseMcpServersConfig(JSON.parse(source), `legacy Local Runtime MCP configuration file ${resolve(path)}`);
}

function transientMcpRegistration(server: LocalRuntimeMcpServerInput): { registration: McpServerRegistration; secretValues: readonly string[]; environment: Readonly<Record<string, string>> } {
  let endpoint: URL;
  try { endpoint = new URL(server.url); } catch { throw new LocalAgentApplicationError(400, "mcp_configuration_invalid"); }
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || endpoint.username !== "" || endpoint.password !== "") throw new LocalAgentApplicationError(400, "mcp_configuration_invalid");
  for (const name of endpoint.searchParams.keys()) {
    if (/(?:token|secret|password|api[-_]?key|auth)/i.test(name)) throw new LocalAgentApplicationError(400, "mcp_secret_must_use_auth_fields");
  }
  const secretValues: string[] = [];
  const environment: Record<string, string> = {};
  let auth: McpServerRegistration["auth"] = { kind: "none" };
  if (server.auth.kind === "bearer") {
    const token = requiredCredential(server.auth.token);
    secretValues.push(token);
    auth = { kind: "headers", headers: { Authorization: `Bearer ${token}` } };
  } else if (server.auth.kind === "api_key_header") {
    const value = requiredCredential(server.auth.value);
    secretValues.push(value);
    auth = { kind: "headers", headers: { [server.auth.headerName]: value } };
  } else if (server.auth.kind === "basic") {
    const password = requiredCredential(server.auth.password);
    const authorization = `Basic ${Buffer.from(`${server.auth.username}:${password}`).toString("base64")}`;
    secretValues.push(password, authorization);
    auth = { kind: "headers", headers: { Authorization: authorization } };
  } else if (server.auth.kind === "query_parameter") {
    const value = requiredCredential(server.auth.value);
    secretValues.push(value);
    environment.LOCAL_RUNTIME_MCP_TEST_QUERY = value;
    auth = { kind: "query", name: server.auth.parameterName, secretEnv: "LOCAL_RUNTIME_MCP_TEST_QUERY" };
  } else if (server.auth.kind === "custom_headers") {
    if (server.auth.headers === undefined) throw new LocalAgentApplicationError(400, "mcp_credential_required");
    secretValues.push(...Object.values(server.auth.headers));
    auth = { kind: "headers", headers: server.auth.headers };
  }
  const registration = parseMcpServersConfig({ servers: [{
    key: server.key,
    transport: server.transport,
    url: server.url,
    ...(server.protocolVersion === undefined ? {} : { protocolVersion: server.protocolVersion }),
    ...(server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs }),
    ...(server.toolAllowlist === undefined ? {} : { toolAllowlist: server.toolAllowlist }),
    ...(server.toolBlocklist === undefined ? {} : { toolBlocklist: server.toolBlocklist }),
    ...(server.trust === undefined ? {} : { trust: server.trust }),
    ...(server.aliases === undefined ? {} : { aliases: server.aliases }),
    ...(server.capabilities === undefined ? {} : { capabilities: server.capabilities }),
    auth,
  }] }, "MCP connection test").servers[0]!;
  return { registration, secretValues, environment };
}

function requiredCredential(value: string | undefined): string {
  if (value === undefined || value.length === 0) throw new LocalAgentApplicationError(400, "mcp_credential_required");
  return value;
}

function mcpFailureStage(message: string): "authentication" | "initialize" | "tools_list" | "connection" {
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|authentication/i.test(message)) return "authentication";
  if (/tools\/list/i.test(message)) return "tools_list";
  if (/initialize/i.test(message)) return "initialize";
  return "connection";
}
