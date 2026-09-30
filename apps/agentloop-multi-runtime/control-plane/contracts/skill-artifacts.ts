import type { RuntimeConfigurationSnapshot, SkillReleaseReference } from "./v1.ts";

/** Transport-neutral admission guard; adapters supply the verified local catalog hashes. */
export function assertSkillArtifactsReady(
  snapshot: Pick<RuntimeConfigurationSnapshot, "skills">,
  loadedPackageHashes: readonly string[],
  requireSignedArtifacts = true,
): void {
  const loaded = new Set(loadedPackageHashes);
  for (const skill of snapshot.skills) {
    if (requireSignedArtifacts && skill.artifact === undefined) throw new Error(`Skill release ${skill.releaseId} has no signed artifact manifest`);
    if (skill.artifact !== undefined && skill.artifact.packageHash !== skill.packageHash) throw new Error(`Skill release ${skill.releaseId} artifact hash does not match its snapshot`);
    if (!loaded.has(skill.packageHash)) throw new Error(`Skill release ${skill.releaseId} has not been verified and loaded on this target`);
  }
}

export function skillArtifactReferenceKey(skill: Pick<SkillReleaseReference, "releaseId" | "packageHash" | "contentHash">): string {
  return `${skill.releaseId}:${skill.packageHash}:${skill.contentHash}`;
}
