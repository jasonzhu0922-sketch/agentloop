import type { ArtifactAcceptanceService } from "../acceptance/artifact-acceptance.ts";
import type { ComputerDriver } from "../computer/computer-driver.ts";
import { ComputerExecutor } from "../computer/computer-executor.ts";
import type { UploadedSourceSummary, VisibleDirectoryGrant } from "../runtime/contracts.ts";
import type { PrivateSkill } from "../skills/skill-service.ts";
import { SourceRepository } from "../storage/repositories/source-repository.ts";
import { createComputerTools } from "./computer-tools.ts";
import { createSkillLoader } from "./skill-loader.ts";
import { createSourceTools } from "./source-tools.ts";
import type { RuntimeTool } from "./tool-registry.ts";
import { createVisibleDirectoryTools } from "./visible-directory-tools.ts";

export interface CoreToolsOptions {
  executor: ComputerExecutor;
  driver?: ComputerDriver;
  acceptanceService?: ArtifactAcceptanceService;
  pluginTools?: readonly RuntimeTool<unknown>[];
}

export function createCoreTools(options: CoreToolsOptions): readonly RuntimeTool<unknown>[] {
  return [
    ...createComputerTools(options.executor, options.driver, options.acceptanceService),
    ...(options.pluginTools ?? []),
  ];
}

export interface ComposeRunToolsOptions {
  coreTools: readonly RuntimeTool<unknown>[];
  sourceRepository?: SourceRepository;
  privateSkills?: readonly PrivateSkill[];
  visibleDirectories?: readonly VisibleDirectoryGrant[];
  uploadedSources?: readonly UploadedSourceSummary[];
}

export function composeRunTools(options: ComposeRunToolsOptions): RuntimeTool<unknown>[] {
  const tools: RuntimeTool<unknown>[] = [...options.coreTools];
  const visibleDirectories = options.visibleDirectories ?? [];
  const uploadedSources = options.uploadedSources ?? [];
  const privateSkills = options.privateSkills ?? [];
  if (visibleDirectories.length > 0) tools.push(...createVisibleDirectoryTools());
  if (uploadedSources.length > 0) {
    if (options.sourceRepository === undefined) {
      throw new TypeError("sourceRepository is required when uploadedSources are present");
    }
    tools.push(...createSourceTools(options.sourceRepository));
  }
  if (privateSkills.length > 0) tools.push(createSkillLoader(privateSkills));
  return tools;
}

export function assertNoDuplicateTools(tools: readonly RuntimeTool<unknown>[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new TypeError(`Duplicate tool name: ${tool.name}`);
    names.add(tool.name);
  }
}
