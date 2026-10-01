import { parseRuntimeConfigurationSnapshot as parseContractSnapshot, type ApplyReceipt, type RuntimeConfigurationSnapshot, type RuntimeTarget, type SkillArtifactManifest, type SkillInstallReceipt } from "../../../../control-plane/contracts/index.ts";

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

  public async downloadSkillArtifact(manifest: SkillArtifactManifest): Promise<Uint8Array> {
    const response = await this.request(new URL(`/delivery/v1/skill-artifacts/${encodeURIComponent(manifest.packageHash)}`, `${this.deliveryUrl}/`), {
      headers: { authorization: `Bearer ${this.workloadToken}` },
    });
    if (!response.ok) throw new RuntimeConfigurationClientError(`Delivery skill-artifact returned HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  public async reportSkillInstallReceipt(receipt: SkillInstallReceipt): Promise<void> {
    const response = await this.request(new URL("/delivery/v1/skill-install-receipts", `${this.deliveryUrl}/`), {
      method: "POST", headers: { authorization: `Bearer ${this.workloadToken}`, "content-type": "application/json", "x-request-id": receipt.receiptId }, body: JSON.stringify({ receipt: { ...receipt, target: this.target } }),
    });
    if (!response.ok) throw new RuntimeConfigurationClientError(`Delivery skill-install-receipts returned HTTP ${response.status}`);
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
        method: "POST", headers: { authorization: `Bearer ${this.workloadToken}`, "content-type": "application/json", "x-request-id": receipt.receiptId }, body: JSON.stringify({ receipt }),
      });
      if (!response.ok) throw new RuntimeConfigurationClientError(`Delivery apply-receipts returned HTTP ${response.status}`);
    }
  }
}

/** Strict transport decoder reused by the durable Host snapshot cache. */
export function parseRuntimeConfigurationSnapshot(value: unknown): RuntimeConfigurationSnapshot {
  try { return parseContractSnapshot(value); }
  catch { throw new RuntimeConfigurationClientError("Delivery returned an invalid RuntimeConfigurationSnapshot"); }
}

function sameTarget(left: RuntimeTarget, right: RuntimeTarget): boolean { return left.plane === right.plane && left.scopeId === right.scopeId && left.runtimeId === right.runtimeId && left.runtimeClass === right.runtimeClass && left.deviceId === right.deviceId; }
