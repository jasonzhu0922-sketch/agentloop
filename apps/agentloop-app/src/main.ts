import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppDatabase,
  BatchService,
  createPlaywrightArtifactAcceptanceProvider,
  createWebTools,
  LlmProviderRegistry,
  RunService,
  SkillService,
} from "@zhujun/agentloop";
import { bundledSkillDirectories } from "@zhujun/agentloop-skills";
import { AuthService } from "./auth/auth-service.ts";
import { createAgentLoopServer } from "./http/server.ts";
import { loadOptionalMcpToolsFromConfigFile } from "./mcp/mcp-loader.ts";
import { loadPlanningExtensions } from "./planning-extension-loader.ts";
import { resolveApplicationRuntimePaths } from "./runtime-config.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const port = parseInteger(process.env.PORT, 8787, 1, 65_535);
const host = process.env.HOST ?? "127.0.0.1";
const sessionTtlHours = parseInteger(process.env.SESSION_TTL_HOURS, 168, 1, 24 * 365);
const webOrigins = parseStringArray(process.env.WEB_ORIGINS_JSON, "WEB_ORIGINS_JSON");
const runtimePaths = resolveApplicationRuntimePaths({
  appRoot,
  databasePath: process.env.DATABASE_PATH,
  providerConfigPath: process.env.LLM_PROVIDER_CONFIG_PATH,
  planningExtensionsConfigPath: process.env.PLANNING_EXTENSIONS_CONFIG_PATH,
  workspaceRoot: process.env.WORKSPACE_ROOT,
  customSkillDirectories: parseStringArray(process.env.CUSTOM_SKILL_DIRECTORIES_JSON, "CUSTOM_SKILL_DIRECTORIES_JSON"),
});
const { databasePath, workspaceRoot } = runtimePaths;
const skillDirectories = uniqueStrings([
  ...bundledSkillDirectories(),
  ...runtimePaths.customSkillDirectories,
]);
const packageStoreRoot = resolve(workspaceRoot, ".agentloop/skill-packages");
const acceptanceProviders = process.env.ARTIFACT_ACCEPTANCE_PLAYWRIGHT === "1"
  ? [createPlaywrightArtifactAcceptanceProvider({
      ...(process.env.ARTIFACT_ACCEPTANCE_PLAYWRIGHT_EXECUTABLE_PATH === undefined
        ? {}
        : { executablePath: process.env.ARTIFACT_ACCEPTANCE_PLAYWRIGHT_EXECUTABLE_PATH }),
    })]
  : [];
if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });

const database = new AppDatabase(databasePath);
await database.ready();
const auth = new AuthService(database, sessionTtlHours * 60 * 60 * 1000);
if (runtimePaths.providerConfigPath === undefined) {
  throw new Error("LLM_PROVIDER_CONFIG_PATH must point to the server-side LLM Provider configuration file");
}
const providers = await LlmProviderRegistry.fromConfigFile(runtimePaths.providerConfigPath);
const skills = new SkillService(database, {
  packageStoreRoot,
  allowedImportRoots: parseStringArray(process.env.SKILL_IMPORT_ROOTS_JSON, "SKILL_IMPORT_ROOTS_JSON"),
  skillDirectories,
});
const skillDirectorySync = await skills.syncSkillDirectories();
const planningExtensionPlugins = await loadPlanningExtensions({
  appRoot,
  workspaceRoot,
  ...(runtimePaths.planningExtensionsConfigPath === undefined ? {} : { configPath: runtimePaths.planningExtensionsConfigPath }),
});
const mcpIntegration = await loadOptionalMcpToolsFromConfigFile(runtimePaths.mcpServersConfigPath);
const runs = new RunService({
  database,
  skills,
  modelFactory: (onRetry, modelKey) => providers.create(modelKey, onRetry),
  defaultModelKey: providers.defaultModelKey,
  modelKeys: providers.modelKeys(),
  workspaceRoot,
  acceptanceProviders,
  computerExecutableAliases: parseExecutableAliases(process.env.TRUSTED_EXECUTABLE_ALIASES_JSON),
  computerCommandEnvironment: parseCommandEnvironment(process.env.TRUSTED_COMMAND_ENV_JSON),
  tools: [
    ...(process.env.WEB_SEARCH_DISABLED === "1"
      ? []
      : createWebTools({
          ...(process.env.WEB_SEARCH_PROVIDER === undefined ? {} : { searchProvider: parseSearchProvider(process.env.WEB_SEARCH_PROVIDER) }),
          ...(process.env.WEB_SEARCH_ENDPOINT === undefined ? {} : { searchEndpoint: process.env.WEB_SEARCH_ENDPOINT }),
          ...(process.env.WEB_SEARCH_API_KEY === undefined ? {} : { searchApiKey: process.env.WEB_SEARCH_API_KEY }),
        })),
    ...mcpIntegration.tools,
  ],
  ...(process.env.AGENTLOOP_RUN_EVENT_LOGS === "0"
    ? {}
    : { runEventLogSink: (line) => process.stdout.write(`${line}\n`) }),
  planningExtensions: planningExtensionPlugins.extensions,
});
const reconciledRunCount = await runs.reconcileInterruptedRuns();
const recoveryMonitor = setInterval(() => {
  void runs.reconcileInterruptedRuns().catch((error) => {
    process.stderr.write(`recovery reconcile failed: ${String(error)}\n`);
  });
}, 10_000);
const batches = new BatchService(database, runs);

const server = createAgentLoopServer({ auth, skills, runs, batches, providers }, { webOrigins });
server.listen(port, host, () => {
  process.stdout.write(
    `AgentLoop API listening on http://${host}:${port}; discovered ${skillDirectorySync.discoveredSkills.length} Skill package(s) from ${skillDirectories.join(", ")}; pruned ${skillDirectorySync.prunedLegacySkillCount} stale package Skill(s); refreshed ${skillDirectorySync.refreshedInstalledSkillCount} installed Skill package(s); queued ${reconciledRunCount} recovery review(s)\n`,
  );
  if (mcpIntegration.loadedServers.length > 0 || mcpIntegration.failedServers.length > 0) {
    process.stdout.write(
      `MCP sources loaded ${mcpIntegration.loadedServers.length} server(s) and skipped ${mcpIntegration.failedServers.length} failed server(s)\n`,
    );
    for (const failedServer of mcpIntegration.failedServers) {
      process.stderr.write(`MCP server ${failedServer.key} failed: ${failedServer.message}\n`);
    }
  }
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  clearInterval(recoveryMonitor);
  server.close(() => {
    void planningExtensionPlugins.close()
      .catch((error) => {
        process.stderr.write(`planning extension shutdown failed: ${String(error)}\n`);
      })
      .finally(() => database.close());
    process.exitCode = 0;
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function parseInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}, received ${value}`);
  }
  return parsed;
}

function parseExecutableAliases(value: string | undefined): Readonly<Record<string, string>> {
  if (value === undefined || value.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("TRUSTED_EXECUTABLE_ALIASES_JSON must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TRUSTED_EXECUTABLE_ALIASES_JSON must be a JSON object");
  }
  const aliases: Record<string, string> = {};
  for (const [name, target] of Object.entries(parsed)) {
    if (typeof target !== "string" || target.length === 0) {
      throw new Error(`Trusted executable alias ${name} must have a non-empty string path`);
    }
    aliases[name] = target;
  }
  return aliases;
}

function parseCommandEnvironment(value: string | undefined): Readonly<Record<string, string>> {
  if (value === undefined || value.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("TRUSTED_COMMAND_ENV_JSON must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TRUSTED_COMMAND_ENV_JSON must be a JSON object");
  }
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`Trusted command environment ${name} must have a string value`);
    }
    environment[name] = value;
  }
  return environment;
}

function parseStringArray(value: string | undefined, label: string): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be a JSON array of non-empty strings`);
  }
  return parsed;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function parseSearchProvider(value: string): "baidu" | "bing" {
  if (value === "baidu" || value === "bing") return value;
  throw new Error("WEB_SEARCH_PROVIDER must be either \"baidu\" or \"bing\"");
}
