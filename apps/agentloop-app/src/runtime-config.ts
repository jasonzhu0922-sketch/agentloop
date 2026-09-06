import { resolve } from "node:path";

export interface ApplicationRuntimePaths {
  readonly databasePath: string;
  readonly providerConfigPath?: string;
  readonly planningExtensionsConfigPath?: string;
  readonly mcpServersConfigPath: string;
  readonly workspaceRoot: string;
  readonly customSkillDirectories: readonly string[];
}

export function resolveApplicationRuntimePaths(input: {
  readonly appRoot: string;
  readonly databasePath?: string;
  readonly providerConfigPath?: string;
  readonly planningExtensionsConfigPath?: string;
  readonly workspaceRoot?: string;
  readonly customSkillDirectories?: readonly string[];
}): ApplicationRuntimePaths {
  return {
    databasePath: input.databasePath === ":memory:"
      ? ":memory:"
      : resolveFromAppRoot(input.appRoot, input.databasePath ?? "./data/agentloop.db"),
    ...(input.providerConfigPath === undefined || input.providerConfigPath.trim().length === 0
      ? {}
      : { providerConfigPath: resolveFromAppRoot(input.appRoot, input.providerConfigPath) }),
    ...(input.planningExtensionsConfigPath === undefined || input.planningExtensionsConfigPath.trim().length === 0
      ? {}
      : { planningExtensionsConfigPath: resolveFromAppRoot(input.appRoot, input.planningExtensionsConfigPath) }),
    mcpServersConfigPath: resolveFromAppRoot(input.appRoot, "./config/mcp-servers.json"),
    workspaceRoot: resolveFromAppRoot(input.appRoot, input.workspaceRoot ?? "./workspace"),
    customSkillDirectories: (input.customSkillDirectories ?? []).map((directory) => resolveFromAppRoot(input.appRoot, directory)),
  };
}

function resolveFromAppRoot(appRoot: string, path: string): string {
  return resolve(appRoot, path);
}
