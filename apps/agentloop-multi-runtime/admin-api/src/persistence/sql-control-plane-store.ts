import type { SqlConnection } from "@zhujun/agentloop";
import type {
  ApplyReceipt, CreateTargetAssignmentCommand, PublishReleaseCommand, RecordApplyReceiptCommand,
  ResourceRelease, TargetAssignment, TransitionReleaseCommand,
} from "../../../control-plane/contracts/index.ts";
import { assertAssignmentShape, assertNoAssignmentConflict, ControlPlaneError, transitionRelease } from "../../../control-plane/domain/index.ts";
import type { ControlPlaneWritePort } from "../../../control-plane/domain/ports.ts";

type ResourceRow = { id: string; kind: ResourceRelease["kind"]; revision: number | string | bigint };
type ReleaseRow = {
  id: string; resource_id: string; version: number | string | bigint; kind: ResourceRelease["kind"]; schema_version: string;
  content_hash: string; author_id: string; created_at: number | string | bigint; state: ResourceRelease["state"]; payload_json: string;
};
type AssignmentRow = {
  id: string; resource_id: string; release_id: string; plane: TargetAssignment["scope"]["plane"]; target_kind: TargetAssignment["scope"]["target"]["kind"];
  tenant_id: string | null; runtime_class: string | null; runtime_id: string | null; device_id: string | null;
  priority: number | string | bigint; rollout_state: TargetAssignment["rolloutState"]; revision: number | string | bigint;
};

/** SQL adapter for the Admin-owned cp_* tables. It never queries or writes mr_* or Runtime tables. */
export class SqlControlPlaneStore implements ControlPlaneWritePort {
  private readonly database: SqlConnection;

  public constructor(database: SqlConnection) { this.database = database; }

  public async getRelease(releaseId: string): Promise<ResourceRelease | undefined> {
    const row = await this.database.prepare("SELECT id, resource_id, version, kind, schema_version, content_hash, author_id, created_at, state, payload_json FROM cp_releases WHERE id = ?").get<ReleaseRow>(releaseId);
    return row === undefined ? undefined : releaseFromRow(row);
  }

  public async listAssignments(resourceId: string): Promise<readonly TargetAssignment[]> {
    const rows = await this.database.prepare("SELECT id, resource_id, release_id, plane, target_kind, tenant_id, runtime_class, runtime_id, device_id, priority, rollout_state, revision FROM cp_target_assignments WHERE resource_id = ?").all<AssignmentRow>(resourceId);
    return rows.map(assignmentFromRow);
  }

  public async publishRelease(command: PublishReleaseCommand): Promise<ResourceRelease> {
    return await this.database.transaction(async () => {
      const resource = await this.lockResource(command.release.resourceId);
      const now = command.release.createdAt;
      if (resource === undefined) {
        if (command.expectedRevision !== 0) throw revisionConflict(command.release.resourceId, command.expectedRevision, 0);
        await this.database.prepare("INSERT INTO cp_resources(id, kind, owner_tenant_id, revision, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)")
          .run(command.release.resourceId, command.release.kind, 1, now, now);
      } else {
        const revision = asNumber(resource.revision);
        if (revision !== command.expectedRevision) throw revisionConflict(command.release.resourceId, command.expectedRevision, revision);
        if (resource.kind !== command.release.kind) throw new ControlPlaneError("invalid_contract", "A resource kind cannot change across releases");
        await this.database.prepare("UPDATE cp_resources SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
          .run(revision + 1, now, command.release.resourceId, revision);
      }
      const duplicate = await this.database.prepare("SELECT id FROM cp_releases WHERE id = ? OR (resource_id = ? AND version = ?)")
        .get<{ id: string }>(command.release.releaseId, command.release.resourceId, command.release.version);
      if (duplicate !== undefined) throw new ControlPlaneError("duplicate_release", `Release ${command.release.releaseId} or resource version already exists`);
      await this.database.prepare("INSERT INTO cp_releases(id, resource_id, version, kind, schema_version, content_hash, author_id, created_at, state, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(command.release.releaseId, command.release.resourceId, command.release.version, command.release.kind, command.release.schemaVersion,
          command.release.contentHash, command.release.authorId, command.release.createdAt, command.release.state, JSON.stringify(command.release.payload));
      await this.audit(command.auditEventId, command.actorId, "release.published", command.release.resourceId, command.release.releaseId, undefined, command.release.contentHash, now);
      return command.release;
    });
  }

  public async createTargetAssignment(command: CreateTargetAssignmentCommand): Promise<TargetAssignment> {
    const assignment = command.assignment;
    assertAssignmentShape(assignment);
    return await this.database.transaction(async () => {
      const resource = await this.lockResource(assignment.resourceId);
      if (resource === undefined) throw new ControlPlaneError("invalid_contract", `Unknown resource ${assignment.resourceId}`);
      const revision = asNumber(resource.revision);
      if (revision !== command.expectedRevision) throw revisionConflict(assignment.resourceId, command.expectedRevision, revision);
      const release = await this.getRelease(assignment.releaseId);
      if (release === undefined || release.resourceId !== assignment.resourceId) throw new ControlPlaneError("invalid_contract", "Assignment release must belong to its resource");
      if (release.state === "draft" || release.state === "retired") throw new ControlPlaneError("release_not_active", "Draft or retired releases cannot be assigned");
      const existing = await this.listAssignments(assignment.resourceId);
      assertNoAssignmentConflict(existing, assignment);
      const target = assignment.scope.target;
      const now = Date.now();
      await this.database.prepare("INSERT INTO cp_target_assignments(id, resource_id, release_id, plane, target_kind, tenant_id, runtime_class, runtime_id, device_id, priority, rollout_state, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(assignment.assignmentId, assignment.resourceId, assignment.releaseId, assignment.scope.plane, target.kind,
          target.kind === "platform" ? null : target.tenantId,
          target.kind === "runtime_class" ? target.runtimeClass : null,
          target.kind === "runtime_id" ? target.runtimeId : null,
          target.kind === "device_id" ? target.deviceId : null,
          assignment.priority, assignment.rolloutState, assignment.revision, now, now);
      await this.database.prepare("UPDATE cp_resources SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
        .run(revision + 1, now, assignment.resourceId, revision);
      await this.audit(command.auditEventId, command.actorId, "target-assignment.created", assignment.resourceId, assignment.releaseId, undefined, assignment.assignmentId, now);
      return assignment;
    });
  }

  public async transitionRelease(command: TransitionReleaseCommand): Promise<ResourceRelease> {
    return await this.database.transaction(async () => {
      const current = await this.getRelease(command.releaseId);
      if (current === undefined) throw new ControlPlaneError("invalid_contract", `Unknown release ${command.releaseId}`);
      const resource = await this.lockResource(current.resourceId);
      if (resource === undefined) throw new ControlPlaneError("invalid_contract", `Unknown resource ${current.resourceId}`);
      const revision = asNumber(resource.revision);
      if (revision !== command.expectedRevision) throw revisionConflict(current.resourceId, command.expectedRevision, revision);
      const next = transitionRelease(current, command.state);
      const now = Date.now();
      await this.database.prepare("UPDATE cp_releases SET state = ? WHERE id = ? AND content_hash = ?").run(next.state, next.releaseId, next.contentHash);
      await this.database.prepare("UPDATE cp_resources SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
        .run(revision + 1, now, current.resourceId, revision);
      await this.audit(command.auditEventId, command.actorId, "release.transitioned", current.resourceId, current.releaseId, current.state, next.state, now);
      return next;
    });
  }

  public async recordApplyReceipt(command: RecordApplyReceiptCommand): Promise<void> {
    const receipt = command.receipt;
    const release = await this.getRelease(receipt.releaseId);
    if (release === undefined || release.contentHash !== receipt.contentHash) {
      throw new ControlPlaneError("receipt_hash_mismatch", `Receipt ${receipt.receiptId} does not name the release content hash`);
    }
    if (release.state === "draft" || release.state === "retired") {
      throw new ControlPlaneError("release_not_active", "Draft or retired releases cannot be acknowledged by a receipt");
    }
    await this.database.transaction(async () => {
      await this.database.prepare("INSERT INTO cp_apply_receipts(id, target_plane, tenant_id, runtime_id, device_id, release_id, content_hash, status, reason_code, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(receipt.receiptId, receipt.target.plane, receipt.target.tenantId, receipt.target.runtimeId, receipt.target.deviceId ?? null,
          receipt.releaseId, receipt.contentHash, receipt.status, receipt.reasonCode ?? null, receipt.observedAt);
      await this.audit(command.auditEventId, command.actorId, "apply-receipt.recorded", release.resourceId, receipt.releaseId, undefined, receipt.status, receipt.observedAt);
    });
  }

  private async lockResource(resourceId: string): Promise<ResourceRow | undefined> {
    const suffix = this.database.dialect === "sqlite" ? "" : " FOR UPDATE";
    return await this.database.prepare(`SELECT id, kind, revision FROM cp_resources WHERE id = ?${suffix}`).get<ResourceRow>(resourceId);
  }

  private async audit(id: string, actorId: string, action: string, resourceId: string, releaseId: string | undefined, beforeRef: string | undefined, afterRef: string | undefined, createdAt: number): Promise<void> {
    await this.database.prepare("INSERT INTO cp_audit_events(id, actor_id, action, resource_id, release_id, before_ref, after_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, actorId, action, resourceId, releaseId ?? null, beforeRef ?? null, afterRef ?? null, createdAt);
  }
}

function releaseFromRow(row: ReleaseRow): ResourceRelease {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  if (payload === null || Array.isArray(payload)) throw new ControlPlaneError("invalid_contract", `Release ${row.id} has invalid persisted payload`);
  return {
    contractVersion: "control-plane/v1", resourceId: row.resource_id, releaseId: row.id, version: asNumber(row.version), kind: row.kind,
    schemaVersion: row.schema_version, contentHash: row.content_hash, authorId: row.author_id, createdAt: asNumber(row.created_at), state: row.state, payload,
  };
}

function assignmentFromRow(row: AssignmentRow): TargetAssignment {
  const target = row.target_kind === "platform" ? { kind: "platform" as const }
    : row.target_kind === "tenant" ? { kind: "tenant" as const, tenantId: required(row.tenant_id) }
      : row.target_kind === "runtime_class" ? { kind: "runtime_class" as const, tenantId: required(row.tenant_id), runtimeClass: required(row.runtime_class) }
        : row.target_kind === "runtime_id" ? { kind: "runtime_id" as const, tenantId: required(row.tenant_id), runtimeId: required(row.runtime_id) }
          : { kind: "device_id" as const, tenantId: required(row.tenant_id), deviceId: required(row.device_id) };
  return {
    contractVersion: "control-plane/v1", assignmentId: row.id, resourceId: row.resource_id, releaseId: row.release_id,
    scope: { plane: row.plane, target }, priority: asNumber(row.priority), rolloutState: row.rollout_state, revision: asNumber(row.revision),
  };
}

function required(value: string | null): string {
  if (value === null || value.length === 0) throw new ControlPlaneError("invalid_contract", "Persisted assignment has an incomplete scope");
  return value;
}

function asNumber(value: number | string | bigint): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ControlPlaneError("invalid_contract", "Persisted control-plane revision is not a safe integer");
  return parsed;
}

function revisionConflict(resourceId: string, expected: number, actual: number): ControlPlaneError {
  return new ControlPlaneError("revision_conflict", `Resource ${resourceId} expected revision ${expected}, found ${actual}`);
}
