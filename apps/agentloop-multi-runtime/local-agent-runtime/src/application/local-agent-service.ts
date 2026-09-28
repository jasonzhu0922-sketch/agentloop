import { basename, dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import { AppDatabase } from "@zhujun/agentloop";
import type { LocalAgentOptions } from "./local-agent-options.ts";
import { LocalRuntimeFactory } from "./local-runtime-factory.ts";
import { LocalRuntimeSupervisor, LocalRuntimeSupervisorError, type LocalRuntimeControl, type LocalRuntimeDefinition } from "./runtime-supervisor.ts";
import { RuntimeConnectionClient } from "../infrastructure/runtime-connection-client.ts";
import { pickNativeDirectory } from "../infrastructure/native-directory-picker.ts";
import { LocalAgentStateStore, type LocalAgentState } from "../persistence/local-agent-state-store.ts";

export const LOCAL_AGENT_VERSION = "0.1.0";
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
  private readonly picker: () => Promise<string | undefined>;
  private readonly sharedStorageRoot: { value: string };
  private readonly uploadStorageRoot: { value: string };
  private constructor(
    input: LocalAgentOptions, stateStore: LocalAgentStateStore,
    supervisor: LocalRuntimeSupervisor, picker: () => Promise<string | undefined>,
    sharedStorageRoot: { value: string }, uploadStorageRoot: { value: string },
  ) {
    this.input = input; this.stateStore = stateStore;
    this.supervisor = supervisor; this.picker = picker; this.sharedStorageRoot = sharedStorageRoot; this.uploadStorageRoot = uploadStorageRoot;
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
    const factory = new LocalRuntimeFactory(input);
    // Device-local Runtime state deliberately remains SQLite-only. The shared
    // Router/Host database adapter is not a valid replacement at this boundary.
    const supervisorDatabase = new AppDatabase(input.supervisorDatabasePath ?? join(dirname(input.databasePath), "supervisor.db"));
    const supervisor = new LocalRuntimeSupervisor(
      supervisorDatabase,
      (definition) => factory.create(definition, sharedStorageRoot.value, uploadStorageRoot.value),
      async (definition) => {
        const runtimeRoot = factory.runtimeRootFor(definition);
        if (runtimeRoot !== undefined) await rm(runtimeRoot, { recursive: true, force: true });
        await rm(factory.runtimeUploadRootFor(definition, uploadStorageRoot.value), { recursive: true, force: true });
      },
      input.maxConcurrentRuns,
    );
    await supervisor.ready(state.defaultRuntimeId);
    const service = new LocalAgentService(input, stateStore, supervisor, input.directoryPicker ?? pickNativeDirectory, sharedStorageRoot, uploadStorageRoot);
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
      throw new LocalAgentApplicationError(result.status === 401 ? 401 : 409, typeof value.error === "string" ? value.error : "local_session_invalid");
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
