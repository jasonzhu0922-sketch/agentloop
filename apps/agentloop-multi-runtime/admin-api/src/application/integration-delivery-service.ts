import { createHash, randomUUID } from "node:crypto";
import type { SqlConnection } from "@zhujun/agentloop";
import type {
  CredentialGrant, CredentialGrantRequest, IntegrationInvocationReceipt, IntegrationInvocationRequest,
  IntegrationInvocationResponse, RuntimeConfigurationSnapshot, RuntimeTarget,
} from "../../../control-plane/contracts/index.ts";
import { ControlPlaneError } from "../../../control-plane/domain/index.ts";
import type { RuntimeConfigurationSnapshotPort } from "../transport/admin-http/handler.ts";

/**
 * The only adapter allowed to consume a secret reference. Its implementation is
 * deployment-owned and returns already-redacted integration data, never a key
 * or access token. There intentionally is no environment-file implementation.
 */
export interface IntegrationSecretProviderPort {
  invoke(input: {
    readonly target: RuntimeTarget;
    readonly integration: string;
    readonly action: string;
    readonly secretReferenceId: string;
    readonly secretReferenceVersion: string;
    readonly args: Readonly<Record<string, unknown>>;
  }): Promise<Readonly<Record<string, unknown>>>;
}

type GrantRow = {
  id: string; invocation_id: string; target_plane: string; tenant_id: string; runtime_id: string; runtime_class: string | null; device_id: string | null;
  binding_id: string; release_id: string; content_hash: string; secret_reference_id: string; secret_reference_version: string;
  expires_at: number | string | bigint; revoked_at: number | string | bigint | null; used_at: number | string | bigint | null;
};

type BindingRow = { id: string; release_id: string; credential_reference_id: string | null };
type SecretReferenceRow = { id: string; secret_version: string; rotation_state: string };

/**
 * Admin-owned delivery service. It persists capability and receipt metadata,
 * derives authorization from the workload target plus the active snapshot, and
 * delegates the actual secret-bearing request to a constrained infrastructure port.
 */
export class SqlIntegrationDeliveryService {
  private readonly input: {
    readonly database: SqlConnection;
    readonly snapshots: RuntimeConfigurationSnapshotPort;
    readonly secretProvider: IntegrationSecretProviderPort;
    readonly now?: () => number;
    readonly grantTtlMs?: number;
  };

  public constructor(input: {
    readonly database: SqlConnection;
    readonly snapshots: RuntimeConfigurationSnapshotPort;
    readonly secretProvider: IntegrationSecretProviderPort;
    readonly now?: () => number;
    readonly grantTtlMs?: number;
  }) {
    this.input = input;
    const ttl = this.input.grantTtlMs ?? 30_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 300_000) throw new TypeError("grantTtlMs must be between 1 and 300000 milliseconds");
  }

  public async requestGrant(target: RuntimeTarget, request: CredentialGrantRequest): Promise<CredentialGrant> {
    assertGrantRequest(request);
    const snapshot = await this.input.snapshots.desiredSnapshot(target);
    const binding = authorizedBinding(snapshot, target, request);
    const bindingRow = await this.input.database.prepare("SELECT id, release_id, credential_reference_id FROM cp_integration_bindings WHERE id = ?").get<BindingRow>(binding.bindingId);
    if (bindingRow === undefined || bindingRow.release_id !== request.releaseId || bindingRow.credential_reference_id === null) {
      throw new ControlPlaneError("integration_not_authorized", "Integration binding is not credential-enabled");
    }
    const secret = await this.input.database.prepare("SELECT id, secret_version, rotation_state FROM cp_secret_references WHERE id = ?").get<SecretReferenceRow>(bindingRow.credential_reference_id);
    if (secret === undefined || secret.rotation_state !== "active") {
      throw new ControlPlaneError("credential_grant_expired", "Integration credential reference is unavailable");
    }
    const now = this.now();
    const expiresAt = Math.min(snapshot.validUntil, now + this.ttl());
    if (expiresAt <= now) throw new ControlPlaneError("credential_grant_expired", "Integration credential grant would already be expired");
    const grant: CredentialGrant = {
      contractVersion: "control-plane/v1", grantId: randomUUID(), invocationId: request.invocationId,
      bindingId: binding.bindingId, releaseId: binding.releaseId, contentHash: binding.contentHash,
      secretReferenceVersion: secret.secret_version, expiresAt,
    };
    await this.input.database.prepare(`INSERT INTO cp_credential_grants(
      id, invocation_id, target_plane, tenant_id, runtime_id, runtime_class, device_id, binding_id, release_id, content_hash,
      secret_reference_id, secret_reference_version, expires_at, revoked_at, used_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
      .run(grant.grantId, grant.invocationId, target.plane, target.tenantId, target.runtimeId, target.runtimeClass ?? null, target.deviceId ?? null,
        grant.bindingId, grant.releaseId, grant.contentHash, secret.id, grant.secretReferenceVersion, grant.expiresAt, now);
    return grant;
  }

  public async invoke(target: RuntimeTarget, request: IntegrationInvocationRequest): Promise<IntegrationInvocationResponse> {
    assertInvocationRequest(request);
    const now = this.now();
    const grant = await this.input.database.prepare(`SELECT id, invocation_id, target_plane, tenant_id, runtime_id, runtime_class, device_id,
      binding_id, release_id, content_hash, secret_reference_id, secret_reference_version, expires_at, revoked_at, used_at
      FROM cp_credential_grants WHERE id = ?`).get<GrantRow>(request.grantId);
    if (grant === undefined || !matchesGrant(grant, target, request) || asNumber(grant.expires_at) <= now || grant.revoked_at !== null || grant.used_at !== null) {
      throw new ControlPlaneError("credential_grant_expired", "Credential grant is expired, revoked, consumed, or bound to another invocation");
    }
    // The conditional update makes the persisted capability single-use across concurrent broker requests.
    const consumed = await this.input.database.prepare("UPDATE cp_credential_grants SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
      .run(now, grant.id, now);
    if (Number(consumed.changes) !== 1) throw new ControlPlaneError("credential_grant_expired", "Credential grant is no longer usable");
    const receiptId = randomUUID();
    try {
      const result = await this.input.secretProvider.invoke({
        target, integration: request.invocation.integration, action: request.invocation.action,
        secretReferenceId: grant.secret_reference_id, secretReferenceVersion: grant.secret_reference_version, args: request.args,
      });
      assertRedactedResult(result);
      const receipt = receiptFor(receiptId, request, grant, "completed", undefined, now);
      await this.recordInvocation(receipt, request, argsHash(request.args));
      return { result, receipt };
    } catch (error) {
      const code = error instanceof ControlPlaneError && error.code === "integration_response_invalid"
        ? "integration_response_invalid" : "integration_upstream_failed";
      const receipt = receiptFor(receiptId, request, grant, "failed", code, now);
      await this.recordInvocation(receipt, request, argsHash(request.args));
      throw new ControlPlaneError(code, "Integration invocation failed");
    }
  }

  /** Called by a credential-rotation or emergency-revocation adapter, never by a Skill process. */
  public async revokeBinding(bindingId: string): Promise<number> {
    if (!text(bindingId)) throw new ControlPlaneError("invalid_contract", "Integration binding id is required");
    const now = this.now();
    const result = await this.input.database.prepare("UPDATE cp_credential_grants SET revoked_at = ? WHERE binding_id = ? AND revoked_at IS NULL AND used_at IS NULL AND expires_at > ?")
      .run(now, bindingId, now);
    return Number(result.changes);
  }

  private async recordInvocation(receipt: IntegrationInvocationReceipt, request: IntegrationInvocationRequest, argumentHash: string): Promise<void> {
    await this.input.database.prepare(`INSERT INTO cp_integration_invocations(
      id, grant_id, invocation_id, binding_id, release_id, content_hash, action, args_hash, secret_reference_version, status, reason_code, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(receipt.receiptId, request.grantId, receipt.invocationId, receipt.bindingId, receipt.releaseId, receipt.contentHash,
        request.invocation.action, argumentHash, receipt.secretReferenceVersion, receipt.status, receipt.reasonCode ?? null, receipt.observedAt);
  }

  private now(): number { return (this.input.now ?? (() => Date.now()))(); }
  private ttl(): number { return this.input.grantTtlMs ?? 30_000; }
}

function authorizedBinding(snapshot: RuntimeConfigurationSnapshot, target: RuntimeTarget, request: CredentialGrantRequest): { readonly bindingId: string; readonly releaseId: string; readonly contentHash: string } {
  if (!sameTarget(snapshot.target, target) || snapshot.validUntil <= request.requestedAt) {
    throw new ControlPlaneError("integration_not_authorized", "Snapshot is no longer valid for this invocation");
  }
  const binding = snapshot.integrations.find((candidate) => candidate.bindingId === request.bindingId
    && candidate.releaseId === request.releaseId && candidate.contentHash === request.contentHash
    && candidate.integration === request.integration && candidate.allowedActions?.includes(request.action));
  if (binding === undefined) throw new ControlPlaneError("integration_not_authorized", "Invocation does not match an active integration binding");
  return binding;
}

function matchesGrant(grant: GrantRow, target: RuntimeTarget, request: IntegrationInvocationRequest): boolean {
  const invocation = request.invocation;
  return grant.invocation_id === invocation.invocationId && grant.binding_id === invocation.bindingId && grant.release_id === invocation.releaseId
    && grant.content_hash === invocation.contentHash && grant.target_plane === target.plane && grant.tenant_id === target.tenantId
    && grant.runtime_id === target.runtimeId && grant.runtime_class === (target.runtimeClass ?? null) && grant.device_id === (target.deviceId ?? null);
}

function receiptFor(id: string, request: IntegrationInvocationRequest, grant: GrantRow, status: IntegrationInvocationReceipt["status"], reasonCode: IntegrationInvocationReceipt["reasonCode"] | undefined, observedAt: number): IntegrationInvocationReceipt {
  return {
    contractVersion: "control-plane/v1", receiptId: id, invocationId: request.invocation.invocationId,
    bindingId: request.invocation.bindingId, releaseId: request.invocation.releaseId, contentHash: request.invocation.contentHash,
    secretReferenceVersion: grant.secret_reference_version, status, ...(reasonCode === undefined ? {} : { reasonCode }), observedAt,
  };
}

function assertGrantRequest(value: CredentialGrantRequest): void {
  if (value.contractVersion !== "control-plane/v1" || !text(value.invocationId) || !text(value.runId) || !text(value.integration)
    || !text(value.action) || !text(value.bindingId) || !text(value.releaseId) || !hash(value.contentHash) || !Array.isArray(value.skillNames)
    || !value.skillNames.every(text) || !Number.isSafeInteger(value.requestedAt) || value.requestedAt < 0) {
    throw new ControlPlaneError("invalid_contract", "Invalid credential grant request");
  }
}

function assertInvocationRequest(value: IntegrationInvocationRequest): void {
  if (value.contractVersion !== "control-plane/v1" || !text(value.grantId) || value.invocation === undefined || !record(value.args)) {
    throw new ControlPlaneError("invalid_contract", "Invalid integration invocation request");
  }
  assertGrantRequest(value.invocation);
}

function assertRedactedResult(result: Readonly<Record<string, unknown>>): void {
  const serialized = JSON.stringify(result);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 256 * 1024 || containsSensitiveField(result)) {
    throw new ControlPlaneError("integration_response_invalid", "Integration response contains unsupported data");
  }
}

function containsSensitiveField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveField);
  if (!record(value)) return false;
  return Object.entries(value).some(([key, child]) => /(?:secret|token|password|authorization|api[_-]?key)/i.test(key) || containsSensitiveField(child));
}

function argsHash(args: Readonly<Record<string, unknown>>): string { return createHash("sha256").update(canonicalJson(args)).digest("hex"); }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const recordValue = value as Record<string, unknown>;
  return `{${Object.keys(recordValue).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(recordValue[key])}`).join(",")}}`;
}
function sameTarget(left: RuntimeTarget, right: RuntimeTarget): boolean { return left.plane === right.plane && left.tenantId === right.tenantId && left.runtimeId === right.runtimeId && left.runtimeClass === right.runtimeClass && left.deviceId === right.deviceId; }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function record(value: unknown): value is Readonly<Record<string, unknown>> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function asNumber(value: number | string | bigint): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw new ControlPlaneError("credential_grant_expired", "Persisted grant expiry is invalid"); return parsed; }
