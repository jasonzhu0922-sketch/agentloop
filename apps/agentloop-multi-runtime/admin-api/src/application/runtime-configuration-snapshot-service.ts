import { createHash } from "node:crypto";
import type { ConfigurationSnapshotRepositoryPort } from "../../../control-plane/domain/ports.ts";
import { ControlPlaneError, resolveEffectiveAssignment } from "../../../control-plane/domain/index.ts";
import type {
  ControlPlaneResource, ReleaseReference, ResourceRelease, RuntimeConfigurationSnapshot, RuntimeTarget,
} from "../../../control-plane/contracts/index.ts";

export interface RuntimeModelConfigurationPort {
  configuration(): Promise<{ readonly revision: number; readonly contentHash: string; readonly providerConfiguration: Readonly<Record<string, unknown>> }>;
}

/** Resolves only active desired state. It never reads a secret reference/value or Runtime database. */
export class RuntimeConfigurationSnapshotService {
  private readonly repository: ConfigurationSnapshotRepositoryPort;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly modelConfiguration?: RuntimeModelConfigurationPort;

  public constructor(input: { readonly repository: ConfigurationSnapshotRepositoryPort; readonly now: () => number; readonly ttlMs: number; readonly modelConfiguration?: RuntimeModelConfigurationPort }) {
    this.repository = input.repository;
    this.now = input.now;
    this.ttlMs = input.ttlMs;
    this.modelConfiguration = input.modelConfiguration;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) throw new TypeError("snapshot ttlMs must be a positive safe integer");
  }

  public async desiredSnapshot(target: RuntimeTarget): Promise<RuntimeConfigurationSnapshot> {
    const resources = await this.repository.listResources();
    const selected = await Promise.all(resources.map(async (resource) => ({ resource, selection: await this.selectedRelease(resource, target) })));
    const active = selected.flatMap(({ resource, selection }) => selection === undefined ? [] : [{ resource, ...selection }]);
    const modelRoutes = this.modelConfiguration === undefined ? active.filter((entry) => entry.resource.kind === "model_route") : [];
    if (modelRoutes.length > 1) throw new ControlPlaneError("configuration_unavailable", "More than one active model-route resource applies to this target");
    const skills = await Promise.all(active.filter((entry) => entry.resource.kind === "skill").map(async ({ release }) => {
      const artifact = this.repository.skillArtifact === undefined ? undefined : await this.repository.skillArtifact(release.releaseId);
      if (artifact === undefined || artifact.packageHash !== artifactHash(release, artifact.packageHash)) {
        throw new ControlPlaneError("configuration_unavailable", `Skill release ${release.releaseId} has no verified signed package artifact`);
      }
      return { releaseId: release.releaseId, packageHash: artifact.packageHash, contentHash: release.contentHash, artifact: {
        packageUri: artifact.packageUri, packageHash: artifact.packageHash, signer: artifact.signer,
        signatureAlgorithm: artifact.signatureAlgorithm, signature: artifact.signature,
        ...(artifact.compatibility === undefined ? {} : { compatibility: artifact.compatibility }),
      } };
    }));
    const integrations = active.filter((entry) => entry.resource.kind === "integration")
      .map(({ release, assignmentId }) => integrationReference(release, assignmentId));
    const policies = active.filter((entry) => entry.resource.kind === "policy")
      .map(({ release }) => ({ releaseId: release.releaseId, contentHash: release.contentHash, ...(policyManifest(release.payload) === undefined ? {} : { policy: policyManifest(release.payload) }) }));
    const resolvedAt = this.now();
    const configurationRevision = await this.repository.configurationRevision();
    const modelRoute = this.modelConfiguration === undefined
      ? (modelRoutes.length === 0 ? undefined : modelRouteReference(modelRoutes[0]!.release))
      : await this.routerModelRoute();
    const snapshot: Omit<RuntimeConfigurationSnapshot, "snapshotId"> = {
      contractVersion: "control-plane/v1", configurationRevision, target, resolvedAt, validUntil: resolvedAt + this.ttlMs,
      ...(modelRoute === undefined ? {} : { modelRoute }),
      integrations: integrations.sort(referenceOrder), skills: skills.sort(referenceOrder), policies: policies.sort(referenceOrder),
    };
    return { ...snapshot, snapshotId: snapshotHash(snapshot) };
  }

  private async routerModelRoute(): Promise<RuntimeConfigurationSnapshot["modelRoute"]> {
    const model = await this.modelConfiguration!.configuration();
    return { releaseId: `router-model-catalog:${model.revision}`, contentHash: model.contentHash, providerConfiguration: model.providerConfiguration };
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

function artifactHash(release: ResourceRelease, packageHash: string): string {
  const declared = release.payload.packageHash;
  return typeof declared === "string" && declared.length > 0 ? declared : packageHash;
}

function policyManifest(payload: Readonly<Record<string, unknown>>): {
  readonly practiceProfileCatalog?: Readonly<Record<string, unknown>>;
  readonly stepExecutionStrategy?: Readonly<Record<string, unknown>>;
  readonly planTemplates?: readonly Readonly<Record<string, unknown>>[];
} | undefined {
  const policy = payload.policy;
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) return undefined;
  const value = policy as Record<string, unknown>;
  const result: {
    practiceProfileCatalog?: Readonly<Record<string, unknown>>;
    stepExecutionStrategy?: Readonly<Record<string, unknown>>;
    planTemplates?: readonly Readonly<Record<string, unknown>>[];
  } = {};
  if (isRecord(value.practiceProfileCatalog)) result.practiceProfileCatalog = value.practiceProfileCatalog;
  if (isRecord(value.stepExecutionStrategy)) result.stepExecutionStrategy = value.stepExecutionStrategy;
  if (Array.isArray(value.planTemplates) && value.planTemplates.every(isRecord)) result.planTemplates = value.planTemplates;
  return Object.keys(result).length === 0 ? undefined : result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
