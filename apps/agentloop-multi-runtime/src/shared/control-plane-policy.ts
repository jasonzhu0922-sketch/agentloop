import type { PracticeProfileCatalog } from "@zhujun/agentloop";
import { parsePracticeProfileConfig, parseStepExecutionStrategyProfileConfig, type StepExecutionStrategyProfileConfig } from "./config.ts";
import type { PolicyReleaseReference } from "../../control-plane/contracts/index.ts";

export interface ResolvedControlPlanePolicy {
  readonly practiceProfileCatalog?: PracticeProfileCatalog;
  readonly stepExecutionStrategy?: StepExecutionStrategyProfileConfig;
  readonly planTemplates: readonly Readonly<Record<string, unknown>>[];
  readonly releaseIds: readonly string[];
}

/** Converts public policy manifests into kernel-neutral deployment adapters. */
export function resolveControlPlanePolicy(policies: readonly PolicyReleaseReference[]): ResolvedControlPlanePolicy {
  let practiceProfileCatalog: PracticeProfileCatalog | undefined;
  let stepExecutionStrategy: StepExecutionStrategyProfileConfig | undefined;
  const planTemplates: Readonly<Record<string, unknown>>[] = [];
  for (const release of policies) {
    const manifest = release.policy;
    if (manifest === undefined) continue;
    if (manifest.practiceProfileCatalog !== undefined) {
      if (practiceProfileCatalog !== undefined) throw new Error("configuration_unavailable");
      practiceProfileCatalog = parsePracticeProfileConfig(JSON.stringify(manifest.practiceProfileCatalog));
    }
    if (manifest.stepExecutionStrategy !== undefined) {
      if (stepExecutionStrategy !== undefined) throw new Error("configuration_unavailable");
      stepExecutionStrategy = parseStepExecutionStrategyProfileConfig(JSON.stringify(manifest.stepExecutionStrategy));
    }
    if (manifest.planTemplates !== undefined) planTemplates.push(...manifest.planTemplates);
  }
  return { ...(practiceProfileCatalog === undefined ? {} : { practiceProfileCatalog }), ...(stepExecutionStrategy === undefined ? {} : { stepExecutionStrategy }), planTemplates, releaseIds: policies.map((item) => item.releaseId) };
}
