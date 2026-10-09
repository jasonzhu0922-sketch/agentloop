import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalAgentBootstrapConfig, writeLocalAgentBootstrapConfig } from "./config/bootstrap-config.ts";
import { createLocalAgentServer } from "./api/local-agent-api.ts";
import { localRuntimeTerminalLogLine } from "./observability/runtime-terminal-log.ts";
import { ensureLocalAgentRuntimeConfiguration, localAgentRuntimeConfiguration, readLocalAgentIntegrationEnvironment } from "./config/runtime-configuration.ts";

void main();

async function main(): Promise<void> {
const packagedExecutable = /^agentloop-local-runtime-agent(?:\.exe)?$/i.test(basename(process.execPath));
const packaged = process.env.AGENTLOOP_AGENT_PACKAGED === "1" || packagedExecutable;
const sourceRoot = process.env.AGENTLOOP_AGENT_APP_ROOT ?? (packagedExecutable ? dirname(process.execPath) : fileURLToPath(new URL("../..", import.meta.url)));
const appRoot = resolve(sourceRoot);
const dataRoot = resolve(process.env.LOCAL_AGENT_DATA_ROOT ?? (packaged ? packagedDataRoot() : join(appRoot, "data", "local-agent")));
const bootstrapConfigPath = resolve(process.env.LOCAL_AGENT_BOOTSTRAP_CONFIG_PATH ?? join(dataRoot, "agent-config.json"));
const command = process.argv.slice(2);
const buildRouterUrl = process.env.AGENTLOOP_BUILD_ROUTER_URL;
const buildWebOrigin = process.env.AGENTLOOP_BUILD_WEB_ORIGIN;

if (command[0] === "--configure-server-url") {
  const routerUrl = requiredArgument(command[1], "--configure-server-url");
  const webOrigin = command[2] === "--web-origin" ? requiredArgument(command[3], "--web-origin") : undefined;
  const saved = await writeLocalAgentBootstrapConfig(bootstrapConfigPath, { routerUrl, ...(webOrigin === undefined ? {} : { webOrigin }) });
  process.stdout.write(`Configured Local Runtime Agent Router: ${saved.routerUrl}\n`);
  process.exit(0);
}
if (command.length > 0) throw new Error("Usage: agentloop-local-runtime-agent [--configure-server-url <https://router.example> [--web-origin <https://web.example>]]");

const bootstrap = await readLocalAgentBootstrapConfig(bootstrapConfigPath);
const host = "127.0.0.1";
const port = positiveInteger(process.env.LOCAL_AGENT_PORT, 8790);
const routerUrl = process.env.ROUTER_URL ?? buildRouterUrl ?? bootstrap.routerUrl;
const statePath = resolve(process.env.LOCAL_AGENT_STATE_PATH ?? join(dataRoot, "device-identity.json"));
const databasePath = resolve(process.env.LOCAL_AGENT_DATABASE_PATH ?? join(dataRoot, "agentloop.db"));
const workspaceRoot = resolve(process.env.LOCAL_AGENT_WORKSPACE_ROOT ?? join(dataRoot, "workspace"));
const skillPackageStoreRoot = resolve(process.env.LOCAL_AGENT_SKILL_PACKAGE_STORE_ROOT ?? join(dataRoot, "skill-packages"));
const runtimeDataRoot = resolve(process.env.LOCAL_AGENT_RUNTIME_DATA_ROOT ?? join(dataRoot, "runtimes"));
const supervisorDatabasePath = resolve(process.env.LOCAL_AGENT_SUPERVISOR_DATABASE_PATH ?? join(dataRoot, "supervisor.db"));
const maxConcurrentRuns = positiveInteger(process.env.LOCAL_RUNTIME_MAX_CONCURRENT_RUNS, 10, "LOCAL_RUNTIME_MAX_CONCURRENT_RUNS");
const runtimeConfiguration = localAgentRuntimeConfiguration(appRoot, dataRoot, process.env);
await ensureLocalAgentRuntimeConfiguration(appRoot, runtimeConfiguration);
const integrationEnvironment = await readLocalAgentIntegrationEnvironment(runtimeConfiguration);
const mcpServersConfigPath = resolve(process.env.LOCAL_AGENT_MCP_SERVERS_CONFIG_PATH ?? join(runtimeConfiguration.root, "config", "mcp-servers.json"));
const providerConfigPath = resolve(process.env.LOCAL_AGENT_PROVIDER_CONFIG_PATH ?? join(appRoot, "local-agent-runtime", "config", "llm-providers.json"));
const skillDirectoriesConfigPath = resolve(process.env.SKILL_DIRECTORIES_CONFIG_PATH ?? join(appRoot, "config", "skill-directories.json"));
const stepExecutionStrategyConfigPath = resolve(process.env.STEP_EXECUTION_STRATEGY_CONFIG_PATH ?? join(appRoot, "config", "step-execution-strategy.json"));
const practiceProfileConfigPath = resolve(process.env.PRACTICE_PROFILE_CONFIG_PATH ?? join(appRoot, "config", "practice-profiles.json"));
const webOrigin = process.env.WEB_ORIGIN ?? buildWebOrigin ?? bootstrap.webOrigin;
const logColorOptions = {
  colorMode: process.env.AGENTLOOP_LOG_COLOR,
  isTTY: process.stdout.isTTY,
  noColor: process.env.NO_COLOR,
};
const server = await createLocalAgentServer({
  appRoot, routerUrl, statePath, databasePath, workspaceRoot, skillPackageStoreRoot, runtimeDataRoot, supervisorDatabasePath, maxConcurrentRuns,
  providerConfigPath, skillDirectoriesConfigPath, stepExecutionStrategyConfigPath, practiceProfileConfigPath,
  mcpServersConfigPath,
  computerCommandEnvironment: runtimeConfiguration.computerCommandEnvironment,
  integrationEnvironment,
  runEventLogSink: (runtime, line) => process.stdout.write(`${localRuntimeTerminalLogLine(runtime.id, line, logColorOptions)}\n`),
  ...(webOrigin === undefined ? {} : { webOrigin }), environment: process.env,
});
server.listen(port, host, () => process.stdout.write(`AgentLoop Local Runtime Agent listening on http://${host}:${port}${routerUrl === undefined ? " (Router not configured)" : ""}\n`));
}

function positiveInteger(value: string | undefined, fallback: number, name = "LOCAL_AGENT_PORT"): number {
  const result = Number(value ?? fallback);
  if (!Number.isSafeInteger(result) || result < 1 || result > 65_535) throw new Error(`${name} must be a positive integer no greater than 65535`);
  return result;
}
function requiredArgument(value: string | undefined, flag: string): string { if (value === undefined || value.trim() === "") throw new Error(`${flag} requires a value`); return value; }

function packagedDataRoot(): string {
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "AgentLoop Local Runtime");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "AgentLoop Local Runtime");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "AgentLoop Local Runtime");
}
