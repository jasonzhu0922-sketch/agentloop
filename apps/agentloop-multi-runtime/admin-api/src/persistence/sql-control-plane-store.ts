import type { SqlConnection } from "@zhujun/agentloop";
import type {
  AdminMember, ApplyReceipt, AuditEvent, ControlPlaneResource, CreateTargetAssignmentCommand, PublishReleaseCommand, RecordApplyReceiptCommand, RecordSkillInstallReceiptCommand,
  ResourceRelease, TargetAssignment, TransitionReleaseCommand,
} from "../../../control-plane/contracts/index.ts";
import { assertAssignmentShape, assertNoAssignmentConflict, ControlPlaneError, transitionRelease } from "../../../control-plane/domain/index.ts";
import type { ConfigurationSnapshotRepositoryPort, ControlPlaneWritePort, SkillArtifactMetadata } from "../../../control-plane/domain/ports.ts";
import type { AdminAuditPort, AdminCatalogPort, AdminIdentityPort } from "../application/admin-ports.ts";

type ResourceRow = { id: string; kind: ResourceRelease["kind"]; revision: number | string | bigint };
type ReleaseRow = {
  id: string; resource_id: string; version: number | string | bigint; kind: ResourceRelease["kind"]; schema_version: string;
  content_hash: string; author_id: string; created_at: number | string | bigint; state: ResourceRelease["state"]; payload_json: string;
};
type AssignmentRow = {
  id: string; resource_id: string; release_id: string; plane: TargetAssignment["scope"]["plane"]; target_kind: TargetAssignment["scope"]["target"]["kind"];
  scope_id: string | null; runtime_class: string | null; runtime_id: string | null; device_id: string | null;
  priority: number | string | bigint; rollout_state: TargetAssignment["rolloutState"]; revision: number | string | bigint;
};
type MemberRow = { id: string; scope_id: string; subject: string; display_name: string; role: AdminMember["role"]; status: AdminMember["status"]; revision: number | string | bigint; created_at: number | string | bigint; updated_at: number | string | bigint };
type AuditEventRow = { id: string; actor_id: string; action: string; resource_id: string; release_id: string | null; before_ref: string | null; after_ref: string | null; created_at: number | string | bigint };

/** SQL adapter for the Admin-owned cp_* tables. It never queries or writes mr_* or Runtime tables. */
export class SqlControlPlaneStore implements ControlPlaneWritePort, ConfigurationSnapshotRepositoryPort, AdminIdentityPort, AdminAuditPort, AdminCatalogPort {
  private readonly database: SqlConnection;

  public constructor(database: SqlConnection) { this.database = database; }

  public async getRelease(releaseId: string): Promise<ResourceRelease | undefined> {
    const row = await this.database.prepare("SELECT id, resource_id, version, kind, schema_version, content_hash, author_id, created_at, state, payload_json FROM cp_releases WHERE id = ?").get<ReleaseRow>(releaseId);
    return row === undefined ? undefined : releaseFromRow(row);
  }

  public async listAssignments(resourceId: string): Promise<readonly TargetAssignment[]> {
    const rows = await this.database.prepare("SELECT id, resource_id, release_id, plane, target_kind, scope_id, runtime_class, runtime_id, device_id, priority, rollout_state, revision FROM cp_target_assignments WHERE resource_id = ?").all<AssignmentRow>(resourceId);
    return rows.map(assignmentFromRow);
  }

  public async listResources(): Promise<readonly ControlPlaneResource[]> {
    const rows = await this.database.prepare("SELECT id, kind, revision FROM cp_resources ORDER BY id").all<ResourceRow>();
    return rows.map((row) => ({ resourceId: row.id, kind: row.kind, revision: asNumber(row.revision) }));
  }

  public async configurationRevision(): Promise<number> {
    const row = await this.database.prepare("SELECT revision FROM cp_configuration_revision_sequence WHERE id = 1").get<{ revision: number | string | bigint }>();
    if (row === undefined) throw new ControlPlaneError("migration_not_ready", "Control-plane configuration revision sequence is unavailable");
    return asNumber(row.revision);
  }

  public async skillPackageHash(releaseId: string): Promise<string | undefined> {
    const row = await this.database.prepare("SELECT package_hash FROM cp_skill_artifacts WHERE release_id = ?").get<{ package_hash: string }>(releaseId);
    return row?.package_hash;
  }

  public async skillArtifact(releaseId: string): Promise<SkillArtifactMetadata | undefined> {
    const row = await this.database.prepare("SELECT release_id, package_uri, package_hash, signer, compatibility_json FROM cp_skill_artifacts WHERE release_id = ?").get<{
      release_id: string; package_uri: string; package_hash: string; signer: string; compatibility_json: string;
    }>(releaseId);
    if (row === undefined) return undefined;
    let compatibility: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.compatibility_json) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) compatibility = parsed as Record<string, unknown>;
    } catch { throw new ControlPlaneError("invalid_contract", `Skill artifact ${releaseId} has invalid compatibility metadata`); }
    const signature = compatibility.signature;
    const signatureAlgorithm = compatibility.signatureAlgorithm;
    if (typeof signature !== "string" || signature.trim() === "" || (signatureAlgorithm !== "ed25519" && signatureAlgorithm !== "minisign")) {
      throw new ControlPlaneError("configuration_unavailable", `Skill artifact ${releaseId} has no supported signature metadata`);
    }
    const { signature: _signature, signatureAlgorithm: _signatureAlgorithm, ...rest } = compatibility;
    return { releaseId: row.release_id, packageUri: row.package_uri, packageHash: row.package_hash, signer: row.signer, signature, signatureAlgorithm, ...(Object.keys(rest).length === 0 ? {} : { compatibility: rest }) };
  }

  public async publishRelease(command: PublishReleaseCommand): Promise<ResourceRelease> {
    return await this.database.transaction(async () => {
      const resource = await this.lockResource(command.release.resourceId);
      const now = command.release.createdAt;
      if (resource === undefined) {
        if (command.expectedRevision !== 0) throw revisionConflict(command.release.resourceId, command.expectedRevision, 0);
        await this.database.prepare("INSERT INTO cp_resources(id, kind, owner_scope_id, revision, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)")
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
      await this.database.prepare("INSERT INTO cp_target_assignments(id, resource_id, release_id, plane, target_kind, scope_id, runtime_class, runtime_id, device_id, priority, rollout_state, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(assignment.assignmentId, assignment.resourceId, assignment.releaseId, assignment.scope.plane, target.kind,
          target.kind === "platform" ? null : target.scopeId,
          target.kind === "runtime_class" ? target.runtimeClass : null,
          target.kind === "runtime_id" ? target.runtimeId : null,
          target.kind === "device_id" ? target.deviceId : null,
          assignment.priority, assignment.rolloutState, assignment.revision, now, now);
      await this.database.prepare("UPDATE cp_resources SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
        .run(revision + 1, now, assignment.resourceId, revision);
      await this.audit(command.auditEventId, command.actorId, "target-assignment.created", assignment.resourceId, assignment.releaseId, undefined, assignment.assignmentId, now);
      if (assignment.rolloutState === "active" && release.state === "active") await this.advanceConfigurationRevision();
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
      if (current.state === "active" || next.state === "active") await this.advanceConfigurationRevision();
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
      await this.database.prepare("INSERT INTO cp_apply_receipts(id, target_plane, scope_id, runtime_id, device_id, release_id, content_hash, status, reason_code, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(receipt.receiptId, receipt.target.plane, receipt.target.scopeId, receipt.target.runtimeId, receipt.target.deviceId ?? null,
          receipt.releaseId, receipt.contentHash, receipt.status, receipt.reasonCode ?? null, receipt.observedAt);
      await this.audit(command.auditEventId, command.actorId, "apply-receipt.recorded", release.resourceId, receipt.releaseId, undefined, receipt.status, receipt.observedAt);
    });
  }

  public async recordSkillInstallReceipt(command: RecordSkillInstallReceiptCommand): Promise<void> {
    const receipt = command.receipt;
    const release = await this.getRelease(receipt.releaseId);
    if (release === undefined || release.kind !== "skill") throw new ControlPlaneError("skill_artifact_not_found", "Skill install receipt names an unknown Skill release");
    if (release.state === "draft" || release.state === "retired") throw new ControlPlaneError("release_not_active", "Draft or retired Skill releases cannot be acknowledged");
    const artifact = await this.skillArtifact(receipt.releaseId);
    if (artifact === undefined) throw new ControlPlaneError("skill_artifact_not_found", "Skill release has no registered artifact");
    if (artifact.packageHash !== receipt.packageHash || artifact.signer !== receipt.signer) throw new ControlPlaneError("skill_artifact_hash_mismatch", "Skill install receipt does not match the registered artifact");
    await this.database.transaction(async () => {
      await this.database.prepare("INSERT INTO cp_skill_install_receipts(id, target_plane, scope_id, runtime_id, device_id, release_id, package_hash, signer, status, reason_code, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(receipt.receiptId, receipt.target.plane, receipt.target.scopeId, receipt.target.runtimeId, receipt.target.deviceId ?? null,
          receipt.releaseId, receipt.packageHash, receipt.signer, receipt.status, receipt.reasonCode ?? null, receipt.observedAt);
      await this.audit(command.auditEventId, command.actorId, "skill-install-receipt.recorded", release.resourceId, receipt.releaseId, undefined, receipt.status, receipt.observedAt);
    });
  }

  public async listMembers(scopeId: string): Promise<readonly AdminMember[]> {
    const rows = await this.database.prepare("SELECT id, scope_id, subject, display_name, role, status, revision, created_at, updated_at FROM cp_members WHERE scope_id = ? ORDER BY id").all<MemberRow>(scopeId);
    return rows.map(memberFromRow);
  }

  public async createMember(member: AdminMember, expectedRevision: number, actorId: string, auditEventId: string): Promise<AdminMember> {
    if (expectedRevision !== 0 || member.revision !== 1) throw new ControlPlaneError("revision_conflict", "New members require revision zero and start at revision one");
    await this.database.transaction(async () => {
      const existing = await this.database.prepare("SELECT id FROM cp_members WHERE id = ?").get<{ id: string }>(member.memberId);
      if (existing !== undefined) throw new ControlPlaneError("duplicate_release", `Member ${member.memberId} already exists`);
      await this.database.prepare("INSERT INTO cp_members(id, scope_id, subject, display_name, role, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(member.memberId, member.scopeId, member.subject, member.displayName, member.role, member.status, member.revision, member.createdAt, member.updatedAt);
      await this.audit(auditEventId, actorId, "member.created", member.scopeId, undefined, undefined, member.memberId, member.createdAt);
    });
    return member;
  }

  public async transitionMember(memberId: string, status: AdminMember["status"], expectedRevision: number, actorId: string, auditEventId: string): Promise<AdminMember> {
    const current = await this.database.prepare("SELECT id, scope_id, subject, display_name, role, status, revision, created_at, updated_at FROM cp_members WHERE id = ?").get<MemberRow>(memberId);
    if (current === undefined) throw new ControlPlaneError("invalid_contract", `Unknown member ${memberId}`);
    if (asNumber(current.revision) !== expectedRevision) throw revisionConflict(memberId, expectedRevision, asNumber(current.revision));
    if (!memberStatusTransition(current.status, status)) throw new ControlPlaneError("invalid_release_transition", `Cannot transition member ${memberId} from ${current.status} to ${status}`);
    const now = Date.now();
    const next = { ...memberFromRow(current), status, revision: expectedRevision + 1, updatedAt: now } satisfies AdminMember;
    await this.database.transaction(async () => {
      await this.database.prepare("UPDATE cp_members SET status = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
        .run(status, next.revision, now, memberId, expectedRevision);
      await this.audit(auditEventId, actorId, "member.transitioned", next.scopeId, undefined, current.status, status, now);
    });
    return next;
  }

  public async listAuditEvents(limit: number): Promise<readonly AuditEvent[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const rows = await this.database.prepare("SELECT id, actor_id, action, resource_id, release_id, before_ref, after_ref, created_at FROM cp_audit_events ORDER BY created_at DESC, id DESC LIMIT ?").all<AuditEventRow>(bounded);
    return rows.map((row) => ({ eventId: row.id, actorId: row.actor_id, action: row.action, resourceId: row.resource_id, ...(row.release_id === null ? {} : { releaseId: row.release_id }), ...(row.before_ref === null ? {} : { beforeRef: row.before_ref }), ...(row.after_ref === null ? {} : { afterRef: row.after_ref }), createdAt: asNumber(row.created_at) }));
  }

  public async listReleases(kind?: ResourceRelease["kind"]): Promise<readonly ResourceRelease[]> {
    const rows = kind === undefined
      ? await this.database.prepare("SELECT id, resource_id, version, kind, schema_version, content_hash, author_id, created_at, state, payload_json FROM cp_releases ORDER BY created_at DESC, id DESC").all<ReleaseRow>()
      : await this.database.prepare("SELECT id, resource_id, version, kind, schema_version, content_hash, author_id, created_at, state, payload_json FROM cp_releases WHERE kind = ? ORDER BY created_at DESC, id DESC").all<ReleaseRow>(kind);
    return rows.map(releaseFromRow);
  }

  private async lockResource(resourceId: string): Promise<ResourceRow | undefined> {
    const suffix = this.database.dialect === "sqlite" ? "" : " FOR UPDATE";
    return await this.database.prepare(`SELECT id, kind, revision FROM cp_resources WHERE id = ?${suffix}`).get<ResourceRow>(resourceId);
  }

  private async advanceConfigurationRevision(): Promise<void> {
    const suffix = this.database.dialect === "sqlite" ? "" : " FOR UPDATE";
    const row = await this.database.prepare(`SELECT revision FROM cp_configuration_revision_sequence WHERE id = 1${suffix}`).get<{ revision: number | string | bigint }>();
    if (row === undefined) throw new ControlPlaneError("migration_not_ready", "Control-plane configuration revision sequence is unavailable");
    const revision = asNumber(row.revision);
    await this.database.prepare("UPDATE cp_configuration_revision_sequence SET revision = ? WHERE id = 1 AND revision = ?").run(revision + 1, revision);
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

function memberFromRow(row: MemberRow): AdminMember {
  return { contractVersion: "control-plane/v1", memberId: row.id, scopeId: row.scope_id, subject: row.subject, displayName: row.display_name, role: row.role, status: row.status, revision: asNumber(row.revision), createdAt: asNumber(row.created_at), updatedAt: asNumber(row.updated_at) };
}

function memberStatusTransition(from: AdminMember["status"], to: AdminMember["status"]): boolean {
  if (from === to) return false;
  return from === "invited" ? to === "active" || to === "removed"
    : from === "active" ? to === "suspended" || to === "removed"
      : from === "suspended" ? to === "active" || to === "removed" : false;
}

function assignmentFromRow(row: AssignmentRow): TargetAssignment {
  const target = row.target_kind === "platform" ? { kind: "platform" as const }
    : row.target_kind === "tenant" ? { kind: "tenant" as const, scopeId: required(row.scope_id) }
      : row.target_kind === "runtime_class" ? { kind: "runtime_class" as const, scopeId: required(row.scope_id), runtimeClass: required(row.runtime_class) }
        : row.target_kind === "runtime_id" ? { kind: "runtime_id" as const, scopeId: required(row.scope_id), runtimeId: required(row.runtime_id) }
          : { kind: "device_id" as const, scopeId: required(row.scope_id), deviceId: required(row.device_id) };
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
