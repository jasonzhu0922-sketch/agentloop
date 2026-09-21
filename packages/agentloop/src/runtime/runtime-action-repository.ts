import type { SqlConnection } from "../storage/connection.ts";
import { randomUUID } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import {
  failureEffectState,
  type RuntimeActionEffectState,
} from "./action-effect.ts";
import type { RuntimeResultRecord } from "./runtime-result.ts";

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

const LEGACY_ACTIONLESS_RUN_GRACE_MS = 60_000;

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
  readonly effectState: RuntimeActionEffectState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt?: number;
}

export interface InterruptedRunRecord {
  readonly runId: string;
  readonly actionId?: string;
  readonly planId?: string;
  readonly stepId?: string;
  readonly reason: "legacy_state_incomplete" | "deadline_expired" | "worker_lease_expired";
  readonly replayPolicy?: ReplayPolicy;
  readonly fence?: number;
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
  effect_state: RuntimeActionEffectState;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export class RuntimeActionRepository {
  private readonly database: SqlConnection;

  constructor(database: SqlConnection) {
    this.database = database;
  }

  async list(runId: string): Promise<RuntimeActionRecord[]> {
    const rows = await this.database.prepare(`
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
    /** A resolved operation may still report a semantic failure, such as a nonzero command exit. */
    resultFailureCode?: (value: unknown) => string | undefined;
    /** Build the canonical Runtime result that is atomically committed with Action success. */
    prepareResult?: (value: T, action: RuntimeActionRecord) => Promise<RuntimeResultRecord>;
  }, operation: () => Promise<T>): Promise<T> {
    const action = await this.dispatch(input);
    try {
      const value = await operation();
      const resultFailureCode = input.resultFailureCode?.(value);
      if (resultFailureCode === undefined) {
        const result = await input.prepareResult?.(value, action);
        await this.succeed(action.id, action.fence, result);
      } else {
        await this.fail(action.id, action.fence, resultFailureCode, "unknown");
      }
      return value;
    } catch (error) {
      await this.fail(action.id, action.fence, errorCode(error), failureEffectState(error));
      throw error;
    }
  }

  async dispatch(input: {
    runId: string;
    planId?: string;
    stepId?: string;
    kind: Exclude<RuntimeActionKind, "recovery_review">;
    replayPolicy: ReplayPolicy;
    deadlineMs: number;
    metadata?: Readonly<Record<string, unknown>>;
  }): Promise<RuntimeActionRecord> {
    if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 100 || input.deadlineMs > 3_600_000) {
      throw new TypeError("Runtime Action deadline must be between 100 and 3600000 milliseconds");
    }
    const id = randomUUID();
    const now = Date.now();
    const deadlineAt = now + input.deadlineMs;
    const metadata = input.metadata ?? {};
    await this.database.transaction(async () => {
      await this.database.prepare(`
        INSERT INTO runtime_actions(
          id, run_id, plan_id, step_id, kind, state, attempt, max_attempts,
          replay_policy, deadline_at, lease_until, fence, revision, metadata_json,
          effect_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'dispatched', 1, 1, ?, ?, ?, 1, 1, ?, 'not_started', ?, ?)
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
      await this.appendEvent(input.runId, "action.created", {
        actionId: id,
        kind: input.kind,
        planId: input.planId,
        stepId: input.stepId,
        replayPolicy: input.replayPolicy,
        effectState: "not_started",
        deadlineAt,
      }, now);
      await this.appendEvent(input.runId, "action.leased", { actionId: id, fence: 1, leaseUntil: deadlineAt }, now);
      await this.appendEvent(input.runId, "action.dispatched", { actionId: id, fence: 1 }, now);
    });
    return await this.require(id);
  }

  async reconcileRunningRuns(runIds?: readonly string[]): Promise<InterruptedRunRecord[]> {
    const scopedRunIds = runIds === undefined ? undefined : [...new Set(runIds)];
    if (scopedRunIds !== undefined && scopedRunIds.length === 0) return [];
    const runScope = scopedRunIds === undefined ? "" : ` AND runs.id IN (${scopedRunIds.map(() => "?").join(", ")})`;
    const now = Date.now();
    const interrupted: InterruptedRunRecord[] = [];
    await this.database.transaction(async () => {
      const legacyRuns = await this.database.prepare(`
        SELECT id FROM runs
        WHERE status = 'running'
          AND created_at <= ?
          AND NOT EXISTS (SELECT 1 FROM runtime_actions WHERE runtime_actions.run_id = runs.id)
          ${runScope}
      `).all(now - LEGACY_ACTIONLESS_RUN_GRACE_MS, ...(scopedRunIds ?? [])) as unknown as Array<{ id: string }>;
      for (const run of legacyRuns) {
        interrupted.push({ runId: run.id, reason: "legacy_state_incomplete" });
      }

      const expired = await this.database.prepare(`
        SELECT actions.id, actions.run_id, actions.plan_id, actions.step_id,
               actions.replay_policy, actions.fence, actions.deadline_at,
               actions.lease_until, actions.revision
        FROM runtime_actions AS actions
        JOIN runs ON runs.id = actions.run_id
        WHERE runs.status = 'running'
          AND actions.state = 'dispatched'
          AND (actions.deadline_at <= ? OR actions.lease_until <= ?)
          ${runScope}
      `).all(now, now, ...(scopedRunIds ?? [])) as unknown as Array<{
        id: string; run_id: string; plan_id: string | null; step_id: string | null;
        replay_policy: ReplayPolicy; fence: number; deadline_at: number; lease_until: number; revision: number;
      }>;
      for (const action of expired) {
        const reason = action.deadline_at <= now ? "deadline_expired" : "worker_lease_expired";
        const result = await this.database.prepare(`
          UPDATE runtime_actions
          SET state = 'failed', lease_until = NULL, error_code = 'EXECUTION_AUTHORITY_LOST', effect_state = 'unknown',
              revision = revision + 1, updated_at = ?, closed_at = ?
          WHERE id = ? AND state = 'dispatched' AND fence = ? AND revision = ?
        `).run(now, now, action.id, action.fence, action.revision) as { changes: number };
        if (result.changes !== 1) continue;
        await this.appendEvent(action.run_id, "action.interrupted", {
          actionId: action.id,
          fence: action.fence,
          reason,
          effectState: "unknown",
        }, now);
        interrupted.push({
          runId: action.run_id,
          actionId: action.id,
          ...(action.plan_id === null ? {} : { planId: action.plan_id }),
          ...(action.step_id === null ? {} : { stepId: action.step_id }),
          reason,
          replayPolicy: action.replay_policy,
          fence: action.fence,
        });
      }

      const expiredIds = expired.map((action) => action.id);
      const excludedActions = expiredIds.length === 0 ? "SELECT ''" : expiredIds.map(() => "?").join(", ");
      const stranded = await this.database.prepare(`
        SELECT actions.id, actions.run_id, actions.plan_id, actions.step_id,
               actions.replay_policy, actions.fence, actions.deadline_at, actions.lease_until
        FROM runtime_actions AS actions
        JOIN runs ON runs.id = actions.run_id
        WHERE runs.status = 'running'
          AND actions.state = 'failed'
          AND actions.error_code = 'EXECUTION_AUTHORITY_LOST'
          AND actions.id NOT IN (${excludedActions})
          ${runScope}
      `).all(...expiredIds, ...(scopedRunIds ?? [])) as unknown as Array<{
        id: string; run_id: string; plan_id: string | null; step_id: string | null;
        replay_policy: ReplayPolicy; fence: number; deadline_at: number | null; lease_until: number | null;
      }>;
      for (const action of stranded) interrupted.push({
        runId: action.run_id,
        actionId: action.id,
        ...(action.plan_id === null ? {} : { planId: action.plan_id }),
        ...(action.step_id === null ? {} : { stepId: action.step_id }),
        reason: action.deadline_at !== null && action.deadline_at <= now ? "deadline_expired" : "worker_lease_expired",
        replayPolicy: action.replay_policy,
        fence: action.fence,
      });

      const legacyPaused = await this.database.prepare(`
        SELECT actions.id, actions.run_id, actions.plan_id, actions.step_id,
               actions.replay_policy, actions.fence, actions.metadata_json
        FROM runtime_actions AS actions
        JOIN runs ON runs.id = actions.run_id
        JOIN run_recovery_states AS recovery ON recovery.action_id = actions.id
        WHERE runs.status = 'running'
          AND actions.state = 'recovery_required'
          AND recovery.state = 'waiting_recovery'
          ${runScope}
      `).all(...(scopedRunIds ?? [])) as unknown as Array<{
        id: string; run_id: string; plan_id: string | null; step_id: string | null;
        replay_policy: ReplayPolicy; fence: number; metadata_json: string;
      }>;
      for (const action of legacyPaused) {
        const reason = stringMetadataField(action.metadata_json, "reason");
        if (reason === "assessment_failed_boundary" || reason === "human_loop_requested") continue;
        const result = await this.database.prepare(`
          UPDATE runtime_actions
          SET state = 'failed', error_code = 'EXECUTION_AUTHORITY_LOST', effect_state = 'unknown', revision = revision + 1,
              updated_at = ?, closed_at = ?
          WHERE id = ? AND state = 'recovery_required'
        `).run(now, now, action.id) as { changes: number };
        if (result.changes !== 1) continue;
        await this.database.prepare("DELETE FROM run_recovery_states WHERE run_id = ? AND action_id = ?")
          .run(action.run_id, action.id);
        await this.appendEvent(action.run_id, "action.interrupted", {
          actionId: action.id,
          fence: action.fence,
          reason: reason ?? "worker_lease_expired",
          migratedFrom: "waiting_recovery",
          effectState: "unknown",
        }, now);
        interrupted.push({
          runId: action.run_id,
          actionId: action.id,
          ...(action.plan_id === null ? {} : { planId: action.plan_id }),
          ...(action.step_id === null ? {} : { stepId: action.step_id }),
          reason: reason === "legacy_state_incomplete" ? "legacy_state_incomplete" : "worker_lease_expired",
          replayPolicy: action.replay_policy,
          fence: action.fence,
        });
      }
    });
    return interrupted;
  }

  async cancelDispatchedForRun(runId: string, code = "CANCELLED"): Promise<number> {
    const now = Date.now();
    let cancelled = 0;
    await this.database.transaction(async () => {
      const actions = await this.database.prepare(`
        SELECT id, fence, revision
        FROM runtime_actions
        WHERE run_id = ? AND state = 'dispatched'
      `).all(runId) as unknown as Array<{ id: string; fence: number; revision: number }>;
      for (const action of actions) {
        const result = await this.database.prepare(`
          UPDATE runtime_actions
          SET state = 'failed', lease_until = NULL, error_code = ?, effect_state = 'unknown', revision = revision + 1,
              updated_at = ?, closed_at = ?
          WHERE id = ? AND state = 'dispatched' AND revision = ?
        `).run(code, now, now, action.id, action.revision) as { changes: number };
        if (result.changes !== 1) continue;
        await this.appendEvent(runId, "action.failed", { actionId: action.id, fence: action.fence, code, effectState: "unknown" }, now);
        cancelled += 1;
      }
    });
    return cancelled;
  }

  async resolveRecoveryReview(actionId: string): Promise<void> {
    const now = Date.now();
    await this.database.transaction(async () => {
      const row = await this.requireRow(actionId);
      const result = await this.database.prepare(`
        UPDATE runtime_actions
        SET state = 'succeeded', revision = revision + 1, updated_at = ?, closed_at = ?
        WHERE id = ? AND kind = 'recovery_review' AND state = 'recovery_required' AND revision = ?
      `).run(now, now, actionId, row.revision) as { changes: number };
      if (result.changes !== 1) throw new AppError("CONFLICT", "Recovery review is no longer pending", 409);
      await this.appendEvent(row.run_id, "action.result_committed", { actionId, fence: row.fence, effectState: "applied" }, now);
    });
  }

  async requireRecoveryReview(input: {
    readonly runId: string;
    readonly planId?: string;
    readonly stepId?: string;
    readonly reason: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<RuntimeActionRecord> {
    return this.requireRecoveryReviewWithPolicy(input, "unsafe");
  }

  /** Persist an internal repair boundary without pausing the Run for UI-driven recovery. */
  async requireAutomaticRepair(input: {
    readonly runId: string;
    readonly planId: string;
    readonly stepId: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<RuntimeActionRecord> {
    return this.requireRecoveryReviewWithPolicy(
      { ...input, reason: "assessment_failed_boundary" },
      "unsafe",
      false,
    );
  }

  async requireHumanLoopResume(input: {
    readonly runId: string;
    readonly planId?: string;
    readonly stepId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<RuntimeActionRecord> {
    return this.requireRecoveryReviewWithPolicy({ ...input, reason: "human_loop_requested" }, "safe");
  }

  private async requireRecoveryReviewWithPolicy(input: {
    readonly runId: string;
    readonly planId?: string;
    readonly stepId?: string;
    readonly reason: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }, replayPolicy: ReplayPolicy, pauseRun = true): Promise<RuntimeActionRecord> {
    const now = Date.now();
    let actionId = "";
    await this.database.transaction(async () => {
      const existing = await this.database.prepare(`
        SELECT id FROM runtime_actions
        WHERE run_id = ? AND state = 'recovery_required'
        ORDER BY created_at DESC LIMIT 1
      `).get(input.runId) as { id: string } | undefined;
      if (existing !== undefined) {
        actionId = existing.id;
        if (pauseRun) await this.upsertRecoveryState(input.runId, actionId, "waiting_recovery", undefined, now);
        return;
      }
      actionId = await this.createRecoveryReview({
        runId: input.runId,
        planId: input.planId,
        stepId: input.stepId,
        reason: input.reason,
        metadata: input.metadata,
        replayPolicy,
        createdAt: now,
      });
      if (!pauseRun) {
        await this.database.prepare("DELETE FROM run_recovery_states WHERE run_id = ? AND action_id = ?")
          .run(input.runId, actionId);
      }
    });
    return await this.require(actionId);
  }

  private async succeed(actionId: string, fence: number, runtimeResult?: RuntimeResultRecord): Promise<void> {
    const now = Date.now();
    await this.database.transaction(async () => {
      const row = await this.requireRow(actionId);
      if (
        runtimeResult !== undefined
        && (
          runtimeResult.kind !== "tool"
          || runtimeResult.publication.status !== "committed"
          || runtimeResult.producer.actionId !== actionId
          || runtimeResult.producer.runId !== row.run_id
          || runtimeResult.producer.planId !== (row.plan_id ?? undefined)
          || runtimeResult.producer.stepId !== (row.step_id ?? undefined)
        )
      ) {
        throw new AppError("CONFLICT", "Runtime result producer does not match the committing Action", 409);
      }
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const resultRef = runtimeResult?.ref.resultId;
      const result = await this.database.prepare(`
        UPDATE runtime_actions
        SET state = 'succeeded', lease_until = NULL, effect_state = 'applied', result_ref = ?, metadata_json = ?, revision = revision + 1,
            updated_at = ?, closed_at = ?
        WHERE id = ? AND state = 'dispatched' AND fence = ? AND revision = ?
      `).run(
        resultRef ?? null,
        JSON.stringify(runtimeResult === undefined ? metadata : { ...metadata, runtimeResult }),
        now,
        now,
        actionId,
        fence,
        row.revision,
      ) as { changes: number };
      if (result.changes !== 1) throw new AppError("CONFLICT", "Runtime Action lease was lost before result commit", 409);
      await this.appendEvent(row.run_id, "action.result_committed", {
        actionId,
        fence,
        effectState: "applied",
        ...(resultRef === undefined ? {} : { resultRef }),
      }, now);
    });
  }

  private async fail(
    actionId: string,
    fence: number,
    code: string,
    effectState: Extract<RuntimeActionEffectState, "not_started" | "unknown">,
  ): Promise<void> {
    const now = Date.now();
    await this.database.transaction(async () => {
      const row = await this.requireRow(actionId);
      const result = await this.database.prepare(`
        UPDATE runtime_actions
        SET state = 'failed', lease_until = NULL, error_code = ?, effect_state = ?, revision = revision + 1,
            updated_at = ?, closed_at = ?
        WHERE id = ? AND state = 'dispatched' AND fence = ? AND revision = ?
      `).run(code, effectState, now, now, actionId, fence, row.revision) as { changes: number };
      if (result.changes !== 1) return;
      await this.appendEvent(row.run_id, "action.failed", { actionId, fence, code, effectState }, now);
    });
  }

  private async createRecoveryReview(input: {
    readonly runId: string;
    readonly planId?: string;
    readonly stepId?: string;
    readonly reason: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly replayPolicy: ReplayPolicy;
    readonly createdAt: number;
  }): Promise<string> {
    const id = randomUUID();
    const metadata = { reason: input.reason, ...(input.metadata ?? {}) };
    await this.database.prepare(`
      INSERT INTO runtime_actions(
        id, run_id, plan_id, step_id, kind, state, attempt, max_attempts,
        replay_policy, deadline_at, lease_until, fence, revision, metadata_json,
        effect_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'recovery_review', 'recovery_required', 0, 0,
                ?, NULL, NULL, 0, 1, ?, 'not_started', ?, ?)
    `).run(
      id,
      input.runId,
      input.planId ?? null,
      input.stepId ?? null,
      input.replayPolicy,
      JSON.stringify(metadata),
      input.createdAt,
      input.createdAt,
    );
    await this.appendEvent(input.runId, "action.created", {
      actionId: id,
      kind: "recovery_review",
      effectState: "not_started",
      ...(input.planId === undefined ? {} : { planId: input.planId }),
      ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    }, input.createdAt);
    await this.appendEvent(input.runId, "action.recovery_required", {
      actionId: id,
      reason: input.reason,
      ...(input.planId === undefined ? {} : { planId: input.planId }),
      ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    }, input.createdAt);
    await this.upsertRecoveryState(input.runId, id, "waiting_recovery", undefined, input.createdAt);
    return id;
  }

  private async upsertRecoveryState(
    runId: string,
    actionId: string,
    state: "waiting_recovery" | "waiting_user" | "ready_to_resume",
    question: string | undefined,
    now: number,
  ): Promise<void> {
    await this.database.prepare(`
      INSERT INTO run_recovery_states(run_id, state, action_id, question, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        state = excluded.state,
        action_id = excluded.action_id,
        question = excluded.question,
        updated_at = excluded.updated_at
    `).run(runId, state, actionId, question ?? null, now);
  }

  private async require(actionId: string): Promise<RuntimeActionRecord> {
    return toRuntimeActionRecord(await this.requireRow(actionId));
  }

  private async requireRow(actionId: string): Promise<RuntimeActionRow> {
    const row = await this.database.prepare("SELECT * FROM runtime_actions WHERE id = ?")
      .get(actionId) as RuntimeActionRow | undefined;
    if (row === undefined) throw new AppError("NOT_FOUND", "Runtime Action not found", 404);
    return row;
  }

  private async appendEvent(runId: string, type: string, data: Readonly<Record<string, unknown>>, createdAt: number): Promise<void> {
    const sequence = await this.database.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?",
    ).get(runId) as { seq: number };
    await this.database.prepare(`
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
    effectState: row.effect_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
  };
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : "INTERNAL_ERROR";
}

function stringMetadataField(metadataJson: string, key: string): string | undefined {
  try {
    const metadata = JSON.parse(metadataJson) as unknown;
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
    const value = (metadata as Record<string, unknown>)[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
