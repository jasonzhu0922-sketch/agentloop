export const PACKAGED_NODE_MAJOR: number;
export const PACKAGED_PYTHON_MAJOR_MINOR: string;
export function normalizePackagedNodeVersion(output: string): string;
export function packagedRuntimePythonManifestPath(platformName?: string): string;

export function preparePackagedPythonRuntime(options: {
  sourceRoot: string;
  destinationRoot: string;
  requirementsPath: string;
  pipIndexUrl?: string;
}): Promise<{
  schema: string;
  pythonVersion: string;
  pythonExecutable: string;
  toolsDirectory: string;
}>;

export function copyPackagedNodeModules(options: {
  repositoryRoot: string;
  destinationRoot: string;
}): Promise<string[]>;
