import { createHash } from "node:crypto";
import type {
  CreateTargetAssignmentCommand, PublishReleaseCommand, RecordApplyReceiptCommand, ResourceRelease, TransitionReleaseCommand,
} from "../../../control-plane/contracts/index.ts";
import { assertReleaseShape, ControlPlaneError, freezeRelease } from "../../../control-plane/domain/index.ts";
import type { ControlPlaneWritePort } from "../../../control-plane/domain/ports.ts";

/** Application boundary for all release mutations. HTTP transports only decode/authenticate before calling it. */
export class ReleaseApplicationService {
  private readonly store: ControlPlaneWritePort;

  public constructor(store: ControlPlaneWritePort) { this.store = store; }

  public async publish(command: PublishReleaseCommand): Promise<ResourceRelease> {
    assertReleaseShape(command.release);
    if (command.release.state !== "draft") {
      throw new ControlPlaneError("invalid_release_transition", "New releases must begin in draft state");
    }
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
      throw new ControlPlaneError("invalid_contract", "expectedRevision must be a non-negative safe integer");
    }
    if (command.release.contentHash !== contentHashForRelease(command.release)) {
      throw new ControlPlaneError("release_hash_mismatch", `Release ${command.release.releaseId} contentHash does not match its immutable content`);
    }
    return await this.store.publishRelease({ ...command, release: freezeRelease(command.release) });
  }

  public async assign(command: CreateTargetAssignmentCommand): Promise<void> {
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
      throw new ControlPlaneError("invalid_contract", "expectedRevision must be a non-negative safe integer");
    }
    await this.store.createTargetAssignment(command);
  }

  public async transition(command: TransitionReleaseCommand): Promise<ResourceRelease> {
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
      throw new ControlPlaneError("invalid_contract", "expectedRevision must be a non-negative safe integer");
    }
    return await this.store.transitionRelease(command);
  }

  public async recordReceipt(command: RecordApplyReceiptCommand): Promise<void> {
    if (!command.receipt.receiptId.trim() || !Number.isSafeInteger(command.receipt.observedAt) || command.receipt.observedAt < 0) {
      throw new ControlPlaneError("invalid_contract", "Receipt identity and observedAt are invalid");
    }
    await this.store.recordApplyReceipt(command);
  }
}

/** Canonical JSON is deliberately local and deterministic; secret values never enter this object. */
export function contentHashForRelease(release: Pick<ResourceRelease, "kind" | "schemaVersion" | "payload">): string {
  return createHash("sha256").update(canonicalJson({ kind: release.kind, schemaVersion: release.schemaVersion, payload: release.payload })).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    throw new ControlPlaneError("invalid_contract", "Release content must be JSON-serializable");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ControlPlaneError("invalid_contract", "Release content cannot contain non-finite numbers");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
