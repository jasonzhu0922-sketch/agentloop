import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppDatabase, AppError, LlmProviderRegistry, RunService, SkillService, createRuntimeCapabilitySnapshotFromSources, createWebTools, loadMcpToolsFromConfig, type LoadedMcpIntegration, type RuntimeCapabilitySnapshot, type WebToolsOptions } from "@zhujun/agentloop";
import { createLocalMemoryPlugin, MemorySettlementWorker, type MemorySettlementModel } from "@zhujun/agentloop-memory";
import { bundledSkillDirectories } from "@zhujun/agentloop-skills";
import { ConnectorRegistry, ConnectorRuntimeService, environmentConnectorRuntime, loadConnectorModules } from "../connectors/index.ts";
import type { LocalRuntimeHostOptions, LocalModelConfigurationPort, LocalConnectorConfigurationPort, LocalModelProviderPort, ResolvedLocalRuntimeConfiguration, LocalRuntimeControl, LocalRuntimeDefinition } from "../contracts/host.ts";
import { LocalRuntimeSupervisorError } from "../contracts/host.ts";
import { LocalDirectoryScopeStore } from "../persistence/directory-scope-store.ts";
import { LocalModelStreamCaptureStore } from "../persistence/model-stream-capture-store.ts";
import { LocalMemorySettlementReader } from "../memory/local-memory-settlement-reader.ts";
import { LocalRuntimeDatabaseRegistry } from "../memory/local-runtime-database-registry.ts";
import { initializeLocalRunAdmissions } from "./local-run-admission.ts";

interface McpStartupIntegration {
  readonly loadedServers: readonly { readonly key: string; readonly toolCount: number }[];
  readonly failedServers: readonly { readonly key: string; readonly message: string }[];
}

/** Configuration knowledge is local metadata, never a Run execution grant. */
function configuredMcpCapabilitySnapshot(
  configuration: ResolvedLocalRuntimeConfiguration,
  integration: LoadedMcpIntegration,
): RuntimeCapabilitySnapshot {
  const loaded = new Set(integration.loadedServers.map((server) => server.key));
  const failed = new Set(integration.failedServers.map((server) => server.key));
  return createRuntimeCapabilitySnapshotFromSources({
    scope: "runtime_configured",
    capturedAt: Date.now(),
    sources: configuration.mcpServers.map((server) => ({
      label: server.displayName ?? "Configured MCP service",
      transport: server.transport,
      state: loaded.has(server.key)
        ? "loaded_for_runtime"
        : failed.has(server.key) ? "load_failed" : "configured_for_runtime",
      capabilities: server.capabilities,
      operations: integration.tools
        .filter((tool) => tool.source?.id === server.key)
        .map((tool) => ({
          label: tool.source?.toolName ?? tool.name,
          description: tool.description,
        })),
      identityValues: [server.key, ...(server.aliases ?? [])],
    })),
  });
}

export const RESTORED_RUN_ACTIVITY_WINDOW_MS = 10 * 60 * 1_000;

export function shouldRetainRestoredRunActivity(
  run: { readonly status: string; readonly createdAt: number },
  now = Date.now(),
): boolean {
  return run.status === "running" && now - run.createdAt <= RESTORED_RUN_ACTIVITY_WINDOW_MS;
}

export function localRuntimeMcpStartupLogLines(integration: McpStartupIntegration): readonly { readonly stream: "stdout" | "stderr"; readonly text: string }[] {
  return [
    ...integration.loadedServers.map((server) => ({
      stream: "stdout" as const,
      text: `Local Runtime MCP server ${server.key} loaded ${server.toolCount} tool(s)`,
    })),
    ...integration.failedServers.map((server) => ({
      stream: "stderr" as const,
      text: `Local Runtime MCP server ${server.key} failed: ${server.message}`,
    })),
  ];
}

export function redactMcpDiagnostic(message: string, secretValues: readonly string[]): string {
  const variants = new Set<string>();
  for (const value of secretValues) {
    if (value.length === 0) continue;
    variants.add(value);
    variants.add(encodeURIComponent(value));
    variants.add(new URLSearchParams({ value }).toString().slice("value=".length));
  }
  return [...variants]
    .sort((left, right) => right.length - left.length)
    .reduce((result, value) => result.replaceAll(value, "[redacted]"), message);
}

function localSettlementModel(
  modelKey: string,
  resolveProvider: () => LocalModelProviderPort | undefined,
): MemorySettlementModel {
  if (!modelKey.startsWith("local:") || modelKey.length <= "local:".length) {
    throw new LocalRuntimeSupervisorError(400, "memory_settlement_model_must_be_local");
  }
  return {
    modelKey,
    complete: async ({ runId, systemPrompt, input, signal }) => {
      const provider = resolveProvider();
      if (provider === undefined) throw new LocalRuntimeSupervisorError(409, "memory_settlement_model_unavailable");
      const model = provider.create(modelKey.slice("local:".length));
      const response = await model.complete({
        runId,
        phase: "compaction",
        systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(input) }],
        tools: [],
        maxOutputTokens: 6_000,
      }, signal);
      return { content: response.content, usage: response.usage };
    },
  };
}

/** Creates the isolated kernel, storage and skill catalog for one device Runtime. */
export class LocalRuntimeFactory {
  private readonly input: LocalRuntimeHostOptions;
  private readonly modelConfigurations?: LocalModelConfigurationPort;
  private readonly connectorConfigurations?: LocalConnectorConfigurationPort;
  private readonly databases: LocalRuntimeDatabaseRegistry;

  constructor(input: LocalRuntimeHostOptions, modelConfigurations?: LocalModelConfigurationPort, connectorConfigurations?: LocalConnectorConfigurationPort) {
    this.input = input;
    this.modelConfigurations = modelConfigurations;
    this.connectorConfigurations = connectorConfigurations;
    this.databases = input.databases ?? new LocalRuntimeDatabaseRegistry();
  }

  async create(
    definition: LocalRuntimeDefinition,
    configuration: ResolvedLocalRuntimeConfiguration,
    sharedStorageRoot: string,
    uploadStorageRoot: string,
    webToolsOptions: WebToolsOptions | undefined = this.input.webToolsOptions,
  ): Promise<LocalRuntimeControl> {
    const environment = this.input.environment ?? process.env;
    const integrationEnvironment = {
      ...(this.input.integrationEnvironment ?? {}),
      ...configuration.integrationEnvironment,
    };
    const activeWebSearch = integrationEnvironment.WEB_SEARCH_DISABLED === "1" ? undefined : configuration.webSearch ?? webToolsOptions;
    const runtimeRoot = this.runtimeRootFor(definition) ?? dirname(this.input.databasePath);
    const databasePath = definition.isDefault ? this.input.databasePath : join(runtimeRoot, "agentloop.db");
    const sourceStorageRoot = this.runtimeUploadRootFor(definition, uploadStorageRoot);
    await mkdir(dirname(databasePath), { recursive: true });
    await mkdir(sharedStorageRoot, { recursive: true });
    await mkdir(this.input.skillPackageStoreRoot, { recursive: true });
    const database = new AppDatabase(databasePath);
    this.databases.register(definition.id, database);
    // Memory is an explicitly opted-in Local Agent feature. When disabled we
    // do not even create the SQLite file, plugin, settlement worker, or timer.
    const memoryEnabled = configuration.memory?.enabled === true;
    let memoryDatabase: AppDatabase | undefined;
    let memory: Awaited<ReturnType<typeof createLocalMemoryPlugin>> | undefined;
    let memoryTenantId: string | undefined;
    let settlementWorker: MemorySettlementWorker | undefined;
    let settlementTimer: NodeJS.Timeout | undefined;
    let planningRecoveryTimer: NodeJS.Timeout | undefined;
    try {
      if (memoryEnabled) {
        const settlementKey = configuration.memory?.settlementModelKey;
        if (!settlementKey) throw new LocalRuntimeSupervisorError(400, "memory_settlement_model_required");
        if (!settlementKey.startsWith("local:") || settlementKey.length <= "local:".length) {
          throw new LocalRuntimeSupervisorError(400, "memory_settlement_model_must_be_local");
        }
        // Memory is device-local and shared by all Local Runtime instances. Run
        // evidence remains in each Runtime database; only the Memory SQLite file
        // is shared, so Runtime lifecycle cannot fork user preferences.
        const installationId = await this.input.identity?.installationId();
        if (!installationId) throw new LocalRuntimeSupervisorError(409, "local_runtime_identity_required");
        memoryDatabase = new AppDatabase(join(dirname(this.input.databasePath), "memory.db"));
        // A device is the local tenant boundary. Cloud tenant/user identity never
        // enters the Memory store or crosses the model proxy.
        memoryTenantId = `local-device:${installationId}`;
        memory = await createLocalMemoryPlugin({
          database: memoryDatabase,
          resolveRunScope: async (runId) => {
            const row = await database.prepare("SELECT owner_user_id, conversation_id, parent_run_id FROM runs WHERE id = ?").get(runId) as { owner_user_id: string; conversation_id: string | null; parent_run_id: string | null } | undefined;
            if (row === undefined) return undefined;
            return {
              tenantId: memoryTenantId!,
              ownerUserId: row.owner_user_id,
              runId,
              ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
              ...(row.parent_run_id === null ? {} : { parentRunId: row.parent_run_id }),
            };
          },
        });
      }
      await database.exec(`
        CREATE TABLE IF NOT EXISTS local_runtime_dispatches (
          dispatch_key TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
          remote_run_id TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS local_runtime_dispatches_run_idx ON local_runtime_dispatches(remote_run_id);
      `);
      await initializeLocalRunAdmissions(database);
      const scopes = new LocalDirectoryScopeStore(database);
      await scopes.ready();
      const streamCaptures = new LocalModelStreamCaptureStore(join(runtimeRoot, "diagnostics", "model-streams"));
      let localModelConfiguration = this.modelConfigurations?.current() ?? configuration.modelConfiguration;
      const modelEnvironment = { ...integrationEnvironment, ...(localModelConfiguration?.environment ?? {}) };
      // Empty catalogs are editable configuration states. Model admission below
      // rejects unavailable selections while Runtime management remains usable.
      const legacyProvider = this.input.models !== undefined || localModelConfiguration?.configured === true || this.input.providerConfigPath === undefined ? undefined
        : await LlmProviderRegistry.fromConfigFile(this.input.providerConfigPath, modelEnvironment, { streamRawCaptureWriter: streamCaptures.capture });
      let provider: LocalModelProviderPort | undefined = this.input.models ?? (localModelConfiguration?.configured === true
        ? localModelConfiguration.registryConfig === undefined ? undefined : LlmProviderRegistry.fromConfigObject(localModelConfiguration.registryConfig, modelEnvironment, { streamRawCaptureWriter: streamCaptures.capture })
        : legacyProvider);
      const currentModels = () => {
        const latest = this.modelConfigurations?.current() ?? configuration.modelConfiguration;
        if (this.input.models === undefined && latest !== localModelConfiguration) {
          const updated = latest?.configured !== true ? legacyProvider : latest.registryConfig === undefined ? undefined : LlmProviderRegistry.fromConfigObject(
            latest.registryConfig, { ...integrationEnvironment, ...latest.environment }, { streamRawCaptureWriter: streamCaptures.capture },
          );
          provider = updated;
          localModelConfiguration = latest;
        }
        return { provider, configuration: localModelConfiguration };
      };
      const assertModelAvailable = (key: string) => {
        const latest = currentModels();
        if (key.startsWith("local:") && latest.provider?.modelKeys().includes(key.slice("local:".length))) return;
        if (key.startsWith("cloud:") && key.length > "cloud:".length) {
          if (latest.configuration?.reuseCloudModels !== true) throw new AppError("MODEL_ERROR", "cloud_model_reuse_disabled", 409);
          if (this.input.cloudModelFactory === undefined) throw new AppError("MODEL_ERROR", "cloud_model_unavailable", 409);
          return;
        }
        throw new AppError("MODEL_ERROR", "local_model_unavailable", 409);
      };
      if (memory !== undefined && memoryTenantId !== undefined) {
        const settlementModel = configuration.memory?.settlementModelKey === undefined
          ? undefined
          : localSettlementModel(
            configuration.memory.settlementModelKey,
            () => currentModels().provider,
          );
        settlementWorker = new MemorySettlementWorker({
          store: memory.store,
          reader: new LocalMemorySettlementReader(() => this.databases.list(), memoryTenantId),
          consolidate: true,
          requireSettlementModel: true,
          experienceBatchSize: 10,
          ...(settlementModel === undefined ? {} : { settlementModel }),
        });
      }
      const packaged = environment.AGENTLOOP_BUNDLED_SKILL_DIRECTORIES?.split(",").map((path) => path.trim()).filter(Boolean);
      const skills = new SkillService(database, {
        packageStoreRoot: this.input.skillPackageStoreRoot,
        skillDirectories: packaged?.length ? packaged : bundledSkillDirectories(),
        skillPackageRoots: configuration.customSkillDirectories,
      });
      await skills.syncSkillDirectories();
      const policy = await this.input.loadExecutionPolicy?.();
      const connectorConfiguration = this.connectorConfigurations === undefined
        ? undefined
        : await this.connectorConfigurations.resolve(definition.id);
      const connectorRegistry = new ConnectorRegistry();
      for (const connectorModule of await loadConnectorModules({
        baseDirectory: this.input.extensionBaseDirectory,
        registrations: connectorConfiguration?.modules ?? [],
      })) {
        connectorRegistry.register(connectorModule);
      }
      const connectorRuntimeService = new ConnectorRuntimeService(
        connectorRegistry,
        connectorConfiguration?.runtime ?? environmentConnectorRuntime([], {}),
      );
      const mcpIntegration = await loadMcpToolsFromConfig(
        { servers: configuration.mcpServers },
        { environment: integrationEnvironment },
      );
      const runs = new RunService({
        requireExplicitModel: true,
        database, skills, ...(memory === undefined ? {} : { memory }), modelFactory: (onRetry, modelKey) => {
          const { provider, configuration: modelConfiguration } = currentModels();
          if (modelKey === undefined || modelKey.length === 0) throw new AppError("MODEL_ERROR", "model_required", 400);
          if (typeof modelKey === "string" && modelKey.startsWith("cloud:")) {
            if (modelConfiguration?.reuseCloudModels !== true) throw new AppError("MODEL_ERROR", "cloud_model_reuse_disabled", 409);
            if (modelKey.length === "cloud:".length) throw new AppError("MODEL_ERROR", "model_key_invalid", 400);
            if (this.input.cloudModelFactory === undefined) throw new AppError("MODEL_ERROR", "cloud_model_unavailable", 409);
            return this.input.cloudModelFactory(onRetry, modelKey.slice("cloud:".length));
          }
          if (typeof modelKey === "string" && modelKey.startsWith("local:")) {
            if (provider === undefined) throw new AppError("MODEL_ERROR", "local_model_unavailable", 409);
            return provider.create(modelKey.slice("local:".length), onRetry);
          }
          throw new AppError("MODEL_ERROR", "model_source_required: choose a model from the Local Runtime catalog", 400);
        },
        ...(this.input.planningMaxTurns === undefined ? {} : { maxPlanningTurns: this.input.planningMaxTurns }),
        ...(this.input.stepMaxTurns === undefined ? {} : { maxSteps: this.input.stepMaxTurns }),
        workspaceRoot: sharedStorageRoot, sourceStorageRoot,
        ownerScopedWorkspace: true,
        stepExecutionStrategy: policy?.stepExecutionStrategy,
        practiceProfileCatalog: policy?.practiceProfileCatalog,
        runToolProvider: connectorRuntimeService,
        runtimeCapabilitySnapshotProvider: () => [configuredMcpCapabilitySnapshot(configuration, mcpIntegration)],
        tools: [
          ...(activeWebSearch === undefined ? [] : createWebTools(activeWebSearch)),
          ...mcpIntegration.tools,
        ],
        computerCommandEnvironment: this.input.computerCommandEnvironment,
        computerCommandSandbox: this.input.computerCommandSandbox,
        ...(this.input.runEventLogSink === undefined ? {} : { runEventLogSink: (line) => this.input.runEventLogSink!(definition, line) }),
      });
      const secretValues = Object.values(configuration.integrationEnvironment).filter((value): value is string => typeof value === "string" && value.length > 0);
      const sanitizedMcpIntegration = {
        ...mcpIntegration,
        failedServers: mcpIntegration.failedServers.map((server) => ({
          ...server,
          message: redactMcpDiagnostic(server.message, secretValues),
        })),
      };
      for (const line of localRuntimeMcpStartupLogLines(sanitizedMcpIntegration)) {
        (line.stream === "stdout" ? process.stdout : process.stderr).write(`${line.text}\n`);
      }
      // A configured MCP source is part of this Runtime's execution contract.
      // Do not construct a superficially-ready Runtime with a partial tool
      // catalog: Router admission would succeed and the first Run would only
      // fail later with CAPABILITY_UNAVAILABLE.  Keep the diagnostic limited to
      // source keys; the loader's messages may contain endpoint or credential
      // details even after redaction.
      if (mcpIntegration.failedServers.length > 0) {
        throw new LocalRuntimeSupervisorError(
          503,
          `mcp_startup_failed:${mcpIntegration.failedServers.map((server) => server.key).join(",")}`,
        );
      }
      if (settlementWorker !== undefined) {
        settlementTimer = setInterval(() => { void settlementWorker!.runOnce(); }, 5_000);
        settlementTimer.unref();
      }
      const activeRunIds = new Set<string>();
      const admitted = await database.prepare(`SELECT a.run_id FROM local_run_admissions a
        JOIN runs r ON r.id = a.run_id AND r.owner_user_id = a.owner_user_id
        LEFT JOIN run_recovery_states recovery ON recovery.run_id = r.id
        WHERE r.status = 'running' AND (recovery.state IS NULL OR recovery.state NOT IN ('waiting_recovery', 'waiting_user')
          OR recovery.planning_token IS NOT NULL OR recovery.resume_token IS NOT NULL)`).all() as Array<{ run_id: string }>;
      for (const row of admitted) activeRunIds.add(row.run_id);
      const dispatched = await database.prepare("SELECT owner_user_id, remote_run_id FROM local_runtime_dispatches").all() as Array<{ owner_user_id: string; remote_run_id: string }>;
      const restoredAt = Date.now();
      for (const row of dispatched) {
        try { if (shouldRetainRestoredRunActivity(await runs.get(row.owner_user_id, row.remote_run_id), restoredAt)) activeRunIds.add(row.remote_run_id); }
        catch { /* Orphaned ledger rows are not active admissions. */ }
      }
      await runs.reconcilePlanningRecoveries();
      await runs.reconcileRunInputs();
      planningRecoveryTimer = setInterval(() => {
        void runs.reconcilePlanningRecoveries().then(() => runs.reconcileRunInputs()).catch((error) => {
          if (process.env.AGENTLOOP_DEBUG_ERRORS === "1") console.error(error);
        });
      }, 10_000);
      planningRecoveryTimer.unref();
      return { ...definition, database, scopes, runs,
        ...(memory === undefined || memoryTenantId === undefined ? {} : { memory: { store: memory.store, tenantId: memoryTenantId } }),
        close: async () => {
          if (settlementTimer !== undefined) clearInterval(settlementTimer);
          if (planningRecoveryTimer !== undefined) clearInterval(planningRecoveryTimer);
          try { await memory?.close?.(); }
          finally {
            try { await memoryDatabase?.close(); }
            finally { this.databases.unregister(definition.id, database); }
          }
        },
        connectorConnectionIds: connectorConfiguration?.connections.filter((connection) => connection.status === "active").map((connection) => connection.id) ?? [],
        get modelKeys() { return currentModels().provider?.modelKeys().map((key) => `local:${key}`) ?? []; }, assertModelAvailable, activeRunIds };
    } catch (error) {
      if (settlementTimer !== undefined) clearInterval(settlementTimer);
      if (planningRecoveryTimer !== undefined) clearInterval(planningRecoveryTimer);
      await memory?.close?.().catch(() => undefined);
      try { await memoryDatabase?.close(); }
      finally {
        this.databases.unregister(definition.id, database);
        await database.close();
      }
      throw error;
    }
  }

  runtimeRootFor(definition: LocalRuntimeDefinition): string | undefined {
    if (definition.isDefault) return undefined;
    const dataRoot = resolve(this.input.runtimeDataRoot ?? join(dirname(this.input.databasePath), "runtimes"));
    const runtimeRoot = resolve(dataRoot, definition.storageKey);
    this.assertChild(dataRoot, runtimeRoot, "runtime_storage_key_outside_data_root");
    return runtimeRoot;
  }

  runtimeUploadRootFor(definition: LocalRuntimeDefinition, uploadStorageRoot: string): string {
    const root = resolve(uploadStorageRoot);
    const target = resolve(root, definition.storageKey);
    this.assertChild(root, target, "runtime_upload_storage_key_outside_root");
    return target;
  }

  private assertChild(root: string, target: string, message: string): void {
    const suffix = relative(root, target);
    if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      throw new LocalRuntimeSupervisorError(500, message);
    }
  }
}
