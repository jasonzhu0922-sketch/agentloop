import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { AppDatabase, AppError, LlmProviderRegistry, RunService, SkillService, createStepExecutionStrategyProfile, createWebTools, loadMcpToolsFromConfig, type ModelAdapter, type ModelInvocation, type ModelResponse, type ModelRetryReporter, type ModelStreamSink } from "@zhujun/agentloop";
import { bundledSkillDirectories } from "@zhujun/agentloop-skills";
import { feishuConnector } from "@zhujun/connector-feishu";
import { ConnectorRegistry, ConnectorRuntimeService, environmentConnectorRuntime } from "../../src/connectors/index.ts";
import { loadPracticeProfileConfig, loadStepExecutionStrategyProfileConfig, webToolsOptionsFromEnvironment } from "../../../src/shared/config.ts";
import type { LocalAgentOptions } from "../config/local-agent-options.ts";
import { LocalDirectoryScopeStore } from "../persistence/directory-scope-store.ts";
import type { ResolvedLocalRuntimeConfiguration } from "../persistence/local-runtime-configuration-store.ts";
import type { LocalModelConfigurationStore } from "../persistence/local-model-configuration-store.ts";
import { LocalModelStreamCaptureStore } from "../persistence/model-stream-capture-store.ts";
import { LocalRuntimeSupervisorError, type LocalRuntimeControl, type LocalRuntimeDefinition } from "./runtime-supervisor.ts";
import { LocalAgentStateStore } from "../persistence/local-agent-state-store.ts";
import { consumeModelResponse } from "../../../src/shared/model-proxy.ts";

export class CloudProxyModel implements ModelAdapter {
  readonly limits = { contextWindowTokens: 1_000_000, maxOutputTokens: 1_000_000 };
  readonly completeTimeoutMs = 30 * 60_000;
  readonly operationTimeoutMs = 30 * 60_000;
  readonly reasoningVisibility = "visible" as const;
  private readonly input: LocalAgentOptions;
  private readonly key: string;
  private readonly onRetry?: ModelRetryReporter;

  constructor(input: LocalAgentOptions, key: string, onRetry?: ModelRetryReporter) {
    this.input = input;
    this.key = key;
    this.onRetry = onRetry;
  }
  async complete(invocation: ModelInvocation, signal?: AbortSignal): Promise<ModelResponse> {
    return await this.streamComplete(invocation, async () => undefined, signal);
  }
  async streamComplete(invocation: ModelInvocation, sink: ModelStreamSink, signal?: AbortSignal): Promise<ModelResponse> {
    const state = await new LocalAgentStateStore(this.input.statePath).read();
    if (state.device === undefined || this.input.routerUrl === undefined) throw new LocalRuntimeSupervisorError(409, "cloud_model_device_not_registered");
    const response = await fetch(new URL("/v1/device-agent/model-completions", this.input.routerUrl), {
      method: "POST", headers: { authorization: `Bearer ${state.device.agentToken}`, "content-type": "application/json" },
      body: JSON.stringify({ modelKey: this.key, invocation }), signal,
    });
    return await consumeModelResponse(response, sink, this.onRetry);
  }
}

interface McpStartupIntegration {
  readonly loadedServers: readonly { readonly key: string; readonly toolCount: number }[];
  readonly failedServers: readonly { readonly key: string; readonly message: string }[];
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

/** Creates the isolated kernel, storage and skill catalog for one device Runtime. */
export class LocalRuntimeFactory {
  private readonly input: LocalAgentOptions;
  private readonly modelConfigurations?: LocalModelConfigurationStore;

  constructor(input: LocalAgentOptions, modelConfigurations?: LocalModelConfigurationStore) {
    this.input = input;
    this.modelConfigurations = modelConfigurations;
  }

  async create(
    definition: LocalRuntimeDefinition,
    configuration: ResolvedLocalRuntimeConfiguration,
    sharedStorageRoot: string,
    uploadStorageRoot: string,
  ): Promise<LocalRuntimeControl> {
    const environment = this.input.environment ?? process.env;
    const integrationEnvironment = {
      ...(this.input.integrationEnvironment ?? {}),
      ...configuration.integrationEnvironment,
    };
    const runtimeRoot = this.runtimeRootFor(definition) ?? dirname(this.input.databasePath);
    const databasePath = definition.isDefault ? this.input.databasePath : join(runtimeRoot, "agentloop.db");
    const sourceStorageRoot = this.runtimeUploadRootFor(definition, uploadStorageRoot);
    await mkdir(dirname(databasePath), { recursive: true });
    await mkdir(sharedStorageRoot, { recursive: true });
    await mkdir(this.input.skillPackageStoreRoot, { recursive: true });
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
    const streamCaptures = new LocalModelStreamCaptureStore(join(runtimeRoot, "diagnostics", "model-streams"));
    let localModelConfiguration = this.modelConfigurations?.current() ?? configuration.modelConfiguration;
    const modelEnvironment = { ...integrationEnvironment, ...(localModelConfiguration?.environment ?? {}) };
    // Empty catalogs are editable configuration states. Model admission below
    // rejects unavailable selections while Runtime management remains usable.
    const legacyProvider = localModelConfiguration?.configured === true ? undefined
      : await LlmProviderRegistry.fromConfigFile(this.input.providerConfigPath, modelEnvironment, { streamRawCaptureWriter: streamCaptures.capture });
    let provider = localModelConfiguration?.configured === true
      ? localModelConfiguration.registryConfig === undefined ? undefined : LlmProviderRegistry.fromConfigObject(localModelConfiguration.registryConfig, modelEnvironment, { streamRawCaptureWriter: streamCaptures.capture })
      : legacyProvider;
    const currentModels = () => {
      const latest = this.modelConfigurations?.current() ?? configuration.modelConfiguration;
      if (latest !== localModelConfiguration) {
        const updated = latest?.configured !== true ? legacyProvider : latest.registryConfig === undefined ? undefined : LlmProviderRegistry.fromConfigObject(
          latest.registryConfig, { ...integrationEnvironment, ...latest.environment }, { streamRawCaptureWriter: streamCaptures.capture },
        );
        provider = updated;
        localModelConfiguration = latest;
      }
      return { provider, configuration: localModelConfiguration };
    };
    const packaged = environment.AGENTLOOP_BUNDLED_SKILL_DIRECTORIES?.split(",").map((path) => path.trim()).filter(Boolean);
    const skills = new SkillService(database, {
      packageStoreRoot: this.input.skillPackageStoreRoot,
      skillDirectories: packaged?.length ? packaged : bundledSkillDirectories(),
      skillPackageRoots: configuration.customSkillDirectories,
    });
    await skills.syncSkillDirectories();
    const strategy = await loadStepExecutionStrategyProfileConfig(this.input.stepExecutionStrategyConfigPath);
    const practiceProfiles = await loadPracticeProfileConfig(this.input.practiceProfileConfigPath ?? join(this.input.appRoot, "config", "practice-profiles.json"));
    const connectorRegistry = new ConnectorRegistry();
    connectorRegistry.register(feishuConnector);
    const connectorRuntimeService = new ConnectorRuntimeService(
      connectorRegistry,
      environmentConnectorRuntime(undefined, integrationEnvironment),
    );
    const mcpIntegration = await loadMcpToolsFromConfig(
      { servers: configuration.mcpServers },
      { environment: integrationEnvironment },
    );
    const runs = new RunService({
      requireExplicitModel: true,
      database, skills, modelFactory: (onRetry, modelKey) => {
        const { provider, configuration: modelConfiguration } = currentModels();
        if (modelKey === undefined || modelKey.length === 0) throw new AppError("MODEL_ERROR", "model_required", 400);
        if (typeof modelKey === "string" && modelKey.startsWith("cloud:")) {
          if (modelConfiguration?.reuseCloudModels !== true) throw new AppError("MODEL_ERROR", "cloud_model_reuse_disabled", 409);
          if (modelKey.length === "cloud:".length) throw new AppError("MODEL_ERROR", "model_key_invalid", 400);
          return new CloudProxyModel(this.input, modelKey.slice("cloud:".length), onRetry);
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
      stepExecutionStrategy: createStepExecutionStrategyProfile(strategy.profile, strategy.projection),
      practiceProfileCatalog: practiceProfiles,
      runToolProvider: connectorRuntimeService,
      tools: [
        ...(integrationEnvironment.WEB_SEARCH_DISABLED === "1" ? [] : createWebTools(webToolsOptionsFromEnvironment(integrationEnvironment))),
        ...mcpIntegration.tools,
      ],
      computerCommandEnvironment: this.input.computerCommandEnvironment,
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
    const activeRunIds = new Set<string>();
    const dispatched = await database.prepare("SELECT owner_user_id, remote_run_id FROM local_runtime_dispatches").all() as Array<{ owner_user_id: string; remote_run_id: string }>;
    const restoredAt = Date.now();
    for (const row of dispatched) {
      try { if (shouldRetainRestoredRunActivity(await runs.get(row.owner_user_id, row.remote_run_id), restoredAt)) activeRunIds.add(row.remote_run_id); }
      catch { /* Orphaned ledger rows are not active admissions. */ }
    }
    return { ...definition, database, scopes, runs,
      get modelKeys() { return currentModels().provider?.modelKeys().map((key) => `local:${key}`) ?? []; }, activeRunIds };
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
    if (suffix === "" || suffix === ".." || suffix.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`)) {
      throw new LocalRuntimeSupervisorError(500, message);
    }
  }
}
