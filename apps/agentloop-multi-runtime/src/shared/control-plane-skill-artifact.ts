import { inspectSkillPackage } from "@zhujun/agentloop";
import { chmod, cp, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { RuntimeTarget, SkillArtifactManifest, SkillInstallReceipt } from "../../control-plane/contracts/index.ts";

export interface SkillArtifactDownloadPort {
  /** Returns a target-local, non-authoritative unpacked directory. */
  download(manifest: SkillArtifactManifest): Promise<string>;
}

export interface SkillArtifactSignatureVerifierPort {
  verify(input: { readonly manifest: SkillArtifactManifest; readonly packageHash: string }): Promise<boolean> | boolean;
}

export class SkillArtifactInstallError extends Error {
  public readonly code: "skill_artifact_invalid" | "skill_artifact_signature_invalid" | "skill_artifact_unavailable";
  public constructor(code: SkillArtifactInstallError["code"], message: string) { super(message); this.name = "SkillArtifactInstallError"; this.code = code; }
}

/** Downloads, hashes, verifies, and materializes a read-only Runtime package. */
export async function installSignedSkillArtifact(input: {
  readonly target: RuntimeTarget;
  readonly releaseId: string;
  readonly manifest: SkillArtifactManifest;
  readonly destinationRoot: string;
  readonly download: SkillArtifactDownloadPort;
  readonly verifier: SkillArtifactSignatureVerifierPort;
  readonly receiptId: string;
  readonly now?: () => number;
}): Promise<SkillInstallReceipt> {
  try {
    const sourceDirectory = await input.download.download(input.manifest);
    const inspection = await inspectSkillPackage(sourceDirectory);
    if (inspection.packageHash !== input.manifest.packageHash) throw new SkillArtifactInstallError("skill_artifact_invalid", "Downloaded Skill package hash does not match its signed manifest");
    if (!await input.verifier.verify({ manifest: input.manifest, packageHash: inspection.packageHash })) throw new SkillArtifactInstallError("skill_artifact_signature_invalid", "Skill artifact signature was not accepted");
    const destination = resolve(input.destinationRoot, input.manifest.packageHash);
    await mkdir(input.destinationRoot, { recursive: true, mode: 0o700 });
    await cp(sourceDirectory, destination, { recursive: true, errorOnExist: true, force: false }).catch((error) => {
      throw new SkillArtifactInstallError("skill_artifact_invalid", error instanceof Error ? error.message : "Skill artifact could not be materialized");
    });
    const copied = await inspectSkillPackage(destination);
    await makeReadOnly(copied.root);
    return {
      contractVersion: "control-plane/v1", receiptId: input.receiptId, target: input.target,
      releaseId: input.releaseId, packageHash: copied.packageHash, signer: input.manifest.signer, status: "loaded", observedAt: (input.now ?? Date.now)(),
    };
  } catch (error) {
    if (error instanceof SkillArtifactInstallError) throw error;
    throw new SkillArtifactInstallError("skill_artifact_unavailable", error instanceof Error ? error.message : "Skill artifact download failed");
  }
}

async function makeReadOnly(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  await chmod(root, 0o555);
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) await makeReadOnly(path);
    else await chmod(path, 0o444);
  }
}
