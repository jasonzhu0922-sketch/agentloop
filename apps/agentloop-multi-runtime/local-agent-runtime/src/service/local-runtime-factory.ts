import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { AppDatabase, LlmProviderRegistry, RunService, SkillService, createStepExecutionStrategyProfile, createWebTools } from "@zhujun/agentloop";
import { bundledSkillDirectories } from "@zhujun/agentloop-skills";
import { loadPracticeProfileConfig, loadSkillDirectoriesConfig, loadStepExecutionStrategyProfileConfig, mergeSkillDirectories, webToolsOptionsFromEnvironment } from "../../../src/shared/config.ts";
import type { LocalAgentOptions } from "../config/local-agent-options.ts";
import { LocalDirectoryScopeStore } from "../persistence/directory-scope-store.ts";
import { LocalRuntimeSupervisorError, type LocalRuntimeControl, type LocalRuntimeDefinition } from "./runtime-supervisor.ts";

/** Creates the isolated kernel, storage and skill catalog for one device Runtime. */
export class LocalRuntimeFactory {
  private readonly input: LocalAgentOptions;

  constructor(input: LocalAgentOptions) { this.input = input; }

  async create(definition: LocalRuntimeDefinition, sharedStorageRoot: string, uploadStorageRoot: string): Promise<LocalRuntimeControl> {
    const environment = this.input.environment ?? process.env;
    const integrationEnvironment = this.input.integrationEnvironment ?? {};
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
    const provider = await LlmProviderRegistry.fromConfigFile(this.input.providerConfigPath, integrationEnvironment);
    const custom = await loadSkillDirectoriesConfig({ appRoot: this.input.appRoot, configPath: this.input.skillDirectoriesConfigPath });
    const packaged = environment.AGENTLOOP_BUNDLED_SKILL_DIRECTORIES?.split(",").map((path) => path.trim()).filter(Boolean);
    const skills = new SkillService(database, {
      packageStoreRoot: this.input.skillPackageStoreRoot,
      skillDirectories: mergeSkillDirectories(packaged?.length ? packaged : bundledSkillDirectories(), custom),
    });
    await skills.syncSkillDirectories();
    const strategy = await loadStepExecutionStrategyProfileConfig(this.input.stepExecutionStrategyConfigPath);
    const practiceProfiles = await loadPracticeProfileConfig(this.input.practiceProfileConfigPath ?? join(this.input.appRoot, "config", "practice-profiles.json"));
    const runs = new RunService({
      database, skills, modelFactory: (onRetry, modelKey) => provider.create(modelKey, onRetry),
      defaultModelKey: provider.defaultModelKey, modelKeys: provider.modelKeys(), workspaceRoot: sharedStorageRoot, sourceStorageRoot,
      ownerScopedWorkspace: true,
      stepExecutionStrategy: createStepExecutionStrategyProfile(strategy.profile, strategy.projection),
      practiceProfileCatalog: practiceProfiles,
      tools: integrationEnvironment.WEB_SEARCH_DISABLED === "1" ? [] : createWebTools(webToolsOptionsFromEnvironment(integrationEnvironment)),
      computerCommandEnvironment: this.input.computerCommandEnvironment,
      ...(this.input.runEventLogSink === undefined ? {} : { runEventLogSink: (line) => this.input.runEventLogSink!(definition, line) }),
    });
    const activeRunIds = new Set<string>();
    const dispatched = await database.prepare("SELECT owner_user_id, remote_run_id FROM local_runtime_dispatches").all() as Array<{ owner_user_id: string; remote_run_id: string }>;
    for (const row of dispatched) {
      try { if ((await runs.get(row.owner_user_id, row.remote_run_id)).status === "running") activeRunIds.add(row.remote_run_id); }
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
