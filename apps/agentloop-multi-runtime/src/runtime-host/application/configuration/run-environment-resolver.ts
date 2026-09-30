import { LlmProviderRegistry } from "@zhujun/agentloop";
import type { RuntimeConfigurationSnapshot, RuntimeTarget } from "../../../../control-plane/contracts/index.ts";
import type { RuntimeAdmissionRunResolver, RuntimeHostRunPort } from "../runtime-run-port.ts";

export interface RuntimeConfigurationDeliveryPort {
  desiredSnapshot(): Promise<RuntimeConfigurationSnapshot>;
  reportLoaded(snapshot: RuntimeConfigurationSnapshot, receiptIdFor: (releaseId: string) => string): Promise<void>;
}

/** Only a successfully loaded snapshot may enter this cache. Implementations may persist it across Host restart. */
export interface LoadedRuntimeConfigurationSnapshotCache {
  get(target: RuntimeTarget): Promise<RuntimeConfigurationSnapshot | undefined>;
  put(snapshot: RuntimeConfigurationSnapshot): Promise<void>;
}

export interface ResolvedRunEnvironment {
  readonly snapshot: RuntimeConfigurationSnapshot;
  readonly providers: LlmProviderRegistry;
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

  public constructor(input: {
    readonly delivery: RuntimeConfigurationDeliveryPort;
    readonly cache: LoadedRuntimeConfigurationSnapshotCache;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly createReceiptId: () => string;
  }) {
    this.delivery = input.delivery;
    this.cache = input.cache;
    this.environment = input.environment;
    this.receiptId = input.createReceiptId;
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

  private build(snapshot: RuntimeConfigurationSnapshot): ResolvedRunEnvironment {
    if (snapshot.modelRoute === undefined) throw new RunEnvironmentUnavailableError("Control-plane snapshot has no model route");
    try {
      return {
        snapshot,
        providers: LlmProviderRegistry.fromConfigObject(snapshot.modelRoute.providerConfiguration, this.environment),
      };
    } catch {
      throw new RunEnvironmentUnavailableError("Control-plane model route is not a valid provider configuration");
    }
  }
}

/** Binds the explicit workload target to Router-provided tenant identity at admission. */
export class ControlPlaneAdmissionRunResolver implements RuntimeAdmissionRunResolver {
  private readonly target: RuntimeTarget;
  private readonly environments: RunEnvironmentResolver;
  private readonly portForEnvironment: (environment: ResolvedRunEnvironment) => RuntimeHostRunPort;
  public constructor(
    target: RuntimeTarget,
    environments: RunEnvironmentResolver,
    portForEnvironment: (environment: ResolvedRunEnvironment) => RuntimeHostRunPort,
  ) { this.target = target; this.environments = environments; this.portForEnvironment = portForEnvironment; }

  public async resolveForAdmission(subject: { readonly tenantId: string; readonly userId: string }): Promise<RuntimeHostRunPort> {
    if (subject.tenantId !== this.target.tenantId) {
      throw new RunEnvironmentUnavailableError("Dispatch tenant is not authorized for this control-plane Runtime target");
    }
    return this.portForEnvironment(await this.environments.resolveForAdmission(this.target));
  }
}

function assertTarget(actual: RuntimeTarget, expected: RuntimeTarget): void {
  if (
    actual.plane !== expected.plane
    || actual.tenantId !== expected.tenantId
    || actual.runtimeId !== expected.runtimeId
    || actual.runtimeClass !== expected.runtimeClass
    || actual.deviceId !== expected.deviceId
  ) throw new RunEnvironmentUnavailableError("Control-plane snapshot target does not match this admission target");
}
