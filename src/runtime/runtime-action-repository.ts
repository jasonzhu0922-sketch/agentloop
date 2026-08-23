import type { SqlConnection } from "../storage/connection.ts";
import { randomUUID } from "node:crypto";
import { AppError } from "../shared/errors.ts";

export type RuntimeActionKind =
  | "planning"
  | "model_turn"
  | "tool_call"
  | "assessment"
  | "compaction"
  | "recovery_review";

export type RuntimeActionState =
  | "dispatched"
  | "succeeded"
  | "failed"
  | "recovery_required";

export type ReplayPolicy = "safe" | "idempotent" | "unsafe";

export interface RuntimeActionRecord {
  readonly id: string;
  readonly runId: string;
  readonly planId?: string;
  readonly stepId?: string;
  readonly kind: RuntimeActionKind;
  readonly state: RuntimeActionState;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly replayPolicy: ReplayPolicy;
  readonly deadlineAt?: number;
  readonly leaseUntil?: number;
  readonly fence: number;
  readonly revision: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly resultRef?: string;
  readonly errorCode?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt?: number;
}

interface RuntimeActionRow {
  id: string;
  run_id: string;
  plan_id: string | null;
  step_id: string | null;
  kind: RuntimeActionKind;
  state: RuntimeActionState;
  attempt: number;
  max_attempts: number;
  replay_policy: ReplayPolicy;
  deadline_at: number | null;
  lease_until: number | null;
  fence: number;
  revision: number;
  metadata_json: string;
  result_ref: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export class RuntimeActionRepository {
  private readonly database: SqlConnection;

  constructor(database: SqlConnection) {
    this.database = database;
  }

  list(runId: string): RuntimeActionRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM runtime_actions WHERE run_id = ? ORDER BY created_at, id
    `).all(runId) as unknown as RuntimeActionRow[];
    return rows.map(toRuntimeActionRecord);
  }

  async execute<T>(input: {
    runId: string;
    planId?: string;
    stepId?: string;
    kind: Exclude<RuntimeActionKind, "recovery_review">;
    replayPolicy: ReplayPolicy;
    deadlineMs: number;
    metadata?: Readonly<Record<string, unknown>>;
  }, operation: () => Promise<T>): Promise<T> {
    const action = this.dispatch(input);
    try {
      const value = await operation();
      this.succeed(action.id, action.fence);
      return value;
    } catch (error) {
      this.fail(action.id, action.fence, errorCode(error));
      throw error;
    }
  }

  dispatch(input: {
    runId: string;
    planId?: string;
    stepId?: string;
    kind: Exclude<RuntimeActionKind, "recovery_review">;
    replayPolicy: ReplayPolicy;
    deadlineMs: number;
    metadata?: Readonly<Record<string, unknown>>;
  }): RuntimeActionRecord {
    if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 100 || input.deadlineMs > 3_600_000) {
      throw new TypeError("Runtime Action deadline must be between 100 and 3600000 milliseconds");
    }
    const id = randomUUID();
    const now = Date.now();
    const deadlineAt = now + input.deadlineMs;
    const metadata = input.metadata ?? {};
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO runtime_actions(
          id, run_id, plan_id, step_id, kind, state, attempt, max_attempts,
          replay_policy, deadline_at, lease_until, fence, revision, metadata_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'dispatched', 1, 1, ?, ?, ?, 1, 1, ?, ?, ?)
      `).run(
        id,
        input.runId,
        input.planId ?? null,
        input.stepId ?? null,
        input.kind,
        input.replayPolicy,
        deadlineAt,
        deadlineAt,
        JSON.stringify(metadata),
        now,
        now,
      );
      this.appendEvent(input.runId, "action.created", {
        actionId: id,
        kind: input.kind,
        planId: input.planId,
        stepId: input.stepId,
        replayPolicy: input.replayPolicy,
        deadlineAt,
      }, now);
      this.appendEvent(input.runId, "action.leased", { actionId: id, fence: 1, leaseUntil: deadlineAt }, now);
      this.appendEvent(input.runId, "action.dispatched", { actionId: id, fence: 1 }, now);
    });
    return this.require(id);
  }

  reconcileRunningRuns(): number {
    const now = Date.now();
    let reconciled = 0;
    this.database.transaction(() => {
      const legacyRuns = this.database.prepare(`
        SELECT id FROM runs
        WHERE status = 'running'
          AND NOT EXISTS (SELECT 1 FROM runtime_actions WHERE runtime_actions.run_id = runs.id)
      `).all() as unknown as Array<{ id: string }>;
      for (const run of legacyRuns) {
        this.createRecoveryReview({
          runId: run.id,
          reason: "legacy_state_incomplete",
          createdAt: now,
        });
        reconciled += 1;
      }

      const expired = this.database.prepare(`
        SELECT actions.id, actions.run_id, actions.fence, actions.deadline_at,
               actions.lease_until, actions.revision
        FROM runtime_actions AS actions
        JOIN runs ON runs.id = actions.run_id
        WHERE runs.status = 'running'
          AND actions.state = 'dispatched'
          AND (actions.deadline_at <= ? OR actions.lease_until <= ?)
      `).all(now, now) as unknown as Array<{
        id: string; run_id: string; fence: number; deadline_at: number; lease_until: number; revision: number;
      }>;
      for (const action of expired) {
        const reason = action.deadline_at <= now ? "deadline_expired" : "worker_lease_expired";
        const result = this.database.prepare(`
          UPDATE runtime_actions
          SET state = 'recovery_required', lease_until = NULL, revision = revision + 1, updated_at = ?
          WHERE id = ? AND state = 'dispatched' AND fence = ? AND revision = ?
        `).run(now, action.id, action.fence, action.revision) as { changes: number };
        if (result.changes !== 1) continue;
        this.appendEvent(action.run_id, "action.recovery_required", {
          actionId: action.id,
          fence: action.fence,
          reason,
        }, now);
        this.upsertRecoveryState(action.run_id, action.id, "waiting_recovery", undefined, now);
        reconciled += 1;
      }
    });
    return reconciled;
  }

  cancelDispatchedForRun(runId: string, code = "CANCELLED"): number {
    const now = Date.now();
    let cancelled = 0;
    this.database.transaction(() => {
      const actions = this.database.prepare(`
        SELECT id, fence, revision
        FROM runtime_actions
        WHERE run_id = ? AND state = 'dispatched'
      `).all(runId) as unknown as Array<{ id: string; fence: number; revision: number }>;
      for (const action of actions) {
        const result = this.database.prepare(`
          UPDATE runtime_actions
          SET state = 'failed', lease_until = NULL, error_code = ?, revision = revision + 1,
              updated_at = ?, closed_at = ?
          WHERE id = ? AND state = 'dispatched' AND revision = ?
        `).run(code, now, now, action.id, action.revision) as { changes: number };
        if (result.changes !== 1) continue;
        this.appendEvent(runId, "action.failed", { actionId: action.id, fence: action.fence, code }, now);
        cancelled += 1;
      }
    });
    return cancelled;
  }

  requireRecoveryReview(input: {
    readonly runId: string;
    readonly planId?: string;
    readonly stepId?: string;
    readonly reason: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): RuntimeActionRecord {
    const now = Date.now();
    let actionId = "";
    this.database.transaction(() => {
      const existing = this.database.prepare(`
        SELECT id FROM runtime_actions
        WHERE run_id = ? AND state = 'recovery_required'
        ORDER BY created_at DESC LIMIT 1
      `).get(input.runId) as { id: string } | undefined;
      if (existing !== undefined) {
        actionId = existing.id;
        this.upsertRecoveryState(input.runId, actionId, "waiting_recovery", undefined, now);
        return;
      }
      actionId = this.createRecoveryReview({
        runId: input.runId,
        planId: input.planId,
        stepId: input.stepId,
        reason: input.reason,
        metadata: input.metadata,
        createdAt: now,
      });
    });
    return this.require(actionId);
  }

  private succeed(actionId: string, fence: number): void {
    const now = Date.now();
    this.database.transaction(() => {
      const row = this.requireRow(actionId);
      const result = this.database.prepare(`
        UPDATE runtime_actions
        SET state = 'succeeded', lease_until = NULL, revision = revision + 1,
            updated_at = ?, closed_at = ?
        WHERE id = ? AND state = 'dispatched' AND fence = ? AND revision = ?
      `).run(now, now, actionId, fence, row.revision) as { changes: number };
      if (result.changes !== 1) throw new AppError("CONFLICT", "Runtime Action lease was lost before result commit", 409);
      this.appendEvent(row.run_id, "action.result_committed", { actionId, fence }, now);
    });
  }

  private fail(actionId: string, fence: number, code: string): void {
    const now = Date.now();
    this.database.transaction(() => {
      const row = this.requireRow(actionId);
      const result = this.database.prepare(`
        UPDATE runtime_actions
        SET state = 'failed', lease_until = NULL, error_code = ?, revision = revision + 1,
            updated_at = ?, closed_at = ?
        WHERE id = ? AND state = 'dispatched' AND fence = ? AND revision = ?
      `).run(code, now, now, actionId, fence, row.revision) as { changes: number };
      if (result.changes !== 1) return;
      this.appendEvent(row.run_id, "action.failed", { actionId, fence, code }, now);
    });
  }

  private createRecoveryReview(input: {
    readonly runId: string;
    readonly planId?: string;
    readonly stepId?: string;
    readonly reason: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly createdAt: number;
  }): string {
    const id = randomUUID();
    const metadata = { reason: input.reason, ...(input.metadata ?? {}) };
    this.database.prepare(`
      INSERT INTO runtime_actions(
        id, run_id, plan_id, step_id, kind, state, attempt, max_attempts,
        replay_policy, deadline_at, lease_until, fence, revision, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'recovery_review', 'recovery_required', 0, 0,
                'unsafe', NULL, NULL, 0, 1, ?, ?, ?)
    `).run(
      id,
      input.runId,
      input.planId ?? null,
      input.stepId ?? null,
      JSON.stringify(metadata),
      input.createdAt,
      input.createdAt,
    );
    this.appendEvent(input.runId, "action.created", {
      actionId: id,
      kind: "recovery_review",
      ...(input.planId === undefined ? {} : { planId: input.planId }),
      ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    }, input.createdAt);
    this.appendEvent(input.runId, "action.recovery_required", {
      actionId: id,
      reason: input.reason,
      ...(input.planId === undefined ? {} : { planId: input.planId }),
      ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    }, input.createdAt);
    this.upsertRecoveryState(input.runId, id, "waiting_recovery", undefined, input.createdAt);
    return id;
  }

  private upsertRecoveryState(
    runId: string,
    actionId: string,
    state: "waiting_recovery" | "waiting_user" | "ready_to_resume",
    question: string | undefined,
    now: number,
  ): void {
    this.database.prepare(`
      INSERT INTO run_recovery_states(run_id, state, action_id, question, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        state = excluded.state,
        action_id = excluded.action_id,
        question = excluded.question,
        updated_at = excluded.updated_at
    `).run(runId, state, actionId, question ?? null, now);
  }

  private require(actionId: string): RuntimeActionRecord {
    return toRuntimeActionRecord(this.requireRow(actionId));
  }

  private requireRow(actionId: string): RuntimeActionRow {
    const row = this.database.prepare("SELECT * FROM runtime_actions WHERE id = ?")
      .get(actionId) as RuntimeActionRow | undefined;
    if (row === undefined) throw new AppError("NOT_FOUND", "Runtime Action not found", 404);
    return row;
  }

  private appendEvent(runId: string, type: string, data: Readonly<Record<string, unknown>>, createdAt: number): void {
    const sequence = this.database.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?",
    ).get(runId) as { seq: number };
    this.database.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, sequence.seq, type, JSON.stringify(data), createdAt);
  }
}

function toRuntimeActionRecord(row: RuntimeActionRow): RuntimeActionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    ...(row.plan_id === null ? {} : { planId: row.plan_id }),
    ...(row.step_id === null ? {} : { stepId: row.step_id }),
    kind: row.kind,
    state: row.state,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    replayPolicy: row.replay_policy,
    ...(row.deadline_at === null ? {} : { deadlineAt: row.deadline_at }),
    ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }),
    fence: row.fence,
    revision: row.revision,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    ...(row.result_ref === null ? {} : { resultRef: row.result_ref }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
  };
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : "INTERNAL_ERROR";
}
