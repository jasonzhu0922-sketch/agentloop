export const LOCAL_MARKITDOWN_VERSION: "0.1.7";

type Environment = Record<string, string | undefined>;

export function localRuntimeToolsRoot(appRoot: string, environment?: Environment): string;
export function localRuntimeToolsBin(toolsRoot: string): string;
export function localRuntimeHostEnvironment(environment: Environment, toolsBin: string): Environment & {
  PATH: string;
  RUNTIME_REQUIRED_COMMANDS: string;
};
export function ensureLocalRuntimeTools(options: { appRoot: string; environment?: Environment }): Promise<string>;
