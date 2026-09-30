import { resolve } from "node:path";
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

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
// This non-sensitive path is the only Enterprise Info setting passed to
// Skill-owned commands. The script reads credentials from the deployment file.
const enterpriseInfoEnvironmentFile = resolve(
  appRoot,
  process.env.ENTERPRISE_INFO_ENV_FILE ?? "./.env",
);
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
// Skill roots are application configuration, not a Router or task input. Load
// them before creating runtime state so a bad deployment fails without a
// partially initialized Host database.
const customSkillDirectories = await loadSkillDirectoriesConfig({ appRoot, configPath: skillDirectoriesConfigPath });
const skillDirectories = mergeSkillDirectories(bundledSkillDirectories(), customSkillDirectories);
const stepExecutionStrategyConfig = await loadStepExecutionStrategyProfileConfig(stepExecutionStrategyConfigPath);
const practiceProfileCatalog = await loadPracticeProfileConfig(practiceProfileConfigPath);
const stepExecutionStrategy = createStepExecutionStrategyProfile(
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
const createRuns = (registry: LlmProviderRegistry | undefined): RunService => new RunService({
  database,
  skills,
  modelFactory: registry === undefined ? () => { throw new Error("configuration_unavailable"); } : (onRetry, modelKey) => registry.create(modelKey, onRetry),
  ...(registry === undefined ? {} : { defaultModelKey: registry.defaultModelKey, modelKeys: registry.modelKeys() }),
  workspaceRoot,
  stepExecutionStrategy,
  practiceProfileCatalog,
  tools: integrationTools,
  computerCommandEnvironment: {
    ENTERPRISE_INFO_ENV_FILE: enterpriseInfoEnvironmentFile,
    STEEL_MARKET_DB_ENV_FILE: steelMarketDatabaseEnvironmentFile,
  },
  runEventLogSink: (line) => process.stdout.write(`${runtimeLogLabel} ${colorizeTerminalLogLine(line, logColorOptions)}\n`),
});
const runs = createRuns(providers);
const controlPlaneAdmissionRuns = configurationSource === "file" ? undefined : createControlPlaneAdmissionRuns();
const reconcileOwnedRuns = async (): Promise<void> => {
  await runs.reconcileInterruptedRuns(await dispatchStore.ownedRunIds());
};
await reconcileOwnedRuns();
const runtimeHost = new AgentLoopRuntimeHost(new AgentLoopRuntimeRunPort(runs), new HttpResourceImporter(runs, routerAttachmentToken), {
  maxConcurrentRuns,
  activeRunCount: activeRunCount,
}, dispatchStore, controlPlaneAdmissionRuns);
// Shadow delivery is strictly opt-in and observational. The existing file
// loaders above remain the sole source of the dependencies passed to RunService.
const configurationShadow = createRuntimeConfigurationShadowOrchestrator({
  environment: process.env,
  runtimeId,
  baseline: {
    modelKeys: providers?.modelKeys() ?? [],
    skillDirectoryCount: skillDirectories.length,
    practiceProfileCount: practiceProfileCatalog.profiles.length,
    stepExecutionStrategyProfile: stepExecutionStrategyConfig.profile,
  },
  log: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
});
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
function shutdown(): void {
  if (closing) return;
  closing = true;
  clearInterval(heartbeatTimer);
  clearInterval(reconciliationTimer);
  configurationShadow?.stop();
  server.close(() => {
    database.close();
    process.exitCode = 0;
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

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
  const environments = new RunEnvironmentResolver({ delivery: client, cache: new SqlRuntimeConfigurationSnapshotCache(database), environment: process.env, createReceiptId: crypto.randomUUID });
  return new ControlPlaneAdmissionRunResolver(target, environments, (environment) => new AgentLoopRuntimeRunPort(createRuns(environment.providers)));
}

function runtimeConfigurationSource(value: string | undefined): "file" | "control_plane" {
  if (value === undefined || value === "file") return "file";
  if (value === "control_plane") return value;
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
