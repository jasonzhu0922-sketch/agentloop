import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { colorizeTerminalLogLabel, colorizeTerminalLogLine, createStepExecutionStrategyProfile, createWebTools, DEFAULT_MAX_PLANNING_TURNS, DEFAULT_MAX_STEPS, LlmProviderRegistry, loadOptionalMcpToolsFromConfigFile, MAX_SUPPORTED_PLANNING_TURNS, MAX_SUPPORTED_STEP_TURNS, RunService, SkillService } from "@zhujun/agentloop";
import { bundledSkillDirectories } from "@zhujun/agentloop-skills";
import { loadPracticeProfileConfig, loadSkillDirectoriesConfig, loadStepExecutionStrategyProfileConfig, mergeSkillDirectories, webToolsOptionsFromEnvironment } from "../shared/config.ts";
import { HttpResourceImporter } from "./infrastructure/http-resource-importer.ts";
import { AgentLoopRuntimeRunPort } from "./infrastructure/agentloop-runtime-run-port.ts";
import { HostDispatchStore } from "./persistence/host-dispatch-store.ts";
import { createRuntimeHostHttpServer } from "./api/runtime-host-api.ts";
import { RuntimeHostService } from "./service/runtime-host-service.ts";
import {
  assertRequiredRuntimeCommands,
  assertRequiredRuntimeNodeModules,
  assertRequiredRuntimePythonModules,
  requiredRuntimeCommands,
  requiredRuntimeNodeModules,
  requiredRuntimePythonModules,
} from "./service/runtime-command-preflight.ts";
import { openStateDatabase, stateDatabaseConfigFromEnvironment } from "../shared/persistence/state-database.ts";
import { migrateRuntimeState } from "./persistence/state-migrations.ts";
import { loadOptionalPlanTemplateObserver } from "./plan-template-observer.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
// This non-sensitive path is the only Enterprise Info setting passed to
// Skill-owned commands. The script reads credentials from the deployment file.
const enterpriseInfoEnvironmentFile = resolve(
  appRoot,
  process.env.ENTERPRISE_INFO_ENV_FILE ?? "./.env",
);
// api-query receives only the deployment-file path; its script reads the
// endpoint and credentials without exposing them to Planner, model context, or
// command-line arguments.
const apiQueryEnvironmentFile = resolve(
  appRoot,
  process.env.API_QUERY_ENV_FILE ?? "./.env",
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
const mcpServersConfigPath = resolve(appRoot, process.env.MCP_SERVERS_CONFIG_PATH ?? "./config/mcp-servers.json");
const routerAttachmentToken = requiredEnv("RUNTIME_ATTACHMENT_TOKEN");
const runtimeDispatchToken = requiredEnv("RUNTIME_DISPATCH_TOKEN");
const routerUrl = process.env.ROUTER_URL ?? "http://127.0.0.1:8788";
const maxConcurrentRuns = positiveInteger(process.env.MAX_CONCURRENT_RUNS, 2);
const planningMaxTurns = boundedPositiveInteger(
  process.env.PLANNING_MAX_TURNS,
  DEFAULT_MAX_PLANNING_TURNS,
  MAX_SUPPORTED_PLANNING_TURNS,
  "PLANNING_MAX_TURNS",
);
const stepMaxTurns = boundedPositiveInteger(
  process.env.STEP_MAX_TURNS,
  DEFAULT_MAX_STEPS,
  MAX_SUPPORTED_STEP_TURNS,
  "STEP_MAX_TURNS",
);
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
const providers = await LlmProviderRegistry.fromConfigFile(providerConfigPath);
const skills = new SkillService(database, {
  // Do not make Skill package synchronization contend on the shared task volume.
  packageStoreRoot: skillPackageStoreRoot,
  skillDirectories,
});
const skillDirectorySync = await skills.syncSkillDirectories();
// MCP connections are Host-owned deployment integrations. The Router selects a
// Host but never receives MCP credentials or materializes its tool catalog.
const mcpIntegration = await loadOptionalMcpToolsFromConfigFile(mcpServersConfigPath);
const planTemplateObserver = await loadOptionalPlanTemplateObserver({
  appRoot,
  enabled: process.env.PLAN_TEMPLATE_ENABLED,
  ...(process.env.PLAN_TEMPLATE_CONFIG_PATH === undefined
    ? {}
    : { configPath: process.env.PLAN_TEMPLATE_CONFIG_PATH }),
});
const runs = new RunService({
  database,
  skills,
  modelFactory: (onRetry, modelKey) => providers.create(modelKey, onRetry),
  maxPlanningTurns: planningMaxTurns,
  maxSteps: stepMaxTurns,
  defaultModelKey: providers.defaultModelKey,
  modelKeys: providers.modelKeys(),
  workspaceRoot,
  stepExecutionStrategy,
  practiceProfileCatalog,
  tools: [...integrationTools, ...mcpIntegration.tools],
  computerCommandEnvironment: {
    ENTERPRISE_INFO_ENV_FILE: enterpriseInfoEnvironmentFile,
    API_QUERY_ENV_FILE: apiQueryEnvironmentFile,
    STEEL_MARKET_DB_ENV_FILE: steelMarketDatabaseEnvironmentFile,
  },
  ...(planTemplateObserver === undefined ? {} : { planningExtensions: [planTemplateObserver.extension()] }),
  runEventLogSink: (line) => process.stdout.write(`${runtimeLogLabel} ${colorizeTerminalLogLine(line, logColorOptions)}\n`),
});
const reconcileOwnedRuns = async (): Promise<void> => {
  await runs.reconcileInterruptedRuns(await dispatchStore.ownedRunIds());
};
await reconcileOwnedRuns();
const runtimeHost = new RuntimeHostService(new AgentLoopRuntimeRunPort(runs), new HttpResourceImporter(runs, routerAttachmentToken), {
  maxConcurrentRuns,
  activeRunCount: activeRunCount,
}, dispatchStore);
const server = createRuntimeHostHttpServer(runtimeHost, { dispatchToken: runtimeDispatchToken, models: providers.modelCatalog().map(({ key, displayName }) => ({ key, displayName })) });
server.listen(port, host, () => {
  process.stdout.write(`AgentLoop Runtime Host ${runtimeId} listening on http://${host}:${port}; discovered ${skillDirectorySync.discoveredSkills.length} Skill package(s) from ${skillDirectories.join(", ")}\n`);
  void sendHeartbeat();
  if (mcpIntegration.loadedServers.length > 0 || mcpIntegration.failedServers.length > 0) {
    process.stdout.write(`${runtimeLogLabel} MCP sources loaded ${mcpIntegration.loadedServers.length} server(s) and skipped ${mcpIntegration.failedServers.length} failed server(s)\n`);
    for (const failedServer of mcpIntegration.failedServers) {
      process.stderr.write(`${runtimeLogLabel} MCP server ${failedServer.key} failed: ${failedServer.message}\n`);
    }
  }
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
  server.close(() => {
    if (planTemplateObserver === undefined) {
      database.close();
      process.exitCode = 0;
      return;
    }
    void planTemplateObserver.close()
      .catch((error) => process.stderr.write(`PlanTemplate observer shutdown failed: ${String(error)}\n`))
      .finally(() => {
        database.close();
        process.exitCode = 0;
      });
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

function boundedPositiveInteger(value: string | undefined, fallback: number, maximum: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
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
