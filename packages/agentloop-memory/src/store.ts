import { createHash } from "node:crypto";
import type { MemoryProjection } from "@zhujun/agentloop";
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

function scopeKey(scope: MemoryScope): string {
  return `${scope.tenantId}\u0000${scope.ownerUserId}`;
}

function hash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input, Object.keys(input as object).sort())).digest("hex");
}

/** A deterministic store used by local development and contract tests. */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly items = new Map<string, MemoryItem>();
  private readonly revisions = new Map<string, MemoryRevision>();
  private readonly epochs = new Map<string, number>();
  private readonly projectionsByRun = new Map<string, MemoryProjection[]>();
  private readonly settlementJobStore = new Map<string, MemorySettlementJob>();
  private readonly attempts: Array<{ job: MemorySettlementJob; value: SettlementAttempt }> = [];

  async settlementJobs(scope: MemoryScope, runId: string): Promise<readonly MemorySettlementJob[]> {
    return [...this.settlementJobStore.values()]
      .filter((job) => job.tenantId === scope.tenantId && job.ownerUserId === scope.ownerUserId && job.runId === runId)
      .map((job) => ({ ...job }));
  }

  async recordSettlementAttempt(job: MemorySettlementJob, attempt: SettlementAttempt): Promise<void> {
    this.attempts.push({ job, value: attempt });
  }

  async settlementAttempts(scope: MemoryScope, runId: string): Promise<readonly SettlementAttempt[]> {
    return this.attempts.filter(({ job }) => job.tenantId === scope.tenantId && job.ownerUserId === scope.ownerUserId && job.runId === runId).map(({ value }) => value);
  }

  async replaySettlement(scope: MemoryScope, runId: string, now: number): Promise<void> {
    for (const [key, job] of this.settlementJobStore) {
      if (job.tenantId !== scope.tenantId || job.ownerUserId !== scope.ownerUserId || job.runId !== runId) continue;
      if (job.status === "processing") throw new Error("settlement_job_processing");
      this.settlementJobStore.set(key, { ...job, status: "queued", attempts: 0, lastError: undefined, nextAttemptAt: now });
    }
  }

  async currentEpoch(scope: MemoryScope): Promise<number> {
    return this.epochs.get(scopeKey(scope)) ?? 0;
  }

  async active(scope: MemoryScope): Promise<readonly { readonly item: MemoryItem; readonly revision: MemoryRevision }[]> {
    const key = scopeKey(scope);
    return [...this.items.values()]
      .filter((item) => `${item.tenantId}\u0000${item.ownerUserId}` === key && item.status === "active")
      .map((item) => ({ item, revision: this.revisions.get(item.currentRevisionId)! }))
      .filter((entry) => entry.revision !== undefined);
  }

  async commit(scope: MemoryScope, candidate: MemoryCandidate, now: number): Promise<{
    readonly item: MemoryItem;
    readonly revision: MemoryRevision;
    readonly memoryEpoch: number;
  }> {
    const policy = evaluateCandidate(candidate);
    if (policy.kind !== "accept") throw new Error(`candidate_policy:${policy.reason}`);
    if (candidate.tenantId !== scope.tenantId || candidate.ownerUserId !== scope.ownerUserId) {
      throw new Error("memory_scope_mismatch");
    }
    const key = scopeKey(scope);
    const matching = [...this.items.values()].find((item) =>
      item.tenantId === scope.tenantId &&
      item.ownerUserId === scope.ownerUserId &&
      item.status === "active" &&
      item.kind === candidate.proposedKind &&
      item.subtype === candidate.proposedSubtype &&
      item.canonicalKey === candidate.proposedCanonicalKey,
    );
    if (candidate.expectedCurrentRevisionId !== undefined && matching?.currentRevisionId !== candidate.expectedCurrentRevisionId) throw new Error("task_group_revision_conflict");
    const itemId = matching?.id ?? `mem_${hash({ key, candidate: candidate.id }).slice(0, 24)}`;
    const previousRevision = matching === undefined ? undefined : this.revisions.get(matching.currentRevisionId);
    const revisionNumber = previousRevision === undefined ? 1 : previousRevision.revision + 1;
    const revision: MemoryRevision = {
      schema: "agentloop.userMemoryRevision/v1",
      id: `memrev_${hash({ itemId, revisionNumber, candidate: candidate.id }).slice(0, 24)}`,
      memoryId: itemId,
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
      ...(previousRevision === undefined ? {} : { supersedesRevisionId: previousRevision.id }),
      sourceRefs: [...candidate.sourceRefs],
      changeReason: candidate.reason,
      createdAt: now,
    };
    if (candidate.sensitivity === "secret") throw new Error("secret_data_is_never_persisted");
    validateRevision(revision, candidate.proposedKind);
    const item: MemoryItem = matching === undefined
      ? {
          schema: "agentloop.userMemory/v1",
          id: itemId,
          tenantId: scope.tenantId,
          ownerUserId: scope.ownerUserId,
          kind: candidate.proposedKind,
          subtype: candidate.proposedSubtype,
          ...(candidate.proposedCanonicalKey === undefined ? {} : { canonicalKey: candidate.proposedCanonicalKey }),
          status: "active",
          currentRevisionId: revision.id,
          createdAt: now,
          updatedAt: now,
        }
      : { ...matching, currentRevisionId: revision.id, updatedAt: now };
    this.items.set(item.id, item);
    this.revisions.set(revision.id, revision);
    const memoryEpoch = (this.epochs.get(key) ?? 0) + 1;
    this.epochs.set(key, memoryEpoch);
    return { item, revision, memoryEpoch };
  }

  async recordProjection(scope: MemoryScope, projection: MemoryProjection): Promise<void> {
    const key = `${scopeKey(scope)}\u0000${projection.runId}`;
    const current = this.projectionsByRun.get(key) ?? [];
    this.projectionsByRun.set(key, [...current, projection]);
  }

  async projections(scope: MemoryScope, runId: string): Promise<readonly MemoryProjection[]> {
    return [...(this.projectionsByRun.get(`${scopeKey(scope)}\u0000${runId}`) ?? [])];
  }

  async enqueueSettlement(input: { readonly scope: MemoryScope; readonly runId: string; readonly terminalCommitRef: string; readonly now: number }): Promise<{
    readonly kind: "enqueued" | "duplicate";
    readonly settlementJobId: string;
    readonly enqueuedAt: number;
  }> {
    const key = `${scopeKey(input.scope)}\u0000${input.runId}\u0000${input.terminalCommitRef}`;
    const existing = this.settlementJobStore.get(key);
    if (existing !== undefined) return { kind: "duplicate", settlementJobId: existing.settlementJobId, enqueuedAt: existing.enqueuedAt };
    const value: MemorySettlementJob = {
      tenantId: input.scope.tenantId,
      ownerUserId: input.scope.ownerUserId,
      runId: input.runId,
      terminalCommitRef: input.terminalCommitRef,
      settlementJobId: `memjob_${hash(key).slice(0, 24)}`,
      status: "queued",
      attempts: 0,
      nextAttemptAt: input.now,
      enqueuedAt: input.now,
    };
    this.settlementJobStore.set(key, value);
    return { kind: "enqueued", settlementJobId: value.settlementJobId, enqueuedAt: value.enqueuedAt };
  }

  async claimSettlement(input: { readonly now: number; readonly maxAttempts: number; readonly allowedRunIds?: readonly string[]; readonly allowedSettlementJobIds?: readonly string[] }): Promise<MemorySettlementJob | undefined> {
    const candidates = [...this.settlementJobStore.entries()]
      .filter(([, job]) => (job.status === "queued" || job.status === "failed") && job.nextAttemptAt <= input.now
        && (input.allowedRunIds === undefined || input.allowedRunIds.includes(job.runId))
        && (input.allowedSettlementJobIds === undefined || input.allowedSettlementJobIds.includes(job.settlementJobId)))
      .sort(([, left], [, right]) => left.enqueuedAt - right.enqueuedAt);
    const next = candidates[0];
    if (next === undefined) return undefined;
    const [key, job] = next;
    if (job.attempts >= input.maxAttempts) {
      const dead: MemorySettlementJob = { ...job, status: "dead_letter" };
      this.settlementJobStore.set(key, dead);
      return undefined;
    }
    const claimed: MemorySettlementJob = { ...job, status: "processing", attempts: job.attempts + 1 };
    this.settlementJobStore.set(key, claimed);
    return claimed;
  }

  async settlementBatchCandidates(input: { readonly minimum: number; readonly maxAttempts: number }): Promise<readonly { readonly scope: MemoryScope; readonly count: number }[]> {
    const counts = new Map<string, { scope: MemoryScope; count: number }>();
    for (const job of this.settlementJobStore.values()) {
      if ((job.status !== "queued" && job.status !== "failed") || job.attempts >= input.maxAttempts) continue;
      const key = scopeKey(job);
      const current = counts.get(key) ?? { scope: { tenantId: job.tenantId, ownerUserId: job.ownerUserId }, count: 0 };
      current.count += 1;
      counts.set(key, current);
    }
    return [...counts.values()].filter((item) => item.count >= input.minimum).sort((a, b) => b.count - a.count);
  }

  async claimSettlementBatch(input: { readonly scope: MemoryScope; readonly now: number; readonly maxAttempts: number; readonly limit: number; readonly allowedRunIds?: readonly string[]; readonly allowedSettlementJobIds?: readonly string[] }): Promise<readonly MemorySettlementJob[]> {
    const candidates = [...this.settlementJobStore.entries()]
      .filter(([, job]) => job.tenantId === input.scope.tenantId && job.ownerUserId === input.scope.ownerUserId
        && (job.status === "queued" || job.status === "failed") && job.nextAttemptAt <= input.now
        && (input.allowedRunIds === undefined || input.allowedRunIds.includes(job.runId))
        && (input.allowedSettlementJobIds === undefined || input.allowedSettlementJobIds.includes(job.settlementJobId)))
      .sort(([, left], [, right]) => left.enqueuedAt - right.enqueuedAt).slice(0, Math.max(0, input.limit));
    const claimed: MemorySettlementJob[] = [];
    for (const [key, job] of candidates) {
      if (job.attempts >= input.maxAttempts) {
        this.settlementJobStore.set(key, { ...job, status: "dead_letter" });
        continue;
      }
      const value = { ...job, status: "processing" as const, attempts: job.attempts + 1 };
      this.settlementJobStore.set(key, value);
      claimed.push(value);
    }
    return claimed;
  }

  async finishSettlement(input: {
    readonly job: MemorySettlementJob;
    readonly now: number;
    readonly maxAttempts: number;
    readonly outcome: "succeeded" | "failed";
    readonly error?: string;
  }): Promise<MemorySettlementJob> {
    const key = `${input.job.tenantId}\u0000${input.job.ownerUserId}\u0000${input.job.runId}\u0000${input.job.terminalCommitRef}`;
    const current = this.settlementJobStore.get(key);
    if (current === undefined || current.settlementJobId !== input.job.settlementJobId) throw new Error("settlement_job_not_found");
    const status: MemorySettlementJobStatus = input.outcome === "succeeded"
      ? "succeeded"
      : current.attempts >= input.maxAttempts ? "dead_letter" : "failed";
    const updated: MemorySettlementJob = {
      ...current,
      status,
      ...(input.error === undefined ? {} : { lastError: input.error }),
      nextAttemptAt: status === "failed" ? input.now + Math.min(60_000, 1_000 * (2 ** Math.max(0, current.attempts - 1))) : input.now,
    };
    this.settlementJobStore.set(key, updated);
    return updated;
  }
}
