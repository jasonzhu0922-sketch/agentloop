import type { RuntimeConfigurationSnapshot } from "../../../../control-plane/contracts/index.ts";
import { RuntimeConfigurationClient } from "./runtime-configuration-client.ts";

export interface RuntimeFileConfigurationBaseline {
  readonly modelKeys: readonly string[];
  readonly skillDirectoryCount: number;
  readonly practiceProfileCount: number;
  readonly stepExecutionStrategyProfile: string;
}

export interface ConfigurationShadowResult {
  readonly status: "equivalent" | "different" | "incomplete";
  readonly snapshot: RuntimeConfigurationSnapshot;
  readonly differences: readonly string[];
}

/**
 * Compares only facts actually available on both planes. Missing semantic
 * mappings remain incomplete; a count match is deliberately not called equal.
 */
export function compareRuntimeConfigurationShadow(input: { readonly baseline: RuntimeFileConfigurationBaseline; readonly snapshot: RuntimeConfigurationSnapshot }): ConfigurationShadowResult {
  const differences: string[] = [];
  if (input.baseline.modelKeys.length > 0 && input.snapshot.modelRoute === undefined) differences.push("model_route_missing_from_control_plane");
  if (input.baseline.modelKeys.length === 0 && input.snapshot.modelRoute !== undefined) differences.push("model_route_missing_from_file_baseline");
  if (input.baseline.skillDirectoryCount > 0 && input.snapshot.skills.length === 0) differences.push("skills_missing_from_control_plane");
  if (input.baseline.skillDirectoryCount === 0 && input.snapshot.skills.length > 0) differences.push("skills_missing_from_file_baseline");
  if (input.baseline.practiceProfileCount > 0 && input.snapshot.policies.length === 0) differences.push("policies_missing_from_control_plane");
  if (input.baseline.practiceProfileCount === 0 && input.snapshot.policies.length > 0) differences.push("policies_missing_from_file_baseline");
  if (differences.length > 0) return { status: "different", snapshot: input.snapshot, differences };
  const components = input.baseline.modelKeys.length + input.baseline.skillDirectoryCount + input.baseline.practiceProfileCount + input.snapshot.integrations.length;
  return components === 0
    ? { status: "incomplete", snapshot: input.snapshot, differences: ["step_execution_strategy_mapping_not_yet_declared"] }
    : { status: "incomplete", snapshot: input.snapshot, differences: ["release_content_to_file_baseline_mapping_not_yet_declared", "step_execution_strategy_mapping_not_yet_declared"] };
}

/** Shadow-only reconciliation: validates and records a receipt, but never changes a Host dependency. */
export async function reconcileRuntimeConfigurationShadow(input: {
  readonly client: RuntimeConfigurationClient;
  readonly baseline: RuntimeFileConfigurationBaseline;
  readonly receiptIdFor: (releaseId: string) => string;
}): Promise<ConfigurationShadowResult> {
  const snapshot = await input.client.desiredSnapshot();
  const result = compareRuntimeConfigurationShadow({ baseline: input.baseline, snapshot });
  await input.client.reportValidated(snapshot, input.receiptIdFor);
  return result;
}
