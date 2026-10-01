import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { colorizeTerminalLogLabel, colorizeTerminalLogLine, createStepExecutionStrategyProfile, createWebTools, LlmProviderRegistry, RunService, SkillService } from "@zhujun/agentloop";
import { bundledSkillDirectories } from "@zhujun/agentloop-skills";
import { loadPracticeProfileConfig, loadSkillDirectoriesConfig, loadStepExecutionStrategyProfileConfig, mergeSkillDirectories, webToolsOptionsFromEnvironment } from "../shared/config.ts";
import { HttpResourceImporter } from "./infrastructure/http-resource-importer.ts";
import { AgentLoopRuntimeRunPort } from "./infrastructure/agentloop-runtime-run-port.ts";
import { HostDispatchStore } from "./persistence/host-dispatch-store.ts";
import { createRuntimeHostHttpServer } from "./transport/http.ts";
import { AgentLoopRuntimeHost } from "./application/runtime-host.ts";
import {
  assertRequiredRuntimeCommands,
  assertRequiredRuntimeNodeModules,
  assertRequiredRuntimePythonModules,
  requiredRuntimeCommands,
  requiredRuntimeNodeModules,
  requiredRuntimePythonModules,
} from "./application/runtime-command-preflight.ts";
import { openStateDatabase, stateDatabaseConfigFromEnvironment } from "../shared/persistence/state-database.ts";
import { migrateRuntimeState } from "./persistence/state-migrations.ts";
import { createRuntimeConfigurationShadowOrchestrator } from "./application/configuration/runtime-configuration-shadow-orchestrator.ts";
import { RuntimeConfigurationClient } from "./application/configuration/runtime-configuration-client.ts";
import { ControlPlaneAdmissionRunResolver, RunEnvironmentResolver } from "./application/configuration/run-environment-resolver.ts";
import { SqlRuntimeConfigurationSnapshotCache } from "./persistence/runtime-configuration-snapshot-cache.ts";
import { CloudIntegrationSecretBroker } from "./application/integrations/integration-secret-broker.ts";
import { RuntimeIntegrationDeliveryClient } from "./application/integrations/integration-delivery-client.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
// Like other Skill-owned integrations, pass only the deployment configuration
// path. The mysql Skill reads credentials itself; neither Planner nor model
// context ever receives them.
const steelMarketDatabaseEnvironmentFile = resolve(
  appRoot,
  process.env.STEEL_MARKET_DB_ENV_FILE ?? "./.env",
);
const host = process.env.HOST ?? "127.0.0.1";
const port = integer(process.env.PORT, 8791);
const runtimeId = requiredEnv("RUNTIME_ID");
const databasePath = resolve(appRoot, process.env.DATABASE_PATH ?? `./data/${runtimeId}/agentloop.db`);
// The task workspace is a cluster-wide volume. RunService keeps each conversation
// below conversations/<conversationId>, while runtime-local state stays under data/.
const workspaceRoot = resolve(appRoot, process.env.WORKSPACE_ROOT ?? "./workspace");
const skillPackageStoreRoot = resolve(appRoot, process.env.SKILL_PACKAGE_STORE_ROOT ?? `./data/${runtimeId}/skill-packages`);
const providerConfigPath = resolve(appRoot, process.env.LLM_PROVIDER_CONFIG_PATH ?? "./config/llm-providers.json");
const skillDirectoriesConfigPath = resolve(appRoot, process.env.SKILL_DIRECTORIES_CONFIG_PATH ?? "./config/skill-directories.json");
const stepExecutionStrategyConfigPath = resolve(appRoot, process.env.STEP_EXECUTION_STRATEGY_CONFIG_PATH ?? "./config/step-execution-strategy.json");
const practiceProfileConfigPath = resolve(appRoot, process.env.PRACTICE_PROFILE_CONFIG_PATH ?? "./config/practice-profiles.json");
const routerAttachmentToken = requiredEnv("RUNTIME_ATTACHMENT_TOKEN");
const runtimeDispatchToken = requiredEnv("RUNTIME_DISPATCH_TOKEN");
const routerUrl = process.env.ROUTER_URL ?? "http://127.0.0.1:8788";
const maxConcurrentRuns = positiveInteger(process.env.MAX_CONCURRENT_RUNS, 2);
const heartbeatIntervalMs = positiveInteger(process.env.HEARTBEAT_INTERVAL_MS, 5_000);
const logColorOptions = terminalLogColorOptions();
const runtimeLogLabel = colorizeTerminalLogLabel(`[${runtimeId}]`, runtimeId, logColorOptions);
const configurationSource = runtimeConfigurationSource(process.env.RUNTIME_CONFIGURATION_SOURCE);
// Deployment-owned requirements fail before state initialization or Run dispatch.
// A Skill may use a command only after the Runtime Host has proved it exists.
assertRequiredRuntimeCommands(requiredRuntimeCommands(process.env.RUNTIME_REQUIRED_COMMANDS));
assertRequiredRuntimePythonModules(requiredRuntimePythonModules(process.env.RUNTIME_REQUIRED_PYTHON_MODULES));
assertRequiredRuntimeNodeModules(requiredRuntimeNodeModules(process.env.RUNTIME_REQUIRED_NODE_MODULES));
// File configuration is an explicit development/bootstrap mode only. A
// control-plane target starts from bundled immutable Skill baselines and waits
// for its signed snapshot at admission; it never reads target JSON files.
const customSkillDirectories = configurationSource === "file" ? await loadSkillDirectoriesConfig({ appRoot, configPath: skillDirectoriesConfigPath }) : [];
const skillDirectories = configurationSource === "file" ? mergeSkillDirectories(bundledSkillDirectories(), customSkillDirectories) : bundledSkillDirectories();
const stepExecutionStrategyConfig = configurationSource === "file" ? await loadStepExecutionStrategyProfileConfig(stepExecutionStrategyConfigPath) : undefined;
const practiceProfileCatalog = configurationSource === "file" ? await loadPracticeProfileConfig(practiceProfileConfigPath) : undefined;
const stepExecutionStrategy = stepExecutionStrategyConfig === undefined ? undefined : createStepExecutionStrategyProfile(
  stepExecutionStrategyConfig.profile,
  stepExecutionStrategyConfig.projection,
);
// Web research is a generic Host capability. Source-provider Skills consume it
// through their declared workflow, rather than an incidental shell command or
// a Router-specific integration.
const integrationTools = process.env.WEB_SEARCH_DISABLED === "1" ? [] : createWebTools(webToolsOptionsFromEnvironment(process.env));
const database = await openStateDatabase(stateDatabaseConfigFromEnvironment({
  environment: process.env,
  appRoot,
  sqliteFallbackPath: databasePath,
  environmentPrefix: "AGENTLOOP_RUNTIME_STATE",
}), { schema: "runtime", autoMigrateKernel: false });
await migrateRuntimeState(database);
const dispatchStore = new HostDispatchStore(database, runtimeId);
await dispatchStore.ready();
const providers = configurationSource === "file" ? await LlmProviderRegistry.fromConfigFile(providerConfigPath) : undefined;
const skills = new SkillService(database, {
  // Do not make Skill package synchronization contend on the shared task volume.
  packageStoreRoot: skillPackageStoreRoot,
  skillDirectories,
});
const skillDirectorySync = await skills.syncSkillDirectories();
const createRuns = (registry: LlmProviderRegistry | undefined, configurationSnapshot?: import("@zhujun/agentloop").RuntimeConfigurationSnapshotReference, computerCommandEnvironmentForInvocation?: import("@zhujun/agentloop").ComputerExecutorOptions["commandEnvironmentForInvocation"], policy?: { readonly practiceProfileCatalog?: import("@zhujun/agentloop").PracticeProfileCatalog; readonly stepExecutionStrategy?: import("../shared/config.ts").StepExecutionStrategyProfileConfig }): RunService => new RunService({
  database,
  skills,
  modelFactory: registry === undefined ? () => { throw new Error("configuration_unavailable"); } : (onRetry, modelKey) => registry.create(modelKey, onRetry),
  ...(registry === undefined ? {} : { defaultModelKey: registry.defaultModelKey, modelKeys: registry.modelKeys() }),
  workspaceRoot,
  stepExecutionStrategy: policy === undefined ? stepExecutionStrategy : policy.stepExecutionStrategy === undefined ? undefined : createStepExecutionStrategyProfile(policy.stepExecutionStrategy.profile, policy.stepExecutionStrategy.projection),
  practiceProfileCatalog: policy === undefined ? practiceProfileCatalog : policy.practiceProfileCatalog,
  tools: integrationTools,
  computerCommandEnvironment: configurationSource === "file" ? { STEEL_MARKET_DB_ENV_FILE: steelMarketDatabaseEnvironmentFile } : {},
  ...(computerCommandEnvironmentForInvocation === undefined ? {} : { computerCommandEnvironmentForInvocation }),
  runEventLogSink: (line) => process.stdout.write(`${runtimeLogLabel} ${colorizeTerminalLogLine(line, logColorOptions)}\n`),
  ...(configurationSnapshot === undefined ? {} : { configurationSnapshot }),
});
const runs = createRuns(providers);
const integrationBrokers = new Set<CloudIntegrationSecretBroker>();
const controlPlaneAdmissionRuns = configurationSource === "file" ? undefined : createControlPlaneAdmissionRuns();
const runtimeHost = new AgentLoopRuntimeHost(new AgentLoopRuntimeRunPort(runs), new HttpResourceImporter(runs, routerAttachmentToken), {
  maxConcurrentRuns,
  activeRunCount: activeRunCount,
}, dispatchStore, controlPlaneAdmissionRuns);
const reconcileOwnedRuns = async (): Promise<void> => {
  await runtimeHost.reconcileOwnedRuns(await dispatchStore.ownedRunIds());
};
await reconcileOwnedRuns();
// Shadow delivery is a file-mode migration aid only; a control-plane target
// must not compare against or depend on a local JSON source at runtime.
const configurationShadow = configurationSource === "file" ? createRuntimeConfigurationShadowOrchestrator({
  environment: process.env,
  runtimeId,
  baseline: {
    modelKeys: providers?.modelKeys() ?? [],
    skillDirectoryCount: skillDirectories.length,
    practiceProfileCount: practiceProfileCatalog?.profiles.length ?? 0,
    stepExecutionStrategyProfile: stepExecutionStrategyConfig?.profile ?? "control-plane",
  },
  log: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
}) : undefined;
const server = createRuntimeHostHttpServer(runtimeHost, { dispatchToken: runtimeDispatchToken, models: providers?.modelCatalog().map(({ key, displayName }) => ({ key, displayName })) ?? [] });
server.listen(port, host, () => {
  process.stdout.write(`AgentLoop Runtime Host ${runtimeId} listening on http://${host}:${port}; discovered ${skillDirectorySync.discoveredSkills.length} Skill package(s) from ${skillDirectories.join(", ")}\n`);
  void sendHeartbeat();
  configurationShadow?.start();
});
const heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, heartbeatIntervalMs);
let reconciliationInFlight = false;
const reconciliationTimer = setInterval(() => {
  if (reconciliationInFlight) return;
  reconciliationInFlight = true;
  void reconcileOwnedRuns()
    .catch((error) => process.stderr.write(`Runtime interruption reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`))
    .finally(() => { reconciliationInFlight = false; });
}, heartbeatIntervalMs);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(heartbeatTimer);
  clearInterval(reconciliationTimer);
  configurationShadow?.stop();
  await Promise.all([...integrationBrokers].map((broker) => broker.close()));
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  await database.close();
  process.exitCode = 0;
}
process.on("SIGINT", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
process.on("SIGTERM", () => { void shutdown().catch(() => { process.exitCode = 1; }); });

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("PORT must be a valid TCP port");
  return parsed;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} must be configured`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3_600_000) throw new Error("value must be a positive integer");
  return parsed;
}

function terminalLogColorOptions(): { readonly colorMode: string | undefined; readonly isTTY: boolean | undefined; readonly noColor: string | undefined } {
  return {
    colorMode: process.env.AGENTLOOP_LOG_COLOR,
    isTTY: process.stdout.isTTY,
    noColor: process.env.NO_COLOR,
  };
}

async function activeRunCount(): Promise<number> {
  return await dispatchStore.activeRunCount();
}

function createControlPlaneAdmissionRuns(): ControlPlaneAdmissionRunResolver {
  const deliveryUrl = requiredEnv("CONTROL_PLANE_DELIVERY_URL");
  const workloadToken = requiredEnv("CONTROL_PLANE_WORKLOAD_TOKEN");
  const tenantId = requiredEnv("CONTROL_PLANE_TENANT_ID");
  const target = { plane: "cloud" as const, tenantId, runtimeId, ...(process.env.CONTROL_PLANE_RUNTIME_CLASS === undefined ? {} : { runtimeClass: process.env.CONTROL_PLANE_RUNTIME_CLASS }) };
  const client = new RuntimeConfigurationClient({ deliveryUrl, workloadToken, target });
  const environments = new RunEnvironmentResolver({ delivery: client, cache: new SqlRuntimeConfigurationSnapshotCache(database), environment: process.env, createReceiptId: crypto.randomUUID, loadedSkillPackageHashes: () => skills.discovered().map((item) => item.packageHash), requireSignedSkillArtifacts: true });
  const integrationDelivery = new RuntimeIntegrationDeliveryClient({ deliveryUrl, workloadToken });
  return new ControlPlaneAdmissionRunResolver(target, environments, async (environment) => {
    const broker = new CloudIntegrationSecretBroker({
      target, snapshot: environment.snapshot, delivery: integrationDelivery,
      socketPath: join(tmpdir(), `al-int-${runtimeId.slice(0, 20)}-${environment.snapshot.snapshotId.slice(0, 16)}.sock`),
    });
    await broker.start();
    integrationBrokers.add(broker);
    return new AgentLoopRuntimeRunPort(createRuns(environment.providers, environment.configurationSnapshot, (context) => broker.commandEnvironment(context), environment));
  });
}

function runtimeConfigurationSource(value: string | undefined): "file" | "control_plane" {
  if (value === undefined || value === "control_plane") return "control_plane";
  if (value === "file") return value;
  throw new Error("RUNTIME_CONFIGURATION_SOURCE must be file or control_plane");
}

async function sendHeartbeat(): Promise<void> {
  try {
    const response = await fetch(new URL(`/v1/internal/runtimes/${encodeURIComponent(runtimeId)}/heartbeat`, `${routerUrl.replace(/\/$/, "")}/`), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${runtimeDispatchToken}` },
      body: JSON.stringify({
        status: "ready",
        activeRunCount: await activeRunCount(),
        queuedRunCount: 0,
        maxConcurrentRuns,
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    process.stderr.write(`Runtime Host ${runtimeId} heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
