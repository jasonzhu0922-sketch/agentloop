import { createHash } from "node:crypto";
import type { ConfigurationSnapshotRepositoryPort } from "../../../control-plane/domain/ports.ts";
import { ControlPlaneError, resolveEffectiveAssignment } from "../../../control-plane/domain/index.ts";
import type {
  ControlPlaneResource, ReleaseReference, ResourceRelease, RuntimeConfigurationSnapshot, RuntimeTarget,
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
    const selected = await Promise.all(resources.map(async (resource) => ({ resource, selection: await this.selectedRelease(resource, target) })));
    const active = selected.flatMap(({ resource, selection }) => selection === undefined ? [] : [{ resource, ...selection }]);
    const modelRoutes = active.filter((entry) => entry.resource.kind === "model_route");
    if (modelRoutes.length > 1) throw new ControlPlaneError("configuration_unavailable", "More than one active model-route resource applies to this target");
    const skills = await Promise.all(active.filter((entry) => entry.resource.kind === "skill").map(async ({ release }) => {
      const packageHash = await this.repository.skillPackageHash(release.releaseId);
      if (packageHash === undefined) throw new ControlPlaneError("configuration_unavailable", `Skill release ${release.releaseId} has no verified package artifact`);
      return { releaseId: release.releaseId, packageHash, contentHash: release.contentHash };
    }));
    const integrations = active.filter((entry) => entry.resource.kind === "integration")
      .map(({ release, assignmentId }) => integrationReference(release, assignmentId));
    const policies = active.filter((entry) => entry.resource.kind === "policy")
      .map(({ release }) => ({ releaseId: release.releaseId, contentHash: release.contentHash }));
    const resolvedAt = this.now();
    const configurationRevision = await this.repository.configurationRevision();
    const snapshot: Omit<RuntimeConfigurationSnapshot, "snapshotId"> = {
      contractVersion: "control-plane/v1", configurationRevision, target, resolvedAt, validUntil: resolvedAt + this.ttlMs,
      ...(modelRoutes.length === 0 ? {} : { modelRoute: modelRouteReference(modelRoutes[0]!.release) }),
      integrations: integrations.sort(referenceOrder), skills: skills.sort(referenceOrder), policies: policies.sort(referenceOrder),
    };
    return { ...snapshot, snapshotId: snapshotHash(snapshot) };
  }

  private async selectedRelease(resource: ControlPlaneResource, target: RuntimeTarget): Promise<{ readonly release: ResourceRelease; readonly assignmentId: string } | undefined> {
    const assignments = await this.repository.listAssignments(resource.resourceId);
    const assignment = resolveEffectiveAssignment(assignments.filter((candidate) => candidate.rolloutState === "active"), target);
    if (assignment === undefined) return undefined;
    const release = await this.repository.getRelease(assignment.releaseId);
    if (release === undefined || release.state !== "active") return undefined;
    return { release, assignmentId: assignment.assignmentId };
  }
}

function modelRouteReference(release: ResourceRelease): { readonly releaseId: string; readonly contentHash: string; readonly providerConfiguration: Readonly<Record<string, unknown>> } {
  if (release.schemaVersion !== "model-route/v1" || !record(release.payload.providerConfiguration)) {
    throw new ControlPlaneError("configuration_unavailable", `Model route ${release.releaseId} does not contain a model-route/v1 provider configuration`);
  }
  return { releaseId: release.releaseId, contentHash: release.contentHash, providerConfiguration: release.payload.providerConfiguration };
}

function integrationReference(release: ResourceRelease, bindingId: string): { readonly bindingId: string; readonly releaseId: string; readonly contentHash: string; readonly integration?: string; readonly allowedActions?: readonly string[] } {
  const integration = typeof release.payload.integration === "string" ? release.payload.integration : undefined;
  const allowedActions = Array.isArray(release.payload.allowedActions) && release.payload.allowedActions.every((item) => typeof item === "string")
    ? release.payload.allowedActions as readonly string[] : undefined;
  return { bindingId, releaseId: release.releaseId, contentHash: release.contentHash, ...(integration === undefined || allowedActions === undefined ? {} : { integration, allowedActions }) };
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

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
