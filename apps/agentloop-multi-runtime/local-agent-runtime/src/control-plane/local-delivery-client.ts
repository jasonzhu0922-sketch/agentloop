import type { ApplyReceipt, RuntimeConfigurationSnapshot, RuntimeTarget, SkillArtifactManifest, SkillInstallReceipt } from "../../../control-plane/contracts/index.ts";
import { parseRuntimeConfigurationSnapshot } from "../../../control-plane/contracts/index.ts";

/** Device-authenticated delivery client. The target is checked locally but never sent in request input. */
export class LocalDeliveryClient {
  private readonly input: { readonly deliveryUrl: string; readonly deviceToken: string; readonly target: RuntimeTarget; readonly request?: typeof fetch; readonly now?: () => number };
  public constructor(input: { readonly deliveryUrl: string; readonly deviceToken: string; readonly target: RuntimeTarget; readonly request?: typeof fetch; readonly now?: () => number }) { this.input = input; }

  async desiredSnapshot(): Promise<RuntimeConfigurationSnapshot> {
    const response = await this.fetch("/delivery/v1/desired-configuration");
    if (!response.ok) throw new LocalDeliveryError(response.status === 403 ? "target_not_authorized" : "configuration_unavailable");
    let snapshot: RuntimeConfigurationSnapshot;
    try { snapshot = parseRuntimeConfigurationSnapshot(await response.json()); } catch { throw new LocalDeliveryError("configuration_unavailable"); }
    if (!sameTarget(snapshot.target, this.input.target) || snapshot.validUntil <= this.now()) throw new LocalDeliveryError("configuration_unavailable");
    return snapshot;
  }

  async reportLoaded(snapshot: RuntimeConfigurationSnapshot, receiptIdFor: (releaseId: string) => string): Promise<void> {
    const references = [...(snapshot.modelRoute === undefined ? [] : [snapshot.modelRoute]), ...snapshot.integrations, ...snapshot.skills, ...snapshot.policies];
    for (const reference of references) {
      const receipt: ApplyReceipt = { contractVersion: "control-plane/v1", receiptId: receiptIdFor(reference.releaseId), target: this.input.target, releaseId: reference.releaseId, contentHash: reference.contentHash, status: "loaded", observedAt: this.now() };
      const response = await this.fetch("/delivery/v1/apply-receipts", { method: "POST", headers: { "content-type": "application/json", "x-request-id": receipt.receiptId }, body: JSON.stringify({ receipt }) });
      if (!response.ok) throw new LocalDeliveryError(response.status === 403 ? "target_not_authorized" : "configuration_unavailable");
    }
  }

  async downloadSkillArtifact(manifest: SkillArtifactManifest): Promise<Uint8Array> {
    const response = await this.fetch(`/delivery/v1/skill-artifacts/${encodeURIComponent(manifest.packageHash)}`);
    if (!response.ok) throw new LocalDeliveryError(response.status === 403 ? "target_not_authorized" : "configuration_unavailable");
    return new Uint8Array(await response.arrayBuffer());
  }

  async reportSkillInstallReceipt(receipt: SkillInstallReceipt): Promise<void> {
    const response = await this.fetch("/delivery/v1/skill-install-receipts", { method: "POST", headers: { "content-type": "application/json", "x-request-id": receipt.receiptId }, body: JSON.stringify({ receipt: { ...receipt, target: this.input.target } }) });
    if (!response.ok) throw new LocalDeliveryError(response.status === 403 ? "target_not_authorized" : "configuration_unavailable");
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> { return await (this.input.request ?? fetch)(new URL(path, `${this.input.deliveryUrl.replace(/\/$/, "")}/`), { ...init, headers: { authorization: `Bearer ${this.input.deviceToken}`, ...init.headers } }); }
  private now(): number { return (this.input.now ?? (() => Date.now()))(); }
}

export class LocalDeliveryError extends Error { public readonly code: "configuration_unavailable" | "target_not_authorized"; public constructor(code: "configuration_unavailable" | "target_not_authorized") { super(code); this.name = "LocalDeliveryError"; this.code = code; } }
function sameTarget(left: RuntimeTarget, right: RuntimeTarget): boolean { return left.plane === right.plane && left.tenantId === right.tenantId && left.runtimeId === right.runtimeId && left.runtimeClass === right.runtimeClass && left.deviceId === right.deviceId; }
