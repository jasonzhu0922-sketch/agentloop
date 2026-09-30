import { createHash } from "node:crypto";
import type { ConfigurationSnapshotRepositoryPort } from "../../../control-plane/domain/ports.ts";
import { ControlPlaneError, resolveEffectiveAssignment } from "../../../control-plane/domain/index.ts";
import type {
  ControlPlaneResource, ReleaseReference, RuntimeConfigurationSnapshot, RuntimeTarget,
} from "../../../control-plane/contracts/index.ts";

/** Resolves only active desired state. It never reads a secret reference/value or Runtime database. */
export class RuntimeConfigurationSnapshotService {
  private readonly repository: ConfigurationSnapshotRepositoryPort;
  private readonly now: () => number;
  private readonly ttlMs: number;

  public constructor(input: { readonly repository: ConfigurationSnapshotRepositoryPort; readonly now: () => number; readonly ttlMs: number }) {
    this.repository = input.repository;
    this.now = input.now;
    this.ttlMs = input.ttlMs;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) throw new TypeError("snapshot ttlMs must be a positive safe integer");
  }

  public async desiredSnapshot(target: RuntimeTarget): Promise<RuntimeConfigurationSnapshot> {
    const resources = await this.repository.listResources();
    const selected = await Promise.all(resources.map(async (resource) => ({ resource, release: await this.selectedRelease(resource, target) })));
    const active = selected.filter((entry): entry is { resource: ControlPlaneResource; release: ReleaseReference & { assignmentId: string; kind: ControlPlaneResource["kind"] } } => entry.release !== undefined);
    const modelRoutes = active.filter((entry) => entry.resource.kind === "model_route");
    if (modelRoutes.length > 1) throw new ControlPlaneError("configuration_unavailable", "More than one active model-route resource applies to this target");
    const skills = await Promise.all(active.filter((entry) => entry.resource.kind === "skill").map(async ({ release }) => {
      const packageHash = await this.repository.skillPackageHash(release.releaseId);
      if (packageHash === undefined) throw new ControlPlaneError("configuration_unavailable", `Skill release ${release.releaseId} has no verified package artifact`);
      return { releaseId: release.releaseId, packageHash, contentHash: release.contentHash };
    }));
    const integrations = active.filter((entry) => entry.resource.kind === "integration")
      .map(({ release }) => ({ bindingId: release.assignmentId, releaseId: release.releaseId, contentHash: release.contentHash }));
    const policies = active.filter((entry) => entry.resource.kind === "policy")
      .map(({ release }) => ({ releaseId: release.releaseId, contentHash: release.contentHash }));
    const resolvedAt = this.now();
    const configurationRevision = await this.repository.configurationRevision();
    const snapshot: Omit<RuntimeConfigurationSnapshot, "snapshotId"> = {
      contractVersion: "control-plane/v1", configurationRevision, target, resolvedAt, validUntil: resolvedAt + this.ttlMs,
      ...(modelRoutes.length === 0 ? {} : { modelRoute: { releaseId: modelRoutes[0]!.release.releaseId, contentHash: modelRoutes[0]!.release.contentHash } }),
      integrations: integrations.sort(referenceOrder), skills: skills.sort(referenceOrder), policies: policies.sort(referenceOrder),
    };
    return { ...snapshot, snapshotId: snapshotHash(snapshot) };
  }

  private async selectedRelease(resource: ControlPlaneResource, target: RuntimeTarget): Promise<(ReleaseReference & { assignmentId: string; kind: ControlPlaneResource["kind"] }) | undefined> {
    const assignments = await this.repository.listAssignments(resource.resourceId);
    const assignment = resolveEffectiveAssignment(assignments.filter((candidate) => candidate.rolloutState === "active"), target);
    if (assignment === undefined) return undefined;
    const release = await this.repository.getRelease(assignment.releaseId);
    if (release === undefined || release.state !== "active") return undefined;
    return { releaseId: release.releaseId, contentHash: release.contentHash, assignmentId: assignment.assignmentId, kind: resource.kind };
  }
}

function referenceOrder(left: { releaseId: string }, right: { releaseId: string }): number { return left.releaseId.localeCompare(right.releaseId); }

function snapshotHash(snapshot: Omit<RuntimeConfigurationSnapshot, "snapshotId">): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
