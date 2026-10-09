import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;

export interface LocalAgentRuntimeConfiguration {
  /** A device-owned deployment directory, intentionally outside Skill packages. */
  readonly root: string;
  /** The only database-configuration path exposed to Skill commands. */
  readonly environmentFile: string;
  readonly computerCommandEnvironment: Readonly<Record<string, string>>;
}

export type LocalAgentIntegrationEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Keeps Local Agent integration configuration beside the device Runtime, not
 * in the application bundle, shared Host environment, or synchronized Skill
 * package. An explicit path remains available to managed deployments.
 */
export function localAgentRuntimeConfiguration(
  appRoot: string,
  dataRoot: string,
  environment: Environment = process.env,
): LocalAgentRuntimeConfiguration {
  const defaultRoot = environment.AGENTLOOP_AGENT_PACKAGED === "1"
    ? join(dataRoot, "agent-loop-runtime")
    : join(appRoot, "local-agent-runtime");
  const root = resolve(environment.LOCAL_AGENT_RUNTIME_CONFIG_ROOT ?? defaultRoot);
  const environmentFile = resolve(root, environment.LOCAL_AGENT_RUNTIME_ENV_FILE ?? ".env");
  return {
    root,
    environmentFile,
    computerCommandEnvironment: {
      ENTERPRISE_INFO_ENV_FILE: environmentFile,
      API_QUERY_ENV_FILE: environmentFile,
      STEEL_MARKET_DB_ENV_FILE: environmentFile,
    },
  };
}

/**
 * Load device-owned integration settings without placing their values in the
 * Agent process environment or the command environment. The returned values
 * are used only by the in-process model and web-search integrations.
 */
export async function readLocalAgentIntegrationEnvironment(configuration: LocalAgentRuntimeConfiguration): Promise<LocalAgentIntegrationEnvironment> {
  let source: string;
  try {
    source = await readFile(configuration.environmentFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const values: Record<string, string> = {};
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`local_agent_runtime_env_invalid_line:${index + 1}`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`local_agent_runtime_env_invalid_key:${index + 1}`);
    values[key] = line.slice(separator + 1).trim();
  }
  return values;
}

/**
 * Seed an editable, credential-free template for a newly installed Agent.
 * Never create or overwrite the real .env: its contents are deployment-owned.
 */
export async function ensureLocalAgentRuntimeConfiguration(appRoot: string, configuration: LocalAgentRuntimeConfiguration): Promise<void> {
  await mkdir(configuration.root, { recursive: true, mode: 0o700 });
  const bundledTemplate = join(appRoot, "agent-loop-runtime", ".env.example");
  const installedTemplate = join(configuration.root, ".env.example");
  if (existsSync(bundledTemplate) && !existsSync(installedTemplate)) await copyFile(bundledTemplate, installedTemplate);
  const bundledMcpConfig = join(appRoot, "agent-loop-runtime", "config", "mcp-servers.json");
  const installedMcpConfig = join(configuration.root, "config", "mcp-servers.json");
  if (existsSync(bundledMcpConfig) && !existsSync(installedMcpConfig)) {
    await mkdir(dirname(installedMcpConfig), { recursive: true, mode: 0o700 });
    await copyFile(bundledMcpConfig, installedMcpConfig);
  }
}
