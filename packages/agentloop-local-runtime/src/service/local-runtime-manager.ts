import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { AppDatabase, AppError, loadMcpToolsFromConfig } from "@zhujun/agentloop";
import { importSkillFiles, readSkillZip, type SkillImportFile, LocalManagementError } from "../configuration/skill-import.ts";
import { ConnectorSettings, type ConnectorSettingInput } from "../configuration/connector-settings.ts";
import type { ConnectorModuleRegistration } from "../connectors/connector-module-loader.ts";
import type { LocalConnectorConfigurationPort, LocalIdentityPort, LocalModelProviderPort, LocalRuntimeControl, LocalRuntimeHostOptions } from "../contracts/host.ts";
import { LocalRuntimeSupervisorError } from "../contracts/host.ts";
import { LocalRuntimeConfigurationStore, type LocalRuntimeConfigurationInput, type LocalRuntimeMcpServerInput, type LocalRuntimeMemoryConfigurationInput, type LocalRuntimeSecretStore, type ResolvedLocalMemoryConfiguration, type LocalRuntimeDeviceStorageInput, type ResolvedLocalRuntimeDeviceStorage } from "../configuration/local-runtime-configuration-store.ts";
import { LocalRunAdmissionService } from "./local-run-admission.ts";
import { LocalRuntimeFactory } from "./local-runtime-factory.ts";
import { RuntimeFacade, type LocalRuntime } from "./local-runtime.ts";
import { LocalRuntimeSupervisor, type LocalRuntimeSummary } from "./runtime-supervisor.ts";
import { LocalModelConfigurationStore, type LocalModelConfigurationInput, type LocalModelConfigurationSnapshot } from "../configuration/local-model-configuration-store.ts";

export interface LocalModelSettings {
  readonly configuration: LocalModelConfigurationInput;
  readonly revision: string;
  readonly editable: boolean;
  readonly credentialCleanupPending: boolean;
}
function modelRevision(snapshot: LocalModelConfigurationSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export interface LocalRuntimeManagerOptions {
  /** Dedicated writable application data, never an existing Agent installation. */
  readonly dataDirectory: string;
  readonly defaultRuntimeId: string;
  /** Explicit host model injection takes precedence and makes persisted settings read-only. */
  readonly models?: LocalModelProviderPort;
  /** Separate from MCP/Connector credentials. Required for editable model settings. */
  readonly modelSecrets?: LocalRuntimeSecretStore;
  readonly identity?: LocalIdentityPort;
  readonly secrets?: LocalRuntimeSecretStore;
  /** Required when another configuration owner shares the MCP vault. */
  readonly additionalSecretReferences?: () => Promise<readonly string[]>;
  readonly connectors?: LocalConnectorConfigurationPort;
  /** Host-approved modules; an empty array enables editable local connection settings without loading modules. */
  readonly connectorModules?: readonly ConnectorModuleRegistration[];
  readonly connectorSecrets?: LocalRuntimeSecretStore;
  readonly bundledSkillDirectories?: readonly string[];
  readonly customSkillDirectories?: readonly string[];
  readonly memory?: LocalRuntimeMemoryConfigurationInput;
  readonly workspaceRoot?: string;
  readonly uploadStorageRoot?: string;
  readonly maxConcurrentRuns?: number;
  /** Trusted host environment for command tools, never editable through configuration APIs. */
  readonly computerCommandEnvironment?: Readonly<Record<string, string>>;
  readonly runEventLogSink?: LocalRuntimeHostOptions["runEventLogSink"];
  readonly computerCommandSandbox?: LocalRuntimeHostOptions["computerCommandSandbox"];
  readonly authorizeStorage?: (input: LocalRuntimeDeviceStorageInput) => Promise<void>;
}

/** No close/control/database handle: lifecycle belongs to the manager. */
export type ManagedLocalRuntime = Omit<LocalRuntime, "close" | "definition" | "models"> & {
  models(): Promise<readonly string[]>;
};

export interface LocalRuntimeManager {
  modelConfiguration(): Promise<LocalModelSettings>;
  configureModels(input: LocalModelConfigurationInput, expectedRevision: string): Promise<LocalModelSettings>;
  deviceMemoryConfiguration(): Promise<ResolvedLocalMemoryConfiguration>;
  configureDeviceMemory(input: LocalRuntimeMemoryConfigurationInput): Promise<ResolvedLocalMemoryConfiguration>;
  deviceStorageConfiguration(): Promise<ResolvedLocalRuntimeDeviceStorage>;
  configureDeviceStorage(input: LocalRuntimeDeviceStorageInput): Promise<ResolvedLocalRuntimeDeviceStorage>;
  runtimes(): Promise<readonly LocalRuntimeSummary[]>;
  createRuntime(displayName: string, configuration?: LocalRuntimeConfigurationInput): Promise<LocalRuntimeSummary>;
  renameRuntime(runtimeId: string, displayName: string): Promise<LocalRuntimeSummary>;
  configuration(runtimeId: string): ReturnType<LocalRuntimeSupervisor["configuration"]>;
  configureRuntime(runtimeId: string, input: LocalRuntimeConfigurationInput, expectedRevision?: string): ReturnType<LocalRuntimeSupervisor["updateConfiguration"]>;
  runtimeSettings(runtimeId: string): Promise<{ configuration: Awaited<ReturnType<LocalRuntimeSupervisor["configuration"]>>; revision: string }>;
  skillPackages(): ReturnType<LocalRuntimeConfigurationStore["listSkillPackages"]>;
  importSkills(input: { files: readonly SkillImportFile[] } | { zip: Buffer }): ReturnType<LocalRuntimeConfigurationStore["listSkillPackages"]>;
  skillMetadata(id: string): ReturnType<LocalRuntimeConfigurationStore["skillMetadata"]>;
  updateSkillMetadata(id: string, declaration: unknown): ReturnType<LocalRuntimeConfigurationStore["updateSkillMetadata"]>;
  deviceMcpServers(): ReturnType<LocalRuntimeConfigurationStore["deviceMcpServers"]>;
  configureDeviceMcpServer(server: LocalRuntimeMcpServerInput): ReturnType<LocalRuntimeConfigurationStore["saveDeviceMcpServer"]>;
  removeDeviceMcpServer(id: string): ReturnType<LocalRuntimeConfigurationStore["removeDeviceMcpServer"]>;
  testDeviceMcpServer(server: LocalRuntimeMcpServerInput): Promise<{ ok: boolean; toolCount: number }>;
  testMcpServer(runtimeId: string, server: LocalRuntimeMcpServerInput): Promise<{ ok: boolean; toolCount: number }>;
  connectorCatalog(): Promise<ReturnType<ConnectorSettings["catalog"]>>;
  connectors(owner: string): ReturnType<ConnectorSettings["list"]>;
  configureConnector(owner: string, input: ConnectorSettingInput): ReturnType<ConnectorSettings["save"]>;
  removeConnector(owner: string, id: string): ReturnType<ConnectorSettings["remove"]>;
  startRuntime(runtimeId: string): Promise<LocalRuntimeSummary>;
  stopRuntime(runtimeId: string): Promise<LocalRuntimeSummary>;
  drainRuntime(runtimeId: string): Promise<LocalRuntimeSummary>;
  restartRuntime(runtimeId: string): Promise<LocalRuntimeSummary>;
  removeRuntime(runtimeId: string): ReturnType<LocalRuntimeSupervisor["remove"]>;
  runtime(runtimeId: string): ManagedLocalRuntime;
  assertIdle(): Promise<void>;
  close(): Promise<void>;
}

/** Trusted composition entry. Management methods require host authorization;
 * conversation/Run calls additionally use the authenticated owner context. */
export async function createLocalRuntimeManager(options: LocalRuntimeManagerOptions): Promise<LocalRuntimeManager> {
  if (!isAbsolute(options.dataDirectory)) throw new TypeError("data_directory_must_be_absolute");
  if (!options.defaultRuntimeId.trim()) throw new TypeError("runtime_id_required");
  if (options.maxConcurrentRuns !== undefined && (!Number.isSafeInteger(options.maxConcurrentRuns) || options.maxConcurrentRuns < 1)) throw new TypeError("maxConcurrentRuns must be a positive integer");
  await mkdir(options.dataDirectory, { recursive: true });
  const database = new AppDatabase(join(options.dataDirectory, "supervisor.db"));
  const modelConfigurations = options.modelSecrets === undefined ? undefined : new LocalModelConfigurationStore(database, options.modelSecrets);
  if (options.connectors && options.connectorModules) { await database.close(); throw new TypeError("connector_configuration_authority_conflict"); }
  const library = join(options.dataDirectory, "skill-library");
  // Device-level Memory chooses from the same persisted local-model catalog
  // that Runtime startup resolves. Keep that catalog at this boundary so an
  // unavailable model is rejected before the Memory flag becomes durable.
  const configurations = new LocalRuntimeConfigurationStore(database, options.secrets, options.customSkillDirectories ?? [], library, modelConfigurations, options.additionalSecretReferences);
  const storage = { value: { workspaceRoot: options.workspaceRoot ?? join(options.dataDirectory, "workspace"), uploadStorageRoot: options.uploadStorageRoot ?? join(options.dataDirectory, "uploads") } };
  const connectors = options.connectorModules === undefined ? undefined : new ConnectorSettings(database,
    options.connectorSecrets ?? new (await import("../persistence/encrypted-local-runtime-secret-store.ts")).EncryptedLocalRuntimeSecretStore(join(options.dataDirectory, "private", "connector-secrets")), options.connectorModules);
  const factory = new LocalRuntimeFactory({ databasePath: join(options.dataDirectory, "runtime.db"),
    runtimeDataRoot: join(options.dataDirectory, "runtimes"), skillPackageStoreRoot: join(options.dataDirectory, "skill-packages"),
    models: options.models, identity: options.identity,
    computerCommandEnvironment: options.computerCommandEnvironment, runEventLogSink: options.runEventLogSink,
    computerCommandSandbox: options.computerCommandSandbox,
    environment: options.bundledSkillDirectories === undefined ? {} : { AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: options.bundledSkillDirectories.join(",") },
  }, modelConfigurations, connectors ?? options.connectors);
  const supervisor = new LocalRuntimeSupervisor(database, (definition, configuration) => factory.create(definition, {
    ...configuration, integrationEnvironment: { ...configuration.integrationEnvironment, WEB_SEARCH_DISABLED: "1" },
  }, storage.value.workspaceRoot, storage.value.uploadStorageRoot), async definition => {
    const runtimeRoot = factory.runtimeRootFor(definition);
    if (runtimeRoot !== undefined) await rm(runtimeRoot, { recursive: true, force: true });
    await rm(factory.runtimeUploadRootFor(definition, storage.value.uploadStorageRoot), { recursive: true, force: true });
  }, options.maxConcurrentRuns, configurations);
  try {
    await connectors?.ready();
    await modelConfigurations?.ready();
    await configurations.ready();
    storage.value = await configurations.deviceStorageConfiguration(storage.value);
    await options.authorizeStorage?.(storage.value);
    if (options.memory !== undefined) {
      await configurations.ready();
      await configurations.applyDeviceMemory(options.memory);
    }
    await supervisor.ready(options.defaultRuntimeId);
    return new RuntimeManager(supervisor, configurations, modelConfigurations, options.models === undefined, library, connectors, storage, options.authorizeStorage);
  } catch (error) { await supervisor.close(); throw error; }
}

class RuntimeManager implements LocalRuntimeManager {
  readonly #models?: LocalModelConfigurationStore;
  readonly #modelsEditable: boolean;
  #modelUpdate: Promise<unknown> = Promise.resolve();
  #credentialCleanupPending = false;
  readonly #services = new WeakMap<LocalRuntimeControl, { admissions: LocalRunAdmissionService; facade: RuntimeFacade }>();
  #pending = 0;
  #closed = false;
  #closing?: Promise<void>;
  readonly #supervisor: LocalRuntimeSupervisor;
  readonly #configurations: LocalRuntimeConfigurationStore;
  constructor(supervisor: LocalRuntimeSupervisor, configurations: LocalRuntimeConfigurationStore, models?: LocalModelConfigurationStore, modelsEditable = false,
    private library = "", private connectorSettings?: ConnectorSettings, private storage?: { value: ResolvedLocalRuntimeDeviceStorage },
    private authorizeStorage?: LocalRuntimeManagerOptions["authorizeStorage"]) {
    this.#supervisor = supervisor; this.#configurations = configurations;
    this.#models = models; this.#modelsEditable = modelsEditable && models !== undefined;
  }

  private async modelSettings(): Promise<LocalModelSettings> {
    const snapshot = await this.#models?.snapshot() ?? {};
    const configuration = snapshot.row === undefined ? { reuseCloudModels: false, providers: [] } : await this.#models!.read();
    return { configuration, revision: modelRevision(snapshot), editable: this.#modelsEditable, credentialCleanupPending: this.#credentialCleanupPending };
  }
  modelConfiguration() { return this.guard(async () => { await this.#modelUpdate; return this.modelSettings(); }); }
  configureModels(input: LocalModelConfigurationInput, expectedRevision: string) {
    return this.guard(() => {
      const update = this.#modelUpdate.then(async () => {
        if (!this.#modelsEditable || !this.#models) throw new AppError("CONFLICT", "model_configuration_read_only", 409);
        if (!input || input.reuseCloudModels !== false || Object.keys(input).some(key => !["reuseCloudModels", "providers"].includes(key))) throw new AppError("BAD_REQUEST", "model_configuration_invalid", 400);
        const snapshot = await this.#models.snapshot();
        if (modelRevision(snapshot) !== expectedRevision) throw new AppError("CONFLICT", "model_configuration_stale", 409);
        await this.refresh();
        // Do not change an endpoint/key between turns of an existing Run. This
        // gate covers reads/admissions too; no Runtime recreation is needed.
        return this.#supervisor.withDeviceReconfiguration(async () => {
          await this.#models!.write(input);
          // The new configuration is already durable and published. Cleanup is
          // not a reason to roll back to an old credential that may be gone.
          try { await this.#models!.commit(snapshot); }
          catch { this.#credentialCleanupPending = true; }
          return this.modelSettings();
        }).catch(error => {
          if (error instanceof LocalRuntimeSupervisorError) throw new AppError("CONFLICT", error.message, error.status);
          throw error;
        });
      });
      this.#modelUpdate = update.catch(() => undefined);
      return update;
    });
  }

  deviceMemoryConfiguration() { return this.guard(() => this.#configurations.deviceMemoryConfiguration()); }
  configureDeviceMemory(input: LocalRuntimeMemoryConfigurationInput) {
    return this.guard(() => this.#supervisor.withDeviceReconfiguration(async () => {
      const previous = await this.#configurations.deviceMemoryConfiguration();
      await this.#configurations.applyDeviceMemory(input);
      try {
        await this.#supervisor.reloadRunningInstances();
      } catch (error) {
        await this.#configurations.restoreDeviceMemory(previous);
        await this.#supervisor.reloadRunningInstances().catch(() => undefined);
        throw error;
      }
      return await this.#configurations.deviceMemoryConfiguration();
    }));
  }
  deviceStorageConfiguration() { return this.guard(async () => {
    if (!this.storage) throw new AppError("CONFLICT", "device_storage_unavailable", 409);
    return this.storage.value;
  }); }
  configureDeviceStorage(input: LocalRuntimeDeviceStorageInput) {
    return this.guard(() => this.#supervisor.withDeviceReconfiguration(async () => {
      if (!this.storage) throw new AppError("CONFLICT", "device_storage_unavailable", 409);
      await this.authorizeStorage?.(input);
      const previous = this.storage.value, next = await this.#configurations.applyDeviceStorage(input);
      this.storage.value = next;
      try { await this.#supervisor.reloadRunningInstances(); }
      catch (error) {
        this.storage.value = previous; await this.#configurations.restoreDeviceStorage(previous);
        await this.#supervisor.reloadRunningInstances().catch(() => undefined); throw error;
      }
      return next;
    }));
  }

  private guard<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#closing) return Promise.reject(new AppError("CONFLICT", "local_runtime_closed", 409));
    this.#pending++;
    try { return operation().finally(() => { this.#pending--; }); }
    catch (error) { this.#pending--; return Promise.reject(error); }
  }

  private service(control: LocalRuntimeControl) {
    let service = this.#services.get(control);
    if (service === undefined) {
      const admissions = new LocalRunAdmissionService(control, {
        admit: start => this.#supervisor.admitRun(control.id, start),
        settled: id => this.#supervisor.runSettled(control.id, id),
      });
      const definition = Object.freeze({ id: control.id, displayName: control.displayName, storageKey: control.storageKey, isDefault: control.isDefault });
      service = { admissions, facade: new RuntimeFacade(control, definition, admissions) };
      this.#services.set(control, service);
    }
    return service;
  }

  private async refresh(): Promise<void> {
    for (const control of this.#supervisor.controls()) {
      await this.#supervisor.withRuntimeUse(control.id, () => this.service(control).admissions.refresh());
    }
  }
  runtimes() { return this.guard(async () => { await this.refresh(); return this.#supervisor.list(); }); }
  createRuntime(name: string, input?: LocalRuntimeConfigurationInput) { return this.guard(() => this.#supervisor.create(name, input)); }
  renameRuntime(id: string, name: string) { return this.guard(() => this.#supervisor.rename(id, name)); }
  configuration(id: string) { return this.guard(() => this.#supervisor.configuration(id)); }
  configureRuntime(id: string, input: LocalRuntimeConfigurationInput, expectedRevision?: string) { return this.guard(() => this.#supervisor.updateConfiguration(id, input, undefined, expectedRevision)); }
  runtimeSettings(id: string) { return this.guard(async () => { const configuration = await this.#supervisor.configuration(id);
    return { configuration, revision: createHash("sha256").update(JSON.stringify(configuration)).digest("hex") }; }); }
  skillPackages() { return this.guard(() => this.#configurations.listSkillPackages()); }
  importSkills(input: { files: readonly SkillImportFile[] } | { zip: Buffer }) { return this.guard(() => this.#supervisor.withDeviceReconfiguration(async () => {
    const installed = await importSkillFiles(this.library, "zip" in input ? readSkillZip(input.zip) : input.files);
    const packages = [];
    for (const pkg of installed) packages.push(await this.#configurations.registerUploadedPackage({ ...pkg, inspection: { ...pkg.inspection, metadataSource: pkg.inspection.declarationSource } }));
    return packages;
  })); }
  skillMetadata(id: string) { return this.guard(() => this.#configurations.skillMetadata(id)); }
  updateSkillMetadata(id: string, value: unknown) { return this.guard(() => this.#supervisor.withDeviceReconfiguration(() => this.#configurations.updateSkillMetadata(id, value))); }
  deviceMcpServers() { return this.guard(() => this.#configurations.deviceMcpServers()); }
  configureDeviceMcpServer(server: LocalRuntimeMcpServerInput) { return this.guard(() => this.#supervisor.withDeviceReconfiguration(async () => {
    const result = await this.#configurations.saveDeviceMcpServer(server);
    await this.#supervisor.reloadRunningInstances();
    return result;
  })); }
  removeDeviceMcpServer(id: string) { return this.guard(() => this.#supervisor.withDeviceReconfiguration(async () => {
    await this.#configurations.removeDeviceMcpServer(id);
    await this.#supervisor.reloadRunningInstances();
  })); }
  testDeviceMcpServer(server: LocalRuntimeMcpServerInput) { return this.guard(async () => {
    const draft = await this.#configurations.previewDeviceMcpServer(server);
    const result = await loadMcpToolsFromConfig({ servers: [{ ...draft.registration, timeoutMs: Math.min(draft.registration.timeoutMs ?? 5000, 10000) }] }, { environment: draft.environment });
    return { ok: result.failedServers.length === 0, toolCount: result.tools.length };
  }); }
  testMcpServer(id: string, server: LocalRuntimeMcpServerInput) { return this.guard(async () => {
    await this.#supervisor.configuration(id);
    const draft = await this.#configurations.previewMcpServer(id, server);
    const result = await loadMcpToolsFromConfig({ servers: [{ ...draft.registration, timeoutMs: Math.min(draft.registration.timeoutMs ?? 5000, 10000) }] }, { environment: draft.environment });
    return { ok: result.failedServers.length === 0, toolCount: result.tools.length };
  }); }
  private connectionStore() { if (!this.connectorSettings) throw new LocalManagementError(409, "connector_settings_unavailable"); return this.connectorSettings; }
  connectorCatalog() { return this.guard(async () => this.connectionStore().catalog()); }
  connectors(owner: string) { return this.guard(async () => this.connectionStore().list(owner)); }
  configureConnector(owner: string, input: ConnectorSettingInput) { return this.guard(() => this.#supervisor.withDeviceReconfiguration(async () => {
    const result = await this.connectionStore().save(owner, input);
    await this.#supervisor.reloadRunningInstances();
    return result;
  })); }
  removeConnector(owner: string, connection: string) { return this.guard(() => this.#supervisor.withDeviceReconfiguration(async () => {
    const result = await this.connectionStore().remove(owner, connection);
    await this.#supervisor.reloadRunningInstances();
    return result;
  })); }
  private lifecycle(id: string, action: "start" | "stop" | "drain" | "restart") {
    return this.guard(async () => { await this.refresh(); return this.#supervisor[action](id); });
  }
  startRuntime(id: string) { return this.lifecycle(id, "start"); }
  stopRuntime(id: string) { return this.lifecycle(id, "stop"); }
  drainRuntime(id: string) { return this.lifecycle(id, "drain"); }
  restartRuntime(id: string) { return this.lifecycle(id, "restart"); }
  removeRuntime(id: string) { return this.guard(async () => { await this.refresh(); return this.#supervisor.remove(id); }); }

  runtime(id: string): ManagedLocalRuntime {
    const use = <T>(operation: (facade: RuntimeFacade) => Promise<T>) => this.guard(() =>
      this.#supervisor.withRuntimeUse(id, control => operation(this.service(control).facade)));
    // Resolve the current control on every call, so a retained view survives
    // stop/start/restart without handing callers a stale database or RunService.
    return Object.freeze({
      models: () => use(async facade => facade.models()),
      startRun: (context, input) => use(facade => facade.startRun(context, input)),
      getRun: (context, runId) => use(facade => facade.getRun(context, runId)),
      cancelRun: (context, runId) => use(facade => facade.cancelRun(context, runId)),
      events: (context, runId, afterSeq) => use(facade => facade.events(context, runId, afterSeq)),
      ensureConversation: (context, conversationId, input) => use(facade => facade.ensureConversation(context, conversationId, input)),
      conversations: context => use(facade => facade.conversations(context)),
      conversation: (context, conversationId) => use(facade => facade.conversation(context, conversationId)),
      upload: (context, input) => use(facade => facade.upload(context, input)),
      source: (context, sourceId) => use(facade => facade.source(context, sourceId)),
      artifacts: (context, runId) => use(facade => facade.artifacts(context, runId)),
      readArtifact: (context, runId, artifactId) => use(facade => facade.readArtifact(context, runId, artifactId)),
      previewArtifact: (context, runId, artifactId) => use(facade => facade.previewArtifact(context, runId, artifactId)),
      grantDirectory: (path, name) => use(facade => facade.grantDirectory(path, name)),
      directories: () => use(facade => facade.directories()),
      revokeDirectory: scopeId => use(facade => facade.revokeDirectory(scopeId)),
    } satisfies ManagedLocalRuntime);
  }

  async assertIdle(): Promise<void> {
    if (this.#pending > 0) throw new AppError("CONFLICT", "runtime_operations_prevent_close", 409);
    await this.refresh();
    if (this.#supervisor.hasActiveWork()) throw new AppError("CONFLICT", "runtime_active_runs_prevent_close", 409);
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closing) return this.#closing;
    if (this.#pending > 0) return Promise.reject(new AppError("CONFLICT", "runtime_operations_prevent_close", 409));
    let teardownStarted = false;
    this.#closing = Promise.resolve().then(async () => {
      await this.refresh();
      if (this.#supervisor.hasActiveWork()) throw new AppError("CONFLICT", "runtime_active_runs_prevent_close", 409);
      for (const control of this.#supervisor.controls()) await this.service(control).admissions.flushSettlements();
      await this.#supervisor.withDeviceReconfiguration(() => { teardownStarted = true; return this.#supervisor.close(); });
      this.#closed = true;
    }).finally(() => {
      // A rejected preflight is recoverable. A partially failed teardown must
      // remain fail-closed; never reopen business access to half-closed controls.
      if (!teardownStarted || this.#closed) this.#closing = undefined;
    });
    return this.#closing;
  }
}
