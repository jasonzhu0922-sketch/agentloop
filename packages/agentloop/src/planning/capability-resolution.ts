import type { PrivateSkill } from "../skills/skill-service.ts";
import type { CapabilityRecoveryCatalog, EvidenceKind, PlanProposal, PlanningCapability, SourceConstraint } from "./contracts.ts";
import { skillSourceProviderCapabilityId } from "./step-execution-binding.ts";

const TOOL_PRODUCED_EVIDENCE_KINDS = new Set<EvidenceKind>([
  "schema_summary",
  "record_counts",
  "table_coverage",
  "structured_extraction_artifact",
  "derived_aggregation",
  "artifact_path",
  "artifact_non_empty",
  "artifact_acceptance",
  "artifact_openable",
  "format_matches_request",
]);

export interface CapabilityGapCandidate {
  readonly capabilityId: string;
  readonly label?: string;
  readonly produces: readonly EvidenceKind[];
  readonly sourceKinds: readonly string[];
  /** A source-provider capability must be paired with its declaring Skill. */
  readonly requiredSkillIds: readonly string[];
}

export interface CapabilityGap {
  readonly stepId: string;
  readonly missingEvidenceKinds: readonly EvidenceKind[];
  readonly candidates: readonly CapabilityGapCandidate[];
}

/**
 * Finds evidence producers from the full Run-authorized catalog. It does not
 * bind, invoke, install, or authorize anything; the repaired Plan still goes
 * through normal Admission.
 */
export function resolveCapabilityGaps(input: {
  readonly proposal: PlanProposal;
  readonly currentSkills: readonly PrivateSkill[];
  readonly currentCapabilities: readonly PlanningCapability[];
  readonly catalog: CapabilityRecoveryCatalog;
}): readonly CapabilityGap[] {
  const currentById = new Map(input.currentCapabilities.map((capability) => [capability.id, capability]));
  const catalogById = new Map(input.catalog.availableCapabilities.map((capability) => [capability.id, capability]));
  const sourceProviderSkillIds = sourceProviderSkillsByCapability(input.catalog.availableSkills);
  return input.proposal.steps.flatMap((step) => {
    const requiredKinds = (step.evidenceContract?.requiredKinds ?? [])
      .filter((kind): kind is EvidenceKind => TOOL_PRODUCED_EVIDENCE_KINDS.has(kind));
    if (requiredKinds.length === 0) return [];
    const boundCapabilities = new Set(step.requiredCapabilities);
    for (const skill of input.currentSkills) {
      if (!step.skillIds.includes(skill.id)) continue;
      for (const capabilityId of sourceProviderCapabilityIds(skill)) boundCapabilities.add(capabilityId);
    }
    const produced = new Set([...boundCapabilities].flatMap((id) => currentById.get(id)?.produces ?? []));
    const missingEvidenceKinds = requiredKinds.filter((kind) => !produced.has(kind));
    if (missingEvidenceKinds.length === 0) return [];
    const candidates = [...catalogById.values()]
      .filter((capability) => !boundCapabilities.has(capability.id))
      .filter((capability) => compatibleWithSourceConstraint(
        capability,
        step.sourceConstraint,
        boundCapabilities,
        currentById,
        boundSourceProviderKinds(step, input.currentSkills, currentById),
      ))
      .filter((capability) => missingEvidenceKinds.some((kind) => capability.produces.includes(kind)))
      .map((capability) => ({
        capabilityId: capability.id,
        ...(capability.label === undefined ? {} : { label: capability.label }),
        produces: capability.produces.filter((kind) => missingEvidenceKinds.includes(kind)),
        sourceKinds: capability.sourceKinds,
        requiredSkillIds: sourceProviderSkillIds.get(capability.id) ?? [],
      }))
      .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
    return [{ stepId: step.id, missingEvidenceKinds, candidates }];
  });
}

/**
 * Resolves the plan-level case where Admission requires source grounding but
 * the proposal has not bound any source producer. This intentionally returns
 * candidates already visible to the first plan as well: the omission is a
 * planning defect, not evidence that the capability is unavailable.
 */
export function resolveSourceGroundingGap(input: {
  readonly catalog: CapabilityRecoveryCatalog;
  readonly evidenceDemand: "lookup_lite" | "source_grounded" | "strict_user_source";
}): CapabilityGap | undefined {
  const sourceProviderSkillIds = sourceProviderSkillsByCapability(input.catalog.availableSkills);
  const candidates = input.catalog.availableCapabilities
    .filter((capability) => capability.produces.includes("source_summary"))
    .filter((capability) => input.evidenceDemand !== "lookup_lite" || capability.sourceKinds.includes("web"))
    .map((capability) => ({
      capabilityId: capability.id,
      ...(capability.label === undefined ? {} : { label: capability.label }),
      produces: capability.produces.filter((kind) => kind === "source_summary" || kind === "source_urls" || kind === "explicit_caveats"),
      sourceKinds: capability.sourceKinds,
      requiredSkillIds: sourceProviderSkillIds.get(capability.id) ?? [],
    }))
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  if (candidates.length === 0) return undefined;
  return {
    stepId: "source_grounding",
    missingEvidenceKinds: input.evidenceDemand === "lookup_lite" ? ["source_summary", "source_urls"] : ["source_summary"],
    candidates,
  };
}

function compatibleWithSourceConstraint(
  capability: PlanningCapability,
  constraint: SourceConstraint | undefined,
  boundCapabilities: ReadonlySet<string>,
  currentById: ReadonlyMap<string, PlanningCapability>,
  boundSourceProviderKinds: ReadonlySet<string>,
): boolean {
  const requiredToolSourceIds = constraint?.requiredToolSourceIds ?? [];
  if (
    requiredToolSourceIds.length > 0
    && capability.sourceIds !== undefined
    && capability.sourceIds.length > 0
    && !requiredToolSourceIds.some((id) => capability.sourceIds!.includes(id))
  ) return false;

  // An explicit upload/directory binding is an input-identity constraint, not
  // merely a hint to prefer a related capability.  A provider for a different
  // source namespace cannot repair an evidence gap for that concrete input.
  const canConsumeBoundWorkspaceProduct = capability.sourceKinds.some((kind) =>
    kind === "workspace_file" || kind === "generated_artifact"
  ) && [...boundCapabilities].some((id) => {
    const produces = currentById.get(id)?.produces ?? [];
    return produces.includes("structured_extraction_artifact") || produces.includes("artifact_path");
  });
  if (
    (constraint?.requiredUploadedSourceIds?.length ?? 0) > 0
    && !capability.sourceKinds.includes("uploaded_source")
    && !canConsumeBoundWorkspaceProduct
  ) return false;
  if (
    (constraint?.requiredVisibleDirectoryIds?.length ?? 0) > 0
    && !capability.sourceKinds.includes("visible_directory")
    && !canConsumeBoundWorkspaceProduct
  ) return false;
  // A selected source-provider owns the source identity for its leaf.  An
  // evidence-contract mistake must not turn an API lookup into a database
  // acquisition (or the reverse) merely because another provider advertises a
  // missing generic evidence kind.  Workspace products remain compatible only
  // after the bound source workflow has already produced a reusable artifact.
  if (
    boundSourceProviderKinds.size > 0
    && !capability.sourceKinds.some((kind) => boundSourceProviderKinds.has(kind))
    && !canConsumeBoundWorkspaceProduct
  ) return false;
  return true;
}

function boundSourceProviderKinds(
  step: PlanProposal["steps"][number],
  skills: readonly PrivateSkill[],
  currentById: ReadonlyMap<string, PlanningCapability>,
): ReadonlySet<string> {
  const selectedSkillIds = new Set(step.skillIds);
  const kinds = new Set<string>();
  for (const skill of skills) {
    if (!selectedSkillIds.has(skill.id)) continue;
    const metadata = skill.agentLoop;
    if (!metadata?.roles.includes("source_provider")) continue;
    for (const kind of metadata.sourceKinds) kinds.add(kind);
  }
  // Recovery callers may not carry a resolved Skill object, but the bound
  // source-provider capability is still authoritative enough to preserve its
  // namespace.
  for (const capabilityId of step.requiredCapabilities) {
    if (!capabilityId.startsWith("skill_source_provider.")) continue;
    for (const kind of currentById.get(capabilityId)?.sourceKinds ?? []) kinds.add(kind);
  }
  return kinds;
}

function sourceProviderSkillsByCapability(skills: readonly PrivateSkill[]): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  for (const skill of skills) {
    for (const capabilityId of sourceProviderCapabilityIds(skill)) result.set(capabilityId, [skill.id]);
  }
  return result;
}

function sourceProviderCapabilityIds(skill: PrivateSkill): readonly string[] {
  const metadata = skill.agentLoop;
  if (!metadata?.roles.includes("source_provider") || (metadata.producesEvidenceKinds?.length ?? 0) === 0) return [];
  return metadata.sourceKinds.map((sourceKind) => skillSourceProviderCapabilityId(skill.id, sourceKind));
}
