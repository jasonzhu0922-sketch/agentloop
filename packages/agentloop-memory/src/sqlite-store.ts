import { createHash, randomUUID } from "node:crypto";
import type { MemoryProjection } from "@zhujun/agentloop";
import type { SqlConnection } from "@zhujun/agentloop";
import { evaluateCandidate, validateRevision } from "./policy.ts";
import type {
  MemoryCandidate,
  MemoryItem,
  MemoryRevision,
  MemorySettlementJob,
  MemorySettlementJobStatus,
  MemoryScope,
  MemoryStore,
  SettlementAttempt,
} from "./types.ts";

function idHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function json<T>(value: T): string {
  return JSON.stringify(value);
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

/**
 * Durable local-only Memory store. The caller owns the SQLite connection;
 * this class never opens a cloud connection and never closes a shared Agent
 * Loop database.
 */
export class SqliteMemoryStore implements MemoryStore {
  private readonly connection: SqlConnection;
  private readonly migrated: Promise<void>;

  constructor(connection: SqlConnection) {
    if (connection.dialect !== "sqlite") throw new TypeError("SqliteMemoryStore requires a local sqlite connection");
    this.connection = connection;
    this.migrated = this.migrate();
  }

  ready(): Promise<void> {
    return this.migrated;
  }

  async settlementJobs(scope: MemoryScope, runId: string): Promise<readonly MemorySettlementJob[]> {
    await this.migrated;
    const rows = await this.connection.prepare(`SELECT * FROM local_memory_settlement_jobs
      WHERE tenant_id = ? AND owner_user_id = ? AND run_id = ? ORDER BY enqueued_at ASC`)
      .all<LocalMemorySettlementRow>(scope.tenantId, scope.ownerUserId, runId);
    return rows.map(settlementRowToJob);
  }

  async recordSettlementAttempt(job: MemorySettlementJob, attempt: SettlementAttempt): Promise<void> {
    await this.migrated;
    await this.connection.prepare(`INSERT INTO local_memory_settlement_attempts
      (id, tenant_id, owner_user_id, run_id, settlement_job_id, attempt_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), job.tenantId, job.ownerUserId, job.runId, job.settlementJobId, json(attempt), Date.now());
  }

  async settlementAttempts(scope: MemoryScope, runId: string): Promise<readonly SettlementAttempt[]> {
    await this.migrated;
    const rows = await this.connection.prepare(`SELECT attempt_json FROM local_memory_settlement_attempts
      WHERE tenant_id = ? AND owner_user_id = ? AND run_id = ? ORDER BY rowid`)
      .all<{ attempt_json: string }>(scope.tenantId, scope.ownerUserId, runId);
    return rows.map((row) => parse<SettlementAttempt>(row.attempt_json));
  }

  async replaySettlement(scope: MemoryScope, runId: string, now: number): Promise<void> {
    await this.migrated;
    await this.connection.transaction(async () => {
      const processing = await this.connection.prepare(`SELECT 1 FROM local_memory_settlement_jobs
        WHERE tenant_id = ? AND owner_user_id = ? AND run_id = ? AND status = 'processing'`)
        .get(scope.tenantId, scope.ownerUserId, runId);
      if (processing !== undefined) throw new Error("settlement_job_processing");
      await this.connection.prepare(`UPDATE local_memory_settlement_jobs
        SET status = 'queued', attempts = 0, last_error = NULL, next_attempt_at = ?
        WHERE tenant_id = ? AND owner_user_id = ? AND run_id = ?`)
        .run(now, scope.tenantId, scope.ownerUserId, runId);
    });
  }

  async currentEpoch(scope: MemoryScope): Promise<number> {
    await this.migrated;
    const row = await this.connection.prepare(`
      SELECT epoch FROM local_memory_epochs WHERE tenant_id = ? AND owner_user_id = ?
    `).get<{ epoch: number }>(scope.tenantId, scope.ownerUserId);
    return row === undefined ? 0 : Number(row.epoch);
  }

  async active(scope: MemoryScope): Promise<readonly { readonly item: MemoryItem; readonly revision: MemoryRevision }[]> {
    await this.migrated;
    const rows = await this.connection.prepare(`
      SELECT
        i.id AS item_id, i.tenant_id AS item_tenant_id, i.owner_user_id AS item_owner_user_id,
        i.kind AS item_kind, i.subtype AS item_subtype, i.canonical_key AS item_canonical_key,
        i.status AS item_status, i.current_revision_id AS item_current_revision_id,
        i.created_at AS item_created_at, i.updated_at AS item_updated_at,
        r.id AS revision_id, r.memory_id AS revision_memory_id, r.revision AS revision_number,
        r.authority AS revision_authority, r.sensitivity AS revision_sensitivity,
        r.temporal_class AS revision_temporal_class, r.preference_effect AS revision_preference_effect,
        r.experience_maturity AS revision_experience_maturity, r.activation_json AS revision_activation_json,
        r.targets_json AS revision_targets_json, r.value_json AS revision_value_json,
        r.content_markdown AS revision_content_markdown, r.applicability_json AS revision_applicability_json,
        r.confidence AS revision_confidence, r.valid_from AS revision_valid_from,
        r.expires_at AS revision_expires_at, r.supersedes_revision_id AS revision_supersedes_revision_id,
        r.source_refs_json AS revision_source_refs_json, r.change_reason AS revision_change_reason,
        r.created_at AS revision_created_at
      FROM local_memory_items i
      JOIN local_memory_revisions r ON r.id = i.current_revision_id
      WHERE i.tenant_id = ? AND i.owner_user_id = ? AND i.status = 'active'
      ORDER BY i.updated_at DESC
    `).all<LocalMemoryJoinRow>(scope.tenantId, scope.ownerUserId);
    return rows.map(joinRowToEntry);
  }

  async commit(scope: MemoryScope, candidate: MemoryCandidate, now: number): Promise<{
    readonly item: MemoryItem;
    readonly revision: MemoryRevision;
    readonly memoryEpoch: number;
  }> {
    await this.migrated;
    const policy = evaluateCandidate(candidate);
    if (policy.kind !== "accept") throw new Error(`candidate_policy:${policy.reason}`);
    if (candidate.tenantId !== scope.tenantId || candidate.ownerUserId !== scope.ownerUserId) throw new Error("memory_scope_mismatch");
    return this.connection.transaction(async () => {
      const existing = await this.connection.prepare(`
        SELECT * FROM local_memory_items
        WHERE tenant_id = ? AND owner_user_id = ? AND kind = ? AND subtype = ?
          AND ((canonical_key = ?) OR (canonical_key IS NULL AND ? IS NULL))
          AND status = 'active'
        LIMIT 1
      `).get<LocalMemoryItemRow>(
        scope.tenantId,
        scope.ownerUserId,
        candidate.proposedKind,
        candidate.proposedSubtype,
        candidate.proposedCanonicalKey ?? null,
        candidate.proposedCanonicalKey ?? null,
      );
      if (candidate.expectedCurrentRevisionId !== undefined && existing?.current_revision_id !== candidate.expectedCurrentRevisionId) throw new Error("task_group_revision_conflict");
      const memoryId = existing?.id ?? `mem_${idHash({ scope, candidate: candidate.id }).slice(0, 24)}`;
      const previous = existing === undefined ? undefined : await this.connection.prepare(`
        SELECT * FROM local_memory_revisions WHERE id = ?
      `).get<LocalMemoryRevisionRow>(existing.current_revision_id);
      const revisionNumber = previous === undefined ? 1 : Number(previous.revision) + 1;
      const revision: MemoryRevision = {
        schema: "agentloop.userMemoryRevision/v1",
        id: `memrev_${idHash({ memoryId, revisionNumber, candidate: candidate.id }).slice(0, 24)}`,
        memoryId,
        revision: revisionNumber,
        authority: candidate.authority,
        sensitivity: candidate.sensitivity as Exclude<typeof candidate.sensitivity, "secret">,
        temporalClass: candidate.activation.mode === "explicit_only" ? "ephemeral" : "stable",
        ...(candidate.proposedPreferenceEffect === undefined ? {} : { preferenceEffect: candidate.proposedPreferenceEffect }),
        ...(candidate.proposedExperienceMaturity === undefined ? {} : { experienceMaturity: candidate.proposedExperienceMaturity }),
        activation: candidate.activation,
        applicationTargets: [...candidate.applicationTargets],
        value: { ...candidate.proposedValue },
        contentMarkdown: candidate.proposedContentMarkdown,
        applicability: candidate.proposedValue.settlementPattern !== null
          && typeof candidate.proposedValue.settlementPattern === "object"
          && !Array.isArray(candidate.proposedValue.settlementPattern)
          && (candidate.proposedValue.settlementPattern as { applicability?: unknown }).applicability !== null
          && typeof (candidate.proposedValue.settlementPattern as { applicability?: unknown }).applicability === "object"
          ? (candidate.proposedValue.settlementPattern as { applicability: MemoryRevision["applicability"] }).applicability
          : { conditions: [], exclusions: [] },
        confidence: candidate.confidence,
        validFrom: now,
        ...(previous === undefined ? {} : { supersedesRevisionId: previous.id }),
        sourceRefs: [...candidate.sourceRefs],
        changeReason: candidate.reason,
        createdAt: now,
      };
      if (candidate.sensitivity === "secret") throw new Error("secret_data_is_never_persisted");
      validateRevision(revision, candidate.proposedKind);
      await this.connection.prepare(`
        INSERT INTO local_memory_revisions (
          id, memory_id, revision, authority, sensitivity, temporal_class,
          preference_effect, experience_maturity, activation_json, targets_json,
          value_json, content_markdown, applicability_json, confidence,
          valid_from, expires_at, supersedes_revision_id, source_refs_json,
          change_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revision.id, revision.memoryId, revision.revision, revision.authority, revision.sensitivity,
        revision.temporalClass, revision.preferenceEffect ?? null, revision.experienceMaturity ?? null,
        json(revision.activation), json(revision.applicationTargets), json(revision.value),
        revision.contentMarkdown, json(revision.applicability), revision.confidence, revision.validFrom,
        revision.expiresAt ?? null, revision.supersedesRevisionId ?? null, json(revision.sourceRefs),
        revision.changeReason, revision.createdAt,
      );
      const item: MemoryItem = existing === undefined
        ? {
            schema: "agentloop.userMemory/v1", id: memoryId, tenantId: scope.tenantId, ownerUserId: scope.ownerUserId,
            kind: candidate.proposedKind, subtype: candidate.proposedSubtype,
            ...(candidate.proposedCanonicalKey === undefined ? {} : { canonicalKey: candidate.proposedCanonicalKey }),
            status: "active", currentRevisionId: revision.id, createdAt: now, updatedAt: now,
          }
        : { ...rowToItem(existing), currentRevisionId: revision.id, updatedAt: now, status: "active" };
      if (existing === undefined) {
        await this.connection.prepare(`
          INSERT INTO local_memory_items (id, tenant_id, owner_user_id, kind, subtype, canonical_key, status, current_revision_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `).run(item.id, item.tenantId, item.ownerUserId, item.kind, item.subtype, item.canonicalKey ?? null, item.currentRevisionId, item.createdAt, item.updatedAt);
      } else {
        await this.connection.prepare(`UPDATE local_memory_items SET current_revision_id = ?, updated_at = ? WHERE id = ?`).run(item.currentRevisionId, item.updatedAt, item.id);
      }
      const nextEpoch = (await this.currentEpoch(scope)) + 1;
      await this.connection.prepare(`
        INSERT INTO local_memory_epochs (tenant_id, owner_user_id, epoch) VALUES (?, ?, ?)
        ON CONFLICT(tenant_id, owner_user_id) DO UPDATE SET epoch = excluded.epoch
      `).run(scope.tenantId, scope.ownerUserId, nextEpoch);
      return { item, revision, memoryEpoch: nextEpoch };
    });
  }

  async recordProjection(scope: MemoryScope, projection: MemoryProjection): Promise<void> {
    await this.migrated;
    await this.connection.prepare(`
      INSERT OR REPLACE INTO local_memory_projections
        (id, tenant_id, owner_user_id, run_id, target, memory_epoch, projection_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(projection.id, scope.tenantId, scope.ownerUserId, projection.runId, projection.target, projection.memoryEpoch, json(projection), projection.createdAt);
  }

  async projections(scope: MemoryScope, runId: string): Promise<readonly MemoryProjection[]> {
    await this.migrated;
    const rows = await this.connection.prepare(`
      SELECT projection_json FROM local_memory_projections
      WHERE tenant_id = ? AND owner_user_id = ? AND run_id = ? ORDER BY created_at ASC
    `).all<{ projection_json: string }>(scope.tenantId, scope.ownerUserId, runId);
    return rows.map((row) => parse<MemoryProjection>(row.projection_json));
  }

  async enqueueSettlement(input: { readonly scope: MemoryScope; readonly runId: string; readonly terminalCommitRef: string; readonly now: number }): Promise<{
    readonly kind: "enqueued" | "duplicate";
    readonly settlementJobId: string;
    readonly enqueuedAt: number;
  }> {
    await this.migrated;
    const existing = await this.connection.prepare(`
      SELECT settlement_job_id, enqueued_at FROM local_memory_settlement_jobs
      WHERE tenant_id = ? AND owner_user_id = ? AND run_id = ? AND terminal_commit_ref = ?
    `).get<LocalMemorySettlementRow>(input.scope.tenantId, input.scope.ownerUserId, input.runId, input.terminalCommitRef);
    if (existing !== undefined) return { kind: "duplicate", settlementJobId: existing.settlement_job_id, enqueuedAt: Number(existing.enqueued_at) };
    const settlementJobId = `memjob_${idHash({ scope: input.scope, runId: input.runId, terminalCommitRef: input.terminalCommitRef }).slice(0, 24)}`;
    await this.connection.prepare(`
      INSERT INTO local_memory_settlement_jobs
        (tenant_id, owner_user_id, run_id, terminal_commit_ref, settlement_job_id, enqueued_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.scope.tenantId, input.scope.ownerUserId, input.runId, input.terminalCommitRef, settlementJobId, input.now);
    return { kind: "enqueued", settlementJobId, enqueuedAt: input.now };
  }

  async claimSettlement(input: { readonly now: number; readonly maxAttempts: number; readonly allowedRunIds?: readonly string[]; readonly allowedSettlementJobIds?: readonly string[] }): Promise<MemorySettlementJob | undefined> {
    await this.migrated;
    return this.connection.transaction(async () => {
      const runFilter = input.allowedRunIds === undefined ? "" : ` AND run_id IN (${input.allowedRunIds.map(() => "?").join(",") || "NULL"})`;
      const jobFilter = input.allowedSettlementJobIds === undefined ? "" : ` AND settlement_job_id IN (${input.allowedSettlementJobIds.map(() => "?").join(",") || "NULL"})`;
      const row = await this.connection.prepare(`
        SELECT * FROM local_memory_settlement_jobs
        WHERE status IN ('queued', 'failed') AND next_attempt_at <= ?${runFilter}${jobFilter}
        ORDER BY enqueued_at ASC LIMIT 1
      `).get<LocalMemorySettlementRow>(input.now, ...(input.allowedRunIds ?? []), ...(input.allowedSettlementJobIds ?? []));
      if (row === undefined) return undefined;
      if (Number(row.attempts) >= input.maxAttempts) {
        await this.connection.prepare(`
          UPDATE local_memory_settlement_jobs SET status = 'dead_letter'
          WHERE tenant_id = ? AND owner_user_id = ? AND run_id = ? AND terminal_commit_ref = ?
        `).run(row.tenant_id, row.owner_user_id, row.run_id, row.terminal_commit_ref);
        return undefined;
      }
      const attempts = Number(row.attempts) + 1;
      await this.connection.prepare(`
        UPDATE local_memory_settlement_jobs SET status = 'processing', attempts = ?
        WHERE tenant_id = ? AND owner_user_id = ? AND run_id = ? AND terminal_commit_ref = ?
      `).run(attempts, row.tenant_id, row.owner_user_id, row.run_id, row.terminal_commit_ref);
      return settlementRowToJob({ ...row, status: "processing", attempts });
    });
  }

  async settlementBatchCandidates(input: { readonly minimum: number; readonly maxAttempts: number }): Promise<readonly { readonly scope: MemoryScope; readonly count: number }[]> {
    await this.migrated;
    const rows = await this.connection.prepare(`
      SELECT tenant_id, owner_user_id, COUNT(*) AS count
      FROM local_memory_settlement_jobs
      WHERE status IN ('queued', 'failed') AND attempts < ?
      GROUP BY tenant_id, owner_user_id
      HAVING COUNT(*) >= ?
      ORDER BY count DESC
    `).all<{ tenant_id: string; owner_user_id: string; count: number }>(input.maxAttempts, input.minimum);
    return rows.map((row) => ({ scope: { tenantId: row.tenant_id, ownerUserId: row.owner_user_id }, count: Number(row.count) }));
  }

  async claimSettlementBatch(input: { readonly scope: MemoryScope; readonly now: number; readonly maxAttempts: number; readonly limit: number; readonly allowedRunIds?: readonly string[]; readonly allowedSettlementJobIds?: readonly string[] }): Promise<readonly MemorySettlementJob[]> {
    await this.migrated;
    return this.connection.transaction(async () => {
      const runFilter = input.allowedRunIds === undefined ? "" : ` AND run_id IN (${input.allowedRunIds.map(() => "?").join(",") || "NULL"})`;
      const jobFilter = input.allowedSettlementJobIds === undefined ? "" : ` AND settlement_job_id IN (${input.allowedSettlementJobIds.map(() => "?").join(",") || "NULL"})`;
      const rows = await this.connection.prepare(`
        SELECT * FROM local_memory_settlement_jobs
        WHERE tenant_id = ? AND owner_user_id = ? AND status IN ('queued', 'failed') AND next_attempt_at <= ?${runFilter}${jobFilter}
        ORDER BY enqueued_at ASC LIMIT ?
      `).all<LocalMemorySettlementRow>(input.scope.tenantId, input.scope.ownerUserId, input.now, ...(input.allowedRunIds ?? []), ...(input.allowedSettlementJobIds ?? []), Math.max(0, input.limit));
      const claimed: MemorySettlementJob[] = [];
      for (const row of rows) {
        if (Number(row.attempts) >= input.maxAttempts) {
          await this.connection.prepare(`UPDATE local_memory_settlement_jobs SET status = 'dead_letter' WHERE tenant_id = ? AND owner_user_id = ? AND run_id = ? AND terminal_commit_ref = ?`).run(row.tenant_id, row.owner_user_id, row.run_id, row.terminal_commit_ref);
          continue;
        }
        const attempts = Number(row.attempts) + 1;
        await this.connection.prepare(`UPDATE local_memory_settlement_jobs SET status = 'processing', attempts = ? WHERE tenant_id = ? AND owner_user_id = ? AND run_id = ? AND terminal_commit_ref = ?`).run(attempts, row.tenant_id, row.owner_user_id, row.run_id, row.terminal_commit_ref);
        claimed.push(settlementRowToJob({ ...row, status: "processing", attempts }));
      }
      return claimed;
    });
  }

  async finishSettlement(input: {
    readonly job: MemorySettlementJob;
    readonly now: number;
    readonly maxAttempts: number;
    readonly outcome: "succeeded" | "failed";
    readonly error?: string;
  }): Promise<MemorySettlementJob> {
    await this.migrated;
    const status: MemorySettlementJobStatus = input.outcome === "succeeded"
      ? "succeeded"
      : input.job.attempts >= input.maxAttempts ? "dead_letter" : "failed";
    const nextAttemptAt = status === "failed"
      ? input.now + Math.min(60_000, 1_000 * (2 ** Math.max(0, input.job.attempts - 1)))
      : input.now;
    await this.connection.prepare(`
      UPDATE local_memory_settlement_jobs
      SET status = ?, last_error = ?, next_attempt_at = ?
      WHERE tenant_id = ? AND owner_user_id = ? AND run_id = ? AND terminal_commit_ref = ?
        AND status = 'processing'
    `).run(
      status,
      input.error ?? null,
      nextAttemptAt,
      input.job.tenantId,
      input.job.ownerUserId,
      input.job.runId,
      input.job.terminalCommitRef,
    );
    return {
      ...input.job,
      status,
      nextAttemptAt,
      ...(input.error === undefined ? {} : { lastError: input.error }),
    };
  }

  private async migrate(): Promise<void> {
    await this.connection.exec(`
      CREATE TABLE IF NOT EXISTS local_memory_items (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
        kind TEXT NOT NULL, subtype TEXT NOT NULL, canonical_key TEXT,
        status TEXT NOT NULL, current_revision_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (tenant_id, owner_user_id, kind, subtype, canonical_key)
      );
      CREATE TABLE IF NOT EXISTS local_memory_revisions (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, revision INTEGER NOT NULL,
        authority TEXT NOT NULL, sensitivity TEXT NOT NULL, temporal_class TEXT NOT NULL,
        preference_effect TEXT, experience_maturity TEXT, activation_json TEXT NOT NULL,
        targets_json TEXT NOT NULL, value_json TEXT NOT NULL, content_markdown TEXT NOT NULL,
        applicability_json TEXT NOT NULL, confidence REAL NOT NULL, valid_from INTEGER NOT NULL,
        expires_at INTEGER, supersedes_revision_id TEXT, source_refs_json TEXT NOT NULL,
        change_reason TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE (memory_id, revision)
      );
      CREATE TABLE IF NOT EXISTS local_memory_epochs (
        tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, epoch INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, owner_user_id)
      );
      CREATE TABLE IF NOT EXISTS local_memory_projections (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
        run_id TEXT NOT NULL, target TEXT NOT NULL, memory_epoch INTEGER NOT NULL,
        projection_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_memory_settlement_jobs (
        tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, run_id TEXT NOT NULL,
        terminal_commit_ref TEXT NOT NULL, settlement_job_id TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, owner_user_id, run_id, terminal_commit_ref)
      );
      CREATE TABLE IF NOT EXISTS local_memory_settlement_attempts (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
        run_id TEXT NOT NULL, settlement_job_id TEXT NOT NULL, attempt_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_memory_settlement_attempt_scope
        ON local_memory_settlement_attempts(tenant_id, owner_user_id, run_id);
    `);
    const columns = await this.connection.prepare("PRAGMA table_info(local_memory_settlement_jobs)").all<{ name: string }>();
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has("status")) await this.connection.exec("ALTER TABLE local_memory_settlement_jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'");
    if (!columnNames.has("attempts")) await this.connection.exec("ALTER TABLE local_memory_settlement_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
    if (!columnNames.has("last_error")) await this.connection.exec("ALTER TABLE local_memory_settlement_jobs ADD COLUMN last_error TEXT");
    if (!columnNames.has("next_attempt_at")) await this.connection.exec("ALTER TABLE local_memory_settlement_jobs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0");
    await this.connection.exec("UPDATE local_memory_settlement_jobs SET next_attempt_at = enqueued_at WHERE next_attempt_at = 0");
    // v0.5 accepted arbitrary private intent keys as preferences. The first
    // affected profile fact was contact.email, which then vanished from the
    // typed response projection. Reclassify that persisted shape once so
    // existing local users do not need to re-teach the Agent their email.
    await this.connection.exec(`
      UPDATE local_memory_items
         SET kind = 'fact'
       WHERE kind = 'preference' AND subtype = 'contact.email' AND canonical_key = 'contact.email';
      UPDATE local_memory_revisions
         SET preference_effect = NULL,
             content_markdown = '用户提供了联系邮箱。'
       WHERE memory_id IN (
         SELECT id FROM local_memory_items
          WHERE kind = 'fact' AND subtype = 'contact.email' AND canonical_key = 'contact.email'
       );
    `);
  }
}

interface LocalMemoryItemRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly owner_user_id: string;
  readonly kind: MemoryItem["kind"];
  readonly subtype: string;
  readonly canonical_key: string | null;
  readonly status: MemoryItem["status"];
  readonly current_revision_id: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface LocalMemoryRevisionRow {
  readonly id: string;
  readonly memory_id: string;
  readonly revision: number;
  readonly authority: MemoryRevision["authority"];
  readonly sensitivity: MemoryRevision["sensitivity"];
  readonly temporal_class: MemoryRevision["temporalClass"];
  readonly preference_effect: MemoryRevision["preferenceEffect"] | null;
  readonly experience_maturity: MemoryRevision["experienceMaturity"] | null;
  readonly activation_json: string;
  readonly targets_json: string;
  readonly value_json: string;
  readonly content_markdown: string;
  readonly applicability_json: string;
  readonly confidence: number;
  readonly valid_from: number;
  readonly expires_at: number | null;
  readonly supersedes_revision_id: string | null;
  readonly source_refs_json: string;
  readonly change_reason: string;
  readonly created_at: number;
}

interface LocalMemoryJoinRow {
  readonly item_id: string;
  readonly item_tenant_id: string;
  readonly item_owner_user_id: string;
  readonly item_kind: MemoryItem["kind"];
  readonly item_subtype: string;
  readonly item_canonical_key: string | null;
  readonly item_status: MemoryItem["status"];
  readonly item_current_revision_id: string;
  readonly item_created_at: number;
  readonly item_updated_at: number;
  readonly revision_id: string;
  readonly revision_memory_id: string;
  readonly revision_number: number;
  readonly revision_authority: MemoryRevision["authority"];
  readonly revision_sensitivity: MemoryRevision["sensitivity"];
  readonly revision_temporal_class: MemoryRevision["temporalClass"];
  readonly revision_preference_effect: MemoryRevision["preferenceEffect"] | null;
  readonly revision_experience_maturity: MemoryRevision["experienceMaturity"] | null;
  readonly revision_activation_json: string;
  readonly revision_targets_json: string;
  readonly revision_value_json: string;
  readonly revision_content_markdown: string;
  readonly revision_applicability_json: string;
  readonly revision_confidence: number;
  readonly revision_valid_from: number;
  readonly revision_expires_at: number | null;
  readonly revision_supersedes_revision_id: string | null;
  readonly revision_source_refs_json: string;
  readonly revision_change_reason: string;
  readonly revision_created_at: number;
}

interface LocalMemorySettlementRow {
  readonly tenant_id: string;
  readonly owner_user_id: string;
  readonly run_id: string;
  readonly terminal_commit_ref: string;
  readonly settlement_job_id: string;
  readonly enqueued_at: number;
  readonly status: MemorySettlementJobStatus;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly next_attempt_at: number;
}

function settlementRowToJob(row: LocalMemorySettlementRow): MemorySettlementJob {
  return {
    tenantId: row.tenant_id,
    ownerUserId: row.owner_user_id,
    runId: row.run_id,
    terminalCommitRef: row.terminal_commit_ref,
    settlementJobId: row.settlement_job_id,
    status: row.status,
    attempts: Number(row.attempts),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    nextAttemptAt: Number(row.next_attempt_at),
    enqueuedAt: Number(row.enqueued_at),
  };
}

function rowToItem(row: LocalMemoryItemRow): MemoryItem {
  return {
    schema: "agentloop.userMemory/v1", id: row.id, tenantId: row.tenant_id, ownerUserId: row.owner_user_id,
    kind: row.kind, subtype: row.subtype, ...(row.canonical_key === null ? {} : { canonicalKey: row.canonical_key }),
    status: row.status, currentRevisionId: row.current_revision_id, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function rowToRevision(row: LocalMemoryRevisionRow): MemoryRevision {
  return {
    schema: "agentloop.userMemoryRevision/v1", id: row.id, memoryId: row.memory_id, revision: Number(row.revision),
    authority: row.authority, sensitivity: row.sensitivity, temporalClass: row.temporal_class,
    ...(row.preference_effect === null ? {} : { preferenceEffect: row.preference_effect }),
    ...(row.experience_maturity === null ? {} : { experienceMaturity: row.experience_maturity }),
    activation: parse<MemoryRevision["activation"]>(row.activation_json),
    applicationTargets: parse<MemoryRevision["applicationTargets"]>(row.targets_json),
    value: parse<MemoryRevision["value"]>(row.value_json), contentMarkdown: row.content_markdown,
    applicability: parse<MemoryRevision["applicability"]>(row.applicability_json), confidence: Number(row.confidence),
    validFrom: Number(row.valid_from), ...(row.expires_at === null ? {} : { expiresAt: Number(row.expires_at) }),
    ...(row.supersedes_revision_id === null ? {} : { supersedesRevisionId: row.supersedes_revision_id }),
    sourceRefs: parse<MemoryRevision["sourceRefs"]>(row.source_refs_json), changeReason: row.change_reason, createdAt: Number(row.created_at),
  };
}

function joinRowToEntry(row: LocalMemoryJoinRow): { readonly item: MemoryItem; readonly revision: MemoryRevision } {
  return {
    item: rowToItem({
      id: row.item_id, tenant_id: row.item_tenant_id, owner_user_id: row.item_owner_user_id,
      kind: row.item_kind, subtype: row.item_subtype, canonical_key: row.item_canonical_key,
      status: row.item_status, current_revision_id: row.item_current_revision_id,
      created_at: row.item_created_at, updated_at: row.item_updated_at,
    }),
    revision: rowToRevision({
      id: row.revision_id, memory_id: row.revision_memory_id, revision: row.revision_number,
      authority: row.revision_authority, sensitivity: row.revision_sensitivity, temporal_class: row.revision_temporal_class,
      preference_effect: row.revision_preference_effect, experience_maturity: row.revision_experience_maturity,
      activation_json: row.revision_activation_json, targets_json: row.revision_targets_json,
      value_json: row.revision_value_json, content_markdown: row.revision_content_markdown,
      applicability_json: row.revision_applicability_json, confidence: row.revision_confidence,
      valid_from: row.revision_valid_from, expires_at: row.revision_expires_at,
      supersedes_revision_id: row.revision_supersedes_revision_id, source_refs_json: row.revision_source_refs_json,
      change_reason: row.revision_change_reason, created_at: row.revision_created_at,
    }),
  };
}
