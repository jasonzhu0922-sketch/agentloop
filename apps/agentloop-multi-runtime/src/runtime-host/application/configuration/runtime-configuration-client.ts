import type { ApplyReceipt, RuntimeConfigurationSnapshot, RuntimeTarget } from "../../../../control-plane/contracts/index.ts";

export class RuntimeConfigurationClientError extends Error {
  public readonly code = "configuration_unavailable" as const;
  public constructor(message: string) { super(message); this.name = "RuntimeConfigurationClientError"; }
}

/** Workload-only delivery client. It exposes verified public metadata, never a secret or Admin API implementation. */
export class RuntimeConfigurationClient {
  private readonly deliveryUrl: string;
  private readonly workloadToken: string;
  private readonly target: RuntimeTarget;
  private readonly now: () => number;
  private readonly request: typeof fetch;
  private cached?: RuntimeConfigurationSnapshot;

  public constructor(input: {
    readonly deliveryUrl: string;
    readonly workloadToken: string;
    readonly target: RuntimeTarget;
    readonly now?: () => number;
    readonly request?: typeof fetch;
  }) {
    this.deliveryUrl = input.deliveryUrl.replace(/\/$/, "");
    this.workloadToken = input.workloadToken;
    this.target = input.target;
    this.now = input.now ?? (() => Date.now());
    this.request = input.request ?? fetch;
  }

  public cachedSnapshot(): RuntimeConfigurationSnapshot | undefined {
    return this.cached !== undefined && this.cached.validUntil > this.now() ? this.cached : undefined;
  }

  public async desiredSnapshot(): Promise<RuntimeConfigurationSnapshot> {
    const response = await this.request(new URL("/delivery/v1/desired-configuration", `${this.deliveryUrl}/`), {
      headers: { authorization: `Bearer ${this.workloadToken}` },
    });
    if (!response.ok) throw new RuntimeConfigurationClientError(`Delivery desired-configuration returned HTTP ${response.status}`);
    const snapshot = parseRuntimeConfigurationSnapshot(await response.json());
    if (!sameTarget(snapshot.target, this.target)) throw new RuntimeConfigurationClientError("Delivery snapshot target does not match this workload identity");
    if (snapshot.validUntil <= this.now()) throw new RuntimeConfigurationClientError("Delivery snapshot is expired");
    this.cached = snapshot;
    return snapshot;
  }

  /** Reports validation only; this must not be used to claim that a Runtime loaded or applied configuration. */
  public async reportValidated(snapshot: RuntimeConfigurationSnapshot, receiptIdFor: (releaseId: string) => string): Promise<void> {
    await this.reportApplyStatus(snapshot, "validated", receiptIdFor);
  }

  /** Reports a successfully constructed in-memory Run Environment; it does not imply a live Model invocation. */
  public async reportLoaded(snapshot: RuntimeConfigurationSnapshot, receiptIdFor: (releaseId: string) => string): Promise<void> {
    await this.reportApplyStatus(snapshot, "loaded", receiptIdFor);
  }

  private async reportApplyStatus(snapshot: RuntimeConfigurationSnapshot, status: ApplyReceipt["status"], receiptIdFor: (releaseId: string) => string): Promise<void> {
    const references = [
      ...(snapshot.modelRoute === undefined ? [] : [snapshot.modelRoute]),
      ...snapshot.integrations,
      ...snapshot.skills.map(({ releaseId, contentHash }) => ({ releaseId, contentHash })),
      ...snapshot.policies,
    ];
    for (const reference of references) {
      const receipt: ApplyReceipt = {
        contractVersion: "control-plane/v1", receiptId: receiptIdFor(reference.releaseId), target: this.target,
        releaseId: reference.releaseId, contentHash: reference.contentHash, status, observedAt: this.now(),
      };
      const response = await this.request(new URL("/delivery/v1/apply-receipts", `${this.deliveryUrl}/`), {
        method: "POST", headers: { authorization: `Bearer ${this.workloadToken}`, "content-type": "application/json" }, body: JSON.stringify({ receipt }),
      });
      if (!response.ok) throw new RuntimeConfigurationClientError(`Delivery apply-receipts returned HTTP ${response.status}`);
    }
  }
}

/** Strict transport decoder reused by the durable Host snapshot cache. */
export function parseRuntimeConfigurationSnapshot(value: unknown): RuntimeConfigurationSnapshot {
  if (!record(value) || value.contractVersion !== "control-plane/v1") throw invalidSnapshot();
  if (!text(value.snapshotId) || !integer(value.configurationRevision) || !integer(value.resolvedAt) || !integer(value.validUntil) || value.validUntil <= value.resolvedAt) throw invalidSnapshot();
  const target = parseTarget(value.target);
  const modelRoute = value.modelRoute === undefined ? undefined : parseModelRoute(value.modelRoute);
  if (!Array.isArray(value.integrations) || !Array.isArray(value.skills) || !Array.isArray(value.policies)) throw invalidSnapshot();
  const integrations = value.integrations.map((item) => {
    const reference = parseReference(item);
    if (!record(item) || !text(item.bindingId)) throw invalidSnapshot();
    return { bindingId: item.bindingId, ...reference };
  });
  const skills = value.skills.map((item) => {
    if (!record(item) || !text(item.releaseId) || !hash(item.packageHash) || !hash(item.contentHash)) throw invalidSnapshot();
    return { releaseId: item.releaseId, packageHash: item.packageHash, contentHash: item.contentHash };
  });
  return {
    contractVersion: "control-plane/v1", snapshotId: value.snapshotId, configurationRevision: value.configurationRevision,
    target, resolvedAt: value.resolvedAt, validUntil: value.validUntil, ...(modelRoute === undefined ? {} : { modelRoute }),
    integrations, skills, policies: value.policies.map(parseReference),
  };
}

function parseTarget(value: unknown): RuntimeTarget {
  if (!record(value) || (value.plane !== "cloud" && value.plane !== "local") || !text(value.tenantId) || !text(value.runtimeId)) throw invalidSnapshot();
  if (value.runtimeClass !== undefined && !text(value.runtimeClass)) throw invalidSnapshot();
  if (value.deviceId !== undefined && !text(value.deviceId)) throw invalidSnapshot();
  return { plane: value.plane, tenantId: value.tenantId, runtimeId: value.runtimeId, ...(value.runtimeClass === undefined ? {} : { runtimeClass: value.runtimeClass }), ...(value.deviceId === undefined ? {} : { deviceId: value.deviceId }) };
}

function parseReference(value: unknown): { readonly releaseId: string; readonly contentHash: string } {
  if (!record(value) || !text(value.releaseId) || !hash(value.contentHash)) throw invalidSnapshot();
  return { releaseId: value.releaseId, contentHash: value.contentHash };
}

function parseModelRoute(value: unknown): { readonly releaseId: string; readonly contentHash: string; readonly providerConfiguration: Readonly<Record<string, unknown>> } {
  const reference = parseReference(value);
  if (!record(value) || !record(value.providerConfiguration)) throw invalidSnapshot();
  return { ...reference, providerConfiguration: value.providerConfiguration };
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function invalidSnapshot(): RuntimeConfigurationClientError { return new RuntimeConfigurationClientError("Delivery returned an invalid RuntimeConfigurationSnapshot"); }
function sameTarget(left: RuntimeTarget, right: RuntimeTarget): boolean { return left.plane === right.plane && left.tenantId === right.tenantId && left.runtimeId === right.runtimeId && left.runtimeClass === right.runtimeClass && left.deviceId === right.deviceId; }
