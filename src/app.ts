import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AgentService } from "./agents/agent-service.ts";
import { AuthService } from "./auth/auth-service.ts";
import { BatchService } from "./batch/batch-service.ts";
import { createAgentLoopServer } from "./http/server.ts";
import { LlmProviderRegistry } from "./runtime/provider-registry.ts";
import { RunService } from "./runtime/run-service.ts";
import { SkillService } from "./skills/skill-service.ts";
import { AppDatabase } from "./storage/database.ts";

const port = parseInteger(process.env.PORT, 8787, 1, 65_535);
const sessionTtlHours = parseInteger(process.env.SESSION_TTL_HOURS, 168, 1, 24 * 365);
const configuredPath = process.env.DATABASE_PATH ?? "./data/agentloop.db";
const databasePath = configuredPath === ":memory:" ? configuredPath : resolve(configuredPath);
const workspaceRoot = resolve(process.env.WORKSPACE_ROOT ?? process.cwd());
const skillDirectory = resolve(process.env.SKILL_DIRECTORY ?? resolve(process.cwd(), "skills"));
const packageStoreRoot = resolve(
  process.env.SKILL_PACKAGE_STORE_ROOT ?? resolve(workspaceRoot, ".agentloop/skill-packages"),
);
if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });

const database = new AppDatabase(databasePath);
const auth = new AuthService(database, sessionTtlHours * 60 * 60 * 1000);
const providerConfigPath = process.env.LLM_PROVIDER_CONFIG_PATH;
if (providerConfigPath === undefined || providerConfigPath.trim().length === 0) {
  throw new Error("LLM_PROVIDER_CONFIG_PATH must point to the server-side LLM Provider configuration file");
}
const providers = await LlmProviderRegistry.fromConfigFile(resolve(providerConfigPath));
const skills = new SkillService(database, {
  packageStoreRoot,
  allowedImportRoots: parseStringArray(process.env.SKILL_IMPORT_ROOTS_JSON, "SKILL_IMPORT_ROOTS_JSON"),
  skillDirectory,
});
const discoveredSkills = await skills.refreshSkillDirectory();
const agents = new AgentService(database, skills, {
  allowedProviderKeys: providers.keys(),
  defaultProviderKey: providers.defaultProviderKey,
});
const runs = new RunService({
  database,
  skills,
  agents,
  modelFactory: (agent) => providers.create(agent),
  workspaceRoot,
  computerExecutableAliases: parseExecutableAliases(process.env.TRUSTED_EXECUTABLE_ALIASES_JSON),
  computerCommandEnvironment: parseCommandEnvironment(process.env.TRUSTED_COMMAND_ENV_JSON),
});
const reconciledRunCount = runs.reconcileInterruptedRuns();
const recoveryMonitor = setInterval(() => {
  runs.reconcileInterruptedRuns();
}, 10_000);
const batches = new BatchService(database, agents, runs);

const server = createAgentLoopServer({ auth, skills, agents, runs, batches, providers });
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `AgentLoop API listening on http://127.0.0.1:${port}; discovered ${discoveredSkills.length} Skill package(s) from ${skillDirectory}; queued ${reconciledRunCount} recovery review(s)\n`,
  );
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  clearInterval(recoveryMonitor);
  server.close(() => {
    database.close();
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
