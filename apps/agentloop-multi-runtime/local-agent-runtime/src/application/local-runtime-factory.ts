import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { AppDatabase, LlmProviderRegistry, RunService, SkillService, createStepExecutionStrategyProfile, createWebTools, type RuntimeConfigurationSnapshotReference } from "@zhujun/agentloop";
import { bundledSkillDirectories } from "@zhujun/agentloop-skills";
import { loadPracticeProfileConfig, loadSkillDirectoriesConfig, loadStepExecutionStrategyProfileConfig, mergeSkillDirectories, webToolsOptionsFromEnvironment } from "../../../src/shared/config.ts";
import type { LocalAgentOptions } from "./local-agent-options.ts";
import { LocalDirectoryScopeStore } from "../persistence/directory-scope-store.ts";
import { LocalRuntimeSupervisorError, type LocalRuntimeControl, type LocalRuntimeDefinition } from "./runtime-supervisor.ts";
import { LocalDeliveryClient, LocalDeliveryError } from "../control-plane/local-delivery-client.ts";
import { LocalSnapshotCache } from "../control-plane/local-snapshot-cache.ts";
import type { RuntimeConfigurationSnapshot } from "../../../control-plane/contracts/index.ts";

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
    const resolved = await this.resolveConfiguration(definition, runtimeRoot, integrationEnvironment);
    const provider = resolved === undefined
      ? await LlmProviderRegistry.fromConfigFile(this.input.providerConfigPath, integrationEnvironment)
      : LlmProviderRegistry.fromConfigObject(resolved.snapshot.modelRoute!.providerConfiguration, integrationEnvironment);
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
      computerCommandEnvironment: resolved === undefined ? this.input.computerCommandEnvironment : withoutEnterpriseInfoPath(this.input.computerCommandEnvironment),
      ...(resolved === undefined ? {} : { configurationSnapshot: resolved.reference }),
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

  private async resolveConfiguration(definition: LocalRuntimeDefinition, runtimeRoot: string, environment: Readonly<Record<string, string | undefined>>): Promise<{ readonly snapshot: import("../../../control-plane/contracts/index.ts").RuntimeConfigurationSnapshot; readonly reference: RuntimeConfigurationSnapshotReference } | undefined> {
    const controlPlane = this.input.controlPlane;
    if (controlPlane === undefined) return undefined;
    const target = { plane: "local" as const, tenantId: controlPlane.tenantId, runtimeId: definition.id, deviceId: controlPlane.deviceId };
    const cache = new LocalSnapshotCache(join(runtimeRoot, "control-plane-snapshot.json"));
    const delivery = new LocalDeliveryClient({ deliveryUrl: controlPlane.deliveryUrl, deviceToken: controlPlane.deviceToken, target });
    let snapshot: RuntimeConfigurationSnapshot;
    try {
      snapshot = await delivery.desiredSnapshot();
      if (snapshot.modelRoute === undefined) throw new LocalRuntimeSupervisorError(503, "configuration_unavailable");
      await delivery.reportLoaded(snapshot, (releaseId) => `local-loaded:${snapshot.snapshotId}:${releaseId}`);
      await cache.put(snapshot);
    } catch (error) {
      if (error instanceof LocalDeliveryError && error.code === "target_not_authorized") throw new LocalRuntimeSupervisorError(403, "device_not_authorized");
      const cached = await cache.get(target);
      if (cached === undefined || cached.modelRoute === undefined) throw new LocalRuntimeSupervisorError(503, "configuration_unavailable");
      snapshot = cached;
    }
    const modelRoute = snapshot.modelRoute;
    if (modelRoute === undefined) throw new LocalRuntimeSupervisorError(503, "configuration_unavailable");
    return { snapshot, reference: { snapshotId: snapshot.snapshotId, configurationRevision: snapshot.configurationRevision, releases: [
      { kind: "model_route", releaseId: modelRoute.releaseId, contentHash: modelRoute.contentHash },
      ...snapshot.integrations.map((item) => ({ kind: "integration" as const, releaseId: item.releaseId, contentHash: item.contentHash })),
      ...snapshot.skills.map((item) => ({ kind: "skill" as const, releaseId: item.releaseId, contentHash: item.contentHash, packageHash: item.packageHash })),
      ...snapshot.policies.map((item) => ({ kind: "policy" as const, releaseId: item.releaseId, contentHash: item.contentHash })),
    ] } };
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

function withoutEnterpriseInfoPath(environment: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | undefined {
  if (environment === undefined) return undefined;
  const { ENTERPRISE_INFO_ENV_FILE: _removed, ...remaining } = environment;
  return remaining;
}
