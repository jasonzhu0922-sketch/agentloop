import { LlmProviderRegistry, type PracticeProfileCatalog, type RuntimeConfigurationSnapshotReference } from "@zhujun/agentloop";
import { assertSkillArtifactsReady, type RuntimeConfigurationSnapshot, type RuntimeTarget } from "../../../../control-plane/contracts/index.ts";
import { resolveControlPlanePolicy } from "../../../shared/control-plane-policy.ts";
import type { StepExecutionStrategyProfileConfig } from "../../../shared/config.ts";
import type { RuntimeAdmissionRunResolver, RuntimeHostRunPort } from "../runtime-run-port.ts";

export interface RuntimeConfigurationDeliveryPort {
  desiredSnapshot(): Promise<RuntimeConfigurationSnapshot>;
  reportLoaded(snapshot: RuntimeConfigurationSnapshot, receiptIdFor: (releaseId: string) => string): Promise<void>;
}

/** Only a successfully loaded snapshot may enter this cache. Implementations may persist it across Host restart. */
export interface LoadedRuntimeConfigurationSnapshotCache {
  get(target: RuntimeTarget): Promise<RuntimeConfigurationSnapshot | undefined>;
  getBySnapshotId(target: RuntimeTarget, snapshotId: string): Promise<RuntimeConfigurationSnapshot | undefined>;
  put(snapshot: RuntimeConfigurationSnapshot): Promise<void>;
}

export interface ResolvedRunEnvironment {
  readonly snapshot: RuntimeConfigurationSnapshot;
  readonly configurationSnapshot: RuntimeConfigurationSnapshotReference;
  readonly providers: LlmProviderRegistry;
  readonly practiceProfileCatalog?: PracticeProfileCatalog;
  readonly stepExecutionStrategy?: StepExecutionStrategyProfileConfig;
  readonly planTemplates: readonly Readonly<Record<string, unknown>>[];
}

/** Stable admission failure: callers must not substitute file configuration in control-plane mode. */
export class RunEnvironmentUnavailableError extends Error {
  public readonly code = "configuration_unavailable" as const;
  public constructor(message: string) { super(message); this.name = "RunEnvironmentUnavailableError"; }
}

/**
 * Resolves a new immutable environment per admission. It never mutates a
 * shared Provider registry, so an old Run retains the registry that admitted it.
 */
export class RunEnvironmentResolver {
  private readonly delivery: RuntimeConfigurationDeliveryPort;
  private readonly cache: LoadedRuntimeConfigurationSnapshotCache;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly receiptId: () => string;
  private readonly loadedSkillPackageHashes?: () => readonly string[];
  private readonly requireSignedSkillArtifacts: boolean;

  public constructor(input: {
    readonly delivery: RuntimeConfigurationDeliveryPort;
    readonly cache: LoadedRuntimeConfigurationSnapshotCache;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly createReceiptId: () => string;
    readonly loadedSkillPackageHashes?: () => readonly string[];
    readonly requireSignedSkillArtifacts?: boolean;
  }) {
    this.delivery = input.delivery;
    this.cache = input.cache;
    this.environment = input.environment;
    this.receiptId = input.createReceiptId;
    this.loadedSkillPackageHashes = input.loadedSkillPackageHashes;
    this.requireSignedSkillArtifacts = input.requireSignedSkillArtifacts === true;
  }

  /** Fetches, validates, constructs, receipts, then persists a new-admission environment in that order. */
  public async resolveForAdmission(target: RuntimeTarget): Promise<ResolvedRunEnvironment> {
    const snapshot = await this.delivery.desiredSnapshot().catch(() => {
      throw new RunEnvironmentUnavailableError("No current control-plane configuration snapshot is available");
    });
    assertTarget(snapshot.target, target);
    const resolved = this.build(snapshot);
    try {
      await this.delivery.reportLoaded(snapshot, (releaseId) => `loaded:${snapshot.snapshotId}:${releaseId}:${this.receiptId()}`);
    } catch {
      throw new RunEnvironmentUnavailableError("Control-plane configuration snapshot could not be confirmed loaded");
    }
    await this.cache.put(snapshot);
    return resolved;
  }

  /** Rebuilds and re-receipts the most recent confirmed snapshot after a Host restart. */
  public async restoreConfirmed(target: RuntimeTarget, now: () => number = Date.now): Promise<ResolvedRunEnvironment> {
    const snapshot = await this.cache.get(target);
    if (snapshot === undefined || snapshot.validUntil <= now()) {
      throw new RunEnvironmentUnavailableError("No unexpired confirmed control-plane configuration snapshot is available");
    }
    const resolved = this.build(snapshot);
    try {
      await this.delivery.reportLoaded(snapshot, (releaseId) => `recovered:${snapshot.snapshotId}:${releaseId}:${this.receiptId()}`);
    } catch {
      throw new RunEnvironmentUnavailableError("Confirmed control-plane configuration snapshot could not be re-receipted");
    }
    return resolved;
  }

  /** Rebuilds the exact acknowledged snapshot that an existing Run persisted at admission. */
  public async restoreForRun(target: RuntimeTarget, reference: RuntimeConfigurationSnapshotReference): Promise<ResolvedRunEnvironment> {
    const snapshot = await this.cache.getBySnapshotId(target, reference.snapshotId);
    if (snapshot === undefined) throw new RunEnvironmentUnavailableError("The configuration snapshot bound to this Run is unavailable");
    assertTarget(snapshot.target, target);
    const resolved = this.build(snapshot);
    assertSnapshotReference(resolved.configurationSnapshot, reference);
    try {
      await this.delivery.reportLoaded(snapshot, (releaseId) => `recovered:${snapshot.snapshotId}:${releaseId}:${this.receiptId()}`);
    } catch {
      throw new RunEnvironmentUnavailableError("Run-bound control-plane configuration snapshot could not be re-receipted");
    }
    return resolved;
  }

  private build(snapshot: RuntimeConfigurationSnapshot): ResolvedRunEnvironment {
    if (snapshot.modelRoute === undefined) throw new RunEnvironmentUnavailableError("Control-plane snapshot has no model route");
    try {
      if (this.loadedSkillPackageHashes !== undefined) {
        assertSkillArtifactsReady(snapshot, this.loadedSkillPackageHashes(), this.requireSignedSkillArtifacts);
      }
      const policy = resolveControlPlanePolicy(snapshot.policies);
      return {
        snapshot,
        configurationSnapshot: configurationSnapshotReference(snapshot),
        providers: LlmProviderRegistry.fromConfigObject(snapshot.modelRoute.providerConfiguration, this.environment),
        ...(policy.practiceProfileCatalog === undefined ? {} : { practiceProfileCatalog: policy.practiceProfileCatalog }),
        ...(policy.stepExecutionStrategy === undefined ? {} : { stepExecutionStrategy: policy.stepExecutionStrategy }),
        planTemplates: policy.planTemplates,
      };
    } catch (error) {
      if (error instanceof RunEnvironmentUnavailableError) throw error;
      throw new RunEnvironmentUnavailableError("Control-plane configuration is unavailable");
    }
  }
}

function configurationSnapshotReference(snapshot: RuntimeConfigurationSnapshot): RuntimeConfigurationSnapshotReference {
  return {
    snapshotId: snapshot.snapshotId,
    configurationRevision: snapshot.configurationRevision,
    releases: [
      ...(snapshot.modelRoute === undefined ? [] : [{ kind: "model_route" as const, releaseId: snapshot.modelRoute.releaseId, contentHash: snapshot.modelRoute.contentHash }]),
      ...snapshot.integrations.map((item) => ({ kind: "integration" as const, releaseId: item.releaseId, contentHash: item.contentHash })),
      ...snapshot.skills.map((item) => ({ kind: "skill" as const, releaseId: item.releaseId, contentHash: item.contentHash, packageHash: item.packageHash })),
      ...snapshot.policies.map((item) => ({ kind: "policy" as const, releaseId: item.releaseId, contentHash: item.contentHash })),
    ],
  };
}

/** Binds the explicit workload target to Router-provided tenant identity at admission. */
export class ControlPlaneAdmissionRunResolver implements RuntimeAdmissionRunResolver {
  private readonly target: RuntimeTarget;
  private readonly environments: RunEnvironmentResolver;
  private readonly portForEnvironment: (environment: ResolvedRunEnvironment) => RuntimeHostRunPort | Promise<RuntimeHostRunPort>;
  private readonly portsBySnapshotId = new Map<string, {
    readonly configurationSnapshot: RuntimeConfigurationSnapshotReference;
    readonly port: Promise<RuntimeHostRunPort>;
  }>();
  public constructor(
    target: RuntimeTarget,
    environments: RunEnvironmentResolver,
    portForEnvironment: (environment: ResolvedRunEnvironment) => RuntimeHostRunPort | Promise<RuntimeHostRunPort>,
  ) { this.target = target; this.environments = environments; this.portForEnvironment = portForEnvironment; }

  public async resolveForAdmission(subject: { readonly scopeId: string; readonly userId: string }): Promise<RuntimeHostRunPort> {
    if (subject.scopeId !== this.target.scopeId) {
      throw new RunEnvironmentUnavailableError("Dispatch tenant is not authorized for this control-plane Runtime target");
    }
    return await this.portForEnvironment(await this.environments.resolveForAdmission(this.target));
  }

  public async resolveForRun(configurationSnapshot: RuntimeConfigurationSnapshotReference): Promise<RuntimeHostRunPort> {
    const existing = this.portsBySnapshotId.get(configurationSnapshot.snapshotId);
    if (existing !== undefined) {
      assertSnapshotReference(existing.configurationSnapshot, configurationSnapshot);
      return await existing.port;
    }
    const created = this.environments.restoreForRun(this.target, configurationSnapshot)
      .then(async (environment) => await this.portForEnvironment(environment));
    this.portsBySnapshotId.set(configurationSnapshot.snapshotId, { configurationSnapshot, port: created });
    try {
      return await created;
    } catch (error) {
      this.portsBySnapshotId.delete(configurationSnapshot.snapshotId);
      throw error;
    }
  }
}

function assertTarget(actual: RuntimeTarget, expected: RuntimeTarget): void {
  if (
    actual.plane !== expected.plane
    || actual.scopeId !== expected.scopeId
    || actual.runtimeId !== expected.runtimeId
    || actual.runtimeClass !== expected.runtimeClass
    || actual.deviceId !== expected.deviceId
  ) throw new RunEnvironmentUnavailableError("Control-plane snapshot target does not match this admission target");
}

function assertSnapshotReference(actual: RuntimeConfigurationSnapshotReference, expected: RuntimeConfigurationSnapshotReference): void {
  if (actual.snapshotId !== expected.snapshotId || actual.configurationRevision !== expected.configurationRevision) {
    throw new RunEnvironmentUnavailableError("Control-plane snapshot does not match the Run's persisted configuration reference");
  }
  const actualReleases = new Set(actual.releases.map(releaseKey));
  const expectedReleases = new Set(expected.releases.map(releaseKey));
  if (actualReleases.size !== expectedReleases.size || [...expectedReleases].some((key) => !actualReleases.has(key))) {
    throw new RunEnvironmentUnavailableError("Control-plane snapshot releases do not match the Run's persisted configuration reference");
  }
}

function releaseKey(release: RuntimeConfigurationSnapshotReference["releases"][number]): string {
  return `${release.kind}:${release.releaseId}:${release.contentHash}:${release.packageHash ?? ""}`;
}
