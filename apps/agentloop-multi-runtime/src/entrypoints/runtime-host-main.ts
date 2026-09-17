import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { colorizeTerminalLogLabel, colorizeTerminalLogLine, createStepExecutionStrategyProfile, createWebTools, LlmProviderRegistry, RunService, SkillService } from "@zhujun/agentloop";
import { bundledSkillDirectories } from "@zhujun/agentloop-skills";
import { loadSkillDirectoriesConfig, loadStepExecutionStrategyProfileConfig, mergeSkillDirectories, webToolsOptionsFromEnvironment } from "../config/config.ts";
import { HttpResourceImporter } from "../runtime/http-resource-importer.ts";
import { HostDispatchStore } from "../runtime/host-dispatch-store.ts";
import { createRuntimeHostHttpServer } from "../http/runtime-host-http.ts";
import { AgentLoopRuntimeHost } from "../runtime/runtime-host.ts";
import {
  assertRequiredRuntimeCommands,
  assertRequiredRuntimeNodeModules,
  assertRequiredRuntimePythonModules,
  requiredRuntimeCommands,
  requiredRuntimeNodeModules,
  requiredRuntimePythonModules,
} from "../runtime/runtime-command-preflight.ts";
import { openStateDatabase, stateDatabaseConfigFromEnvironment } from "../storage/state-database.ts";

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
const routerAttachmentToken = requiredEnv("RUNTIME_ATTACHMENT_TOKEN");
const runtimeDispatchToken = requiredEnv("RUNTIME_DISPATCH_TOKEN");
const routerUrl = process.env.ROUTER_URL ?? "http://127.0.0.1:8788";
const maxConcurrentRuns = positiveInteger(process.env.MAX_CONCURRENT_RUNS, 2);
const heartbeatIntervalMs = positiveInteger(process.env.HEARTBEAT_INTERVAL_MS, 5_000);
const logColorOptions = terminalLogColorOptions();
const runtimeLogLabel = colorizeTerminalLogLabel(`[${runtimeId}]`, runtimeId, logColorOptions);
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
}));
const dispatchStore = new HostDispatchStore(database, runtimeId);
await dispatchStore.ready();
const providers = await LlmProviderRegistry.fromConfigFile(providerConfigPath);
const skills = new SkillService(database, {
  // Do not make Skill package synchronization contend on the shared task volume.
  packageStoreRoot: skillPackageStoreRoot,
  skillDirectories,
});
const skillDirectorySync = await skills.syncSkillDirectories();
const runs = new RunService({
  database,
  skills,
  modelFactory: (onRetry, modelKey) => providers.create(modelKey, onRetry),
  defaultModelKey: providers.defaultModelKey,
  modelKeys: providers.modelKeys(),
  workspaceRoot,
  stepExecutionStrategy,
  tools: integrationTools,
  computerCommandEnvironment: {
    ENTERPRISE_INFO_ENV_FILE: enterpriseInfoEnvironmentFile,
    STEEL_MARKET_DB_ENV_FILE: steelMarketDatabaseEnvironmentFile,
  },
  runEventLogSink: (line) => process.stdout.write(`${runtimeLogLabel} ${colorizeTerminalLogLine(line, logColorOptions)}\n`),
});
await runs.reconcileInterruptedRuns();
const runtimeHost = new AgentLoopRuntimeHost(runs, new HttpResourceImporter(runs, routerAttachmentToken), {
  maxConcurrentRuns,
  activeRunCount: activeRunCount,
}, dispatchStore);
const server = createRuntimeHostHttpServer(runtimeHost, { dispatchToken: runtimeDispatchToken, models: providers.modelCatalog().map(({ key, displayName }) => ({ key, displayName })) });
server.listen(port, host, () => {
  process.stdout.write(`AgentLoop Runtime Host ${runtimeId} listening on http://${host}:${port}; discovered ${skillDirectorySync.discoveredSkills.length} Skill package(s) from ${skillDirectories.join(", ")}\n`);
  void sendHeartbeat();
});
const heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, heartbeatIntervalMs);
let reconciliationInFlight = false;
const reconciliationTimer = setInterval(() => {
  if (reconciliationInFlight) return;
  reconciliationInFlight = true;
  void runs.reconcileInterruptedRuns()
    .catch((error) => process.stderr.write(`Runtime interruption reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`))
    .finally(() => { reconciliationInFlight = false; });
}, heartbeatIntervalMs);

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  clearInterval(heartbeatTimer);
  clearInterval(reconciliationTimer);
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
