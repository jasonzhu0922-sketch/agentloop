import { AppError, type RunService, type McpServerRegistration } from "@zhujun/agentloop";
import type { LocalExecutionContext, LocalIdentityPort, LocalModelProviderPort, LocalRuntimeControl, LocalRuntimeDefinition, LocalConnectorConfigurationPort } from "../contracts/host.ts";
import { LocalRuntimeFactory } from "./local-runtime-factory.ts";
import { LocalRunAdmissionService } from "./local-run-admission.ts";

export interface LocalRuntimeOptions {
  readonly id: string;
  readonly displayName?: string;
  readonly databasePath: string;
  readonly workspaceRoot: string;
  readonly uploadStorageRoot: string;
  readonly skillPackageStoreRoot: string;
  readonly models: LocalModelProviderPort;
  readonly bundledSkillDirectories?: readonly string[];
  readonly customSkillDirectories?: readonly string[];
  readonly mcpServers?: readonly McpServerRegistration[];
  readonly identity?: LocalIdentityPort;
  readonly memory?: { readonly enabled: boolean; readonly settlementModelKey?: string };
  readonly connectors?: LocalConnectorConfigurationPort;
  readonly maxConcurrentRuns?: number;
}

export interface LocalRunInput {
  /** Reuse this key for retries of the same logical request; owner-scoped. */
  readonly requestId?: string;
  readonly input: string;
  readonly modelKey: string;
  readonly conversationId?: string;
  readonly directoryScopeIds?: readonly string[];
  readonly uploadedSourceIds?: readonly string[];
  readonly connectorConnectionIds?: readonly string[];
  readonly allowDangerousTools?: boolean;
}

export interface LocalRuntime {
  readonly definition: LocalRuntimeDefinition;
  models(): readonly string[];
  startRun(context: LocalExecutionContext, input: LocalRunInput): ReturnType<RunService["startConversation"]>;
  getRun(context: LocalExecutionContext, runId: string): ReturnType<RunService["get"]>;
  cancelRun(context: LocalExecutionContext, runId: string): ReturnType<RunService["cancel"]>;
  events(context: LocalExecutionContext, runId: string, afterSeq?: number): ReturnType<RunService["events"]>;
  ensureConversation(context: LocalExecutionContext, conversationId: string, input: string): Promise<void>;
  conversations(context: LocalExecutionContext): Promise<Awaited<ReturnType<RunService["getConversation"]>>["conversation"][]>;
  conversation(context: LocalExecutionContext, conversationId: string): ReturnType<RunService["getConversation"]>;
  upload(context: LocalExecutionContext, input: Parameters<RunService["uploadSource"]>[1]): ReturnType<RunService["uploadSource"]>;
  source(context: LocalExecutionContext, sourceId: string): ReturnType<RunService["source"]>;
  artifacts(context: LocalExecutionContext, runId: string): ReturnType<RunService["processArtifacts"]>;
  readArtifact(context: LocalExecutionContext, runId: string, artifactId: string): ReturnType<RunService["readProcessArtifact"]>;
  /** Host-only directory consent; the host owns the native picker and Session. */
  grantDirectory(path: string, displayName?: string): ReturnType<LocalRuntimeControl["scopes"]["create"]>;
  directories(): ReturnType<LocalRuntimeControl["scopes"]["list"]>;
  revokeDirectory(id: string): Promise<void>;
  close(): Promise<void>;
}

/** Creates one local execution space. No Router, browser Session or device registration is required. */
export async function createLocalRuntime(options: LocalRuntimeOptions): Promise<LocalRuntime> {
  if (!options.id.trim()) throw new TypeError("runtime_id_required");
  if (options.maxConcurrentRuns !== undefined && (!Number.isSafeInteger(options.maxConcurrentRuns) || options.maxConcurrentRuns < 1)) throw new TypeError("maxConcurrentRuns must be a positive integer");
  const definition = Object.freeze({ id: options.id, displayName: options.displayName ?? "本机 Runtime", storageKey: "default", isDefault: true });
  const control = await new LocalRuntimeFactory({
    databasePath: options.databasePath, skillPackageStoreRoot: options.skillPackageStoreRoot,
    models: options.models, identity: options.identity,
    environment: options.bundledSkillDirectories === undefined ? {} : { AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: options.bundledSkillDirectories.join(",") },
  }, undefined, options.connectors).create(definition, {
    customSkillDirectories: options.customSkillDirectories ?? [], mcpServers: options.mcpServers ?? [],
    integrationEnvironment: { WEB_SEARCH_DISABLED: "1" }, memory: options.memory,
  }, options.workspaceRoot, options.uploadStorageRoot);
  return new RuntimeFacade(control, definition, new LocalRunAdmissionService(control, { maxConcurrentRuns: options.maxConcurrentRuns }));
}

export class RuntimeFacade implements LocalRuntime {
  readonly #control: LocalRuntimeControl;
  #pending = 0;
  #closed = false;
  #closing?: Promise<void>;
  readonly #admissions: LocalRunAdmissionService;
  constructor(control: LocalRuntimeControl, readonly definition: LocalRuntimeDefinition, admissions: LocalRunAdmissionService) {
    this.#control = control; this.#admissions = admissions;
  }
  #ready(): LocalRuntimeControl {
    if (this.#closed || this.#closing) throw new AppError("CONFLICT", "local_runtime_closed", 409);
    return this.#control;
  }
  #owner(context: LocalExecutionContext): string {
    if (!context.ownerUserId?.trim()) throw new TypeError("owner_user_id_required");
    return context.ownerUserId;
  }
  models(): readonly string[] { return [...this.#ready().modelKeys]; }
  async #use<T>(operation: (runtime: LocalRuntimeControl) => Promise<T>): Promise<T> {
    const runtime = this.#ready();
    this.#pending++;
    try { return await operation(runtime); }
    finally { this.#pending--; }
  }
  async startRun(context: LocalExecutionContext, input: LocalRunInput) {
    return this.#use(() => this.#admissions.start(this.#owner(context), input));
  }
  async getRun(context: LocalExecutionContext, runId: string) {
    return this.#use(runtime => runtime.runs.get(this.#owner(context), runId));
  }
  cancelRun(context: LocalExecutionContext, runId: string) { return this.#use(runtime => runtime.runs.cancel(this.#owner(context), runId)); }
  async events(context: LocalExecutionContext, runId: string, afterSeq = 0) {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError("event_sequence_invalid");
    return this.#use(async runtime => (await runtime.runs.events(this.#owner(context), runId)).filter(event => event.seq > afterSeq));
  }
  ensureConversation(context: LocalExecutionContext, conversationId: string, input: string) {
    return this.#use(runtime => runtime.runs.ensureConversation(this.#owner(context), conversationId, input));
  }
  conversations(context: LocalExecutionContext): ReturnType<LocalRuntime["conversations"]> { return this.#use(runtime => runtime.runs.listConversations(this.#owner(context))); }
  conversation(context: LocalExecutionContext, conversationId: string): ReturnType<LocalRuntime["conversation"]> { return this.#use(runtime => runtime.runs.getConversation(this.#owner(context), conversationId)); }
  upload(context: LocalExecutionContext, input: Parameters<RunService["uploadSource"]>[1]) { return this.#use(runtime => runtime.runs.uploadSource(this.#owner(context), input)); }
  source(context: LocalExecutionContext, sourceId: string) { return this.#use(runtime => runtime.runs.source(this.#owner(context), sourceId)); }
  artifacts(context: LocalExecutionContext, runId: string) { return this.#use(runtime => runtime.runs.processArtifacts(this.#owner(context), runId)); }
  readArtifact(context: LocalExecutionContext, runId: string, artifactId: string) { return this.#use(runtime => runtime.runs.readProcessArtifact(this.#owner(context), runId, artifactId)); }
  grantDirectory(path: string, displayName?: string) { return this.#use(runtime => runtime.scopes.create(path, displayName)); }
  directories() { return this.#use(runtime => runtime.scopes.list()); }
  revokeDirectory(id: string) { return this.#use(runtime => runtime.scopes.revoke(id)); }
  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closing) return this.#closing;
    this.#closing = Promise.resolve().then(async () => {
      if (this.#pending) throw new AppError("CONFLICT", "runtime_active_runs_prevent_close", 409);
      await this.#admissions.refresh();
      if (this.#control.activeRunIds.size > 0) throw new AppError("CONFLICT", "runtime_active_runs_prevent_close", 409);
      await this.#admissions.flushSettlements();
      try { await this.#control.close?.(); }
      finally {
        await this.#control.database.close();
        this.#closed = true;
      }
    }).finally(() => { this.#closing = undefined; });
    return this.#closing;
  }
}
