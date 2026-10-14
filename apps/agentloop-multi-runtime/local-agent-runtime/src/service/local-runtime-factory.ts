import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { AppDatabase, LlmProviderRegistry, RunService, SkillService, createStepExecutionStrategyProfile, createWebTools, loadMcpToolsFromConfig } from "@zhujun/agentloop";
import { bundledSkillDirectories } from "@zhujun/agentloop-skills";
import { loadPracticeProfileConfig, loadStepExecutionStrategyProfileConfig, webToolsOptionsFromEnvironment } from "../../../src/shared/config.ts";
import type { LocalAgentOptions } from "../config/local-agent-options.ts";
import { LocalDirectoryScopeStore } from "../persistence/directory-scope-store.ts";
import type { ResolvedLocalRuntimeConfiguration } from "../persistence/local-runtime-configuration-store.ts";
import { LocalModelStreamCaptureStore } from "../persistence/model-stream-capture-store.ts";
import { LocalRuntimeSupervisorError, type LocalRuntimeControl, type LocalRuntimeDefinition } from "./runtime-supervisor.ts";

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

  constructor(input: LocalAgentOptions) { this.input = input; }

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
    const provider = await LlmProviderRegistry.fromConfigFile(this.input.providerConfigPath, integrationEnvironment, {
      streamRawCaptureWriter: streamCaptures.capture,
    });
    const packaged = environment.AGENTLOOP_BUNDLED_SKILL_DIRECTORIES?.split(",").map((path) => path.trim()).filter(Boolean);
    const skills = new SkillService(database, {
      packageStoreRoot: this.input.skillPackageStoreRoot,
      skillDirectories: packaged?.length ? packaged : bundledSkillDirectories(),
      skillPackageRoots: configuration.customSkillDirectories,
    });
    await skills.syncSkillDirectories();
    const strategy = await loadStepExecutionStrategyProfileConfig(this.input.stepExecutionStrategyConfigPath);
    const practiceProfiles = await loadPracticeProfileConfig(this.input.practiceProfileConfigPath ?? join(this.input.appRoot, "config", "practice-profiles.json"));
    const mcpIntegration = await loadMcpToolsFromConfig(
      { servers: configuration.mcpServers },
      { environment: integrationEnvironment },
    );
    const runs = new RunService({
      database, skills, modelFactory: (onRetry, modelKey) => provider.create(modelKey, onRetry),
      ...(this.input.planningMaxTurns === undefined ? {} : { maxPlanningTurns: this.input.planningMaxTurns }),
      ...(this.input.stepMaxTurns === undefined ? {} : { maxSteps: this.input.stepMaxTurns }),
      defaultModelKey: provider.defaultModelKey, modelKeys: provider.modelKeys(), workspaceRoot: sharedStorageRoot, sourceStorageRoot,
      ownerScopedWorkspace: true,
      stepExecutionStrategy: createStepExecutionStrategyProfile(strategy.profile, strategy.projection),
      practiceProfileCatalog: practiceProfiles,
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
    return { ...definition, database, scopes, runs, modelKeys: provider.modelKeys(), activeRunIds };
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
