import type { SqlConnection } from "../storage/connection.ts";
import { randomUUID } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import type { ToolResultRef, ToolResultStore } from "../storage/repositories/tool-result-store.ts";

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
const TOOL_OUTCOME_RECONCILIATION_LEASE_MS = 60_000;

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

export interface RuntimeToolOutcomeCommit {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
  readonly failurePhase?: "prepare" | "execute" | "runtime";
  readonly resultRef: ToolResultRef;
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
    resultRef?: (value: T) => string | undefined;
    toolOutcome?: (value: T) => RuntimeToolOutcomeCommit | undefined;
  }, operation: () => Promise<T>): Promise<T> {
    const action = await this.dispatch(input);
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      if (error instanceof AppError && error.code === "TOOL_RESULT_SERIALIZATION_FAILED") {
        await this.markRecoveryRequired(action.id, action.fence, error.code);
      } else {
        await this.fail(action.id, action.fence, errorCode(error));
      }
      throw error;
    }
    // A commit failure after operation() may follow a real external effect and
    // a durable blob write. Keep the Action dispatched for reconciliation;
    // never rewrite this uncertainty as action.failed/effect-not-observed.
    await this.succeed(action.id, action.fence, input.resultRef?.(value), input.toolOutcome?.(value));
    return value;
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
      await this.appendEvent(input.runId, "action.created", {
        actionId: id,
        kind: input.kind,
        planId: input.planId,
        stepId: input.stepId,
        replayPolicy: input.replayPolicy,
        deadlineAt,
      }, now);
      await this.appendEvent(input.runId, "action.leased", { actionId: id, fence: 1, leaseUntil: deadlineAt }, now);
      await this.appendEvent(input.runId, "action.dispatched", { actionId: id, fence: 1 }, now);
    });
    return await this.require(id);
  }

  async reconcileRunningRuns(): Promise<number> {
    const now = Date.now();
    let reconciled = 0;
    await this.database.transaction(async () => {
      const legacyRuns = await this.database.prepare(`
        SELECT id FROM runs
        WHERE status = 'running'
          AND created_at <= ?
          AND NOT EXISTS (SELECT 1 FROM runtime_actions WHERE runtime_actions.run_id = runs.id)
      `).all(now - LEGACY_ACTIONLESS_RUN_GRACE_MS) as unknown as Array<{ id: string }>;
      for (const run of legacyRuns) {
        await this.createRecoveryReview({
          runId: run.id,
          reason: "legacy_state_incomplete",
          replayPolicy: "unsafe",
          createdAt: now,
        });
        reconciled += 1;
      }

      const expired = await this.database.prepare(`
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
        const result = await this.database.prepare(`
          UPDATE runtime_actions
          SET state = 'recovery_required', lease_until = NULL, revision = revision + 1, updated_at = ?
          WHERE id = ? AND state = 'dispatched' AND fence = ? AND revision = ?
        `).run(now, action.id, action.fence, action.revision) as { changes: number };
        if (!oneRowChanged(result.changes)) continue;
        await this.appendEvent(action.run_id, "action.recovery_required", {
          actionId: action.id,
          fence: action.fence,
          reason,
        }, now);
        await this.upsertRecoveryState(action.run_id, action.id, "waiting_recovery", undefined, now);
        reconciled += 1;
      }
    });
    return reconciled;
  }

  /**
   * Finish the narrow crash window where immutable Tool bytes were stored but
   * the Action/outcome SQL transaction did not commit. This proves only that
   * the result bytes exist; it never infers that a missing blob means an
   * external effect did not happen.
   */
  async reconcileStoredToolOutcomes(store: ToolResultStore): Promise<number> {
    const rows = await this.database.prepare(`
      SELECT actions.id, actions.run_id, actions.fence, actions.revision, actions.metadata_json,
             runs.owner_user_id
      FROM runtime_actions AS actions
      JOIN runs ON runs.id = actions.run_id
      WHERE actions.kind = 'tool_call' AND actions.state = 'dispatched'
        AND (actions.deadline_at <= ? OR actions.lease_until <= ?)
      ORDER BY actions.created_at, actions.id
    `).all(Date.now(), Date.now()) as unknown as Array<{
      id: string; run_id: string; fence: number; revision: number; metadata_json: string; owner_user_id: string;
    }>;
    let reconciled = 0;
    for (const row of rows) {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const toolCallId = typeof metadata.toolCallId === "string" ? metadata.toolCallId : undefined;
      const toolName = typeof metadata.toolName === "string" ? metadata.toolName : undefined;
      if (toolCallId === undefined || toolName === undefined) continue;
      const stored = await store.findByToolCall({
        ownerUserId: row.owner_user_id,
        runId: row.run_id,
        toolCallId,
      });
      if (stored === undefined || stored.toolName !== toolName) continue;
      const claimedFence = await this.claimExpiredToolAction(row.id, row.fence, row.revision);
      if (claimedFence === undefined) continue;
      const maximum = safePreviewLimit(metadata.maxResultCharacters);
      const content = projectStoredResult(stored.content, maximum);
      await this.succeed(row.id, claimedFence, stored.locator, {
        toolCallId,
        toolName,
        content,
        isError: false,
        resultRef: stored,
      }, "tool_outcome_reconciled");
      reconciled += 1;
    }
    return reconciled;
  }

  private async claimExpiredToolAction(
    actionId: string,
    fence: number,
    revision: number,
  ): Promise<number | undefined> {
    const now = Date.now();
    const claimedFence = fence + 1;
    const result = await this.database.prepare(`
      UPDATE runtime_actions
      SET fence = ?, lease_until = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND kind = 'tool_call' AND state = 'dispatched'
        AND fence = ? AND revision = ?
        AND (deadline_at <= ? OR lease_until <= ?)
    `).run(
      claimedFence,
      now + TOOL_OUTCOME_RECONCILIATION_LEASE_MS,
      now,
      actionId,
      fence,
      revision,
      now,
      now,
    ) as { changes: number };
    return oneRowChanged(result.changes) ? claimedFence : undefined;
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
          SET state = 'failed', lease_until = NULL, error_code = ?, revision = revision + 1,
              updated_at = ?, closed_at = ?
          WHERE id = ? AND state = 'dispatched' AND revision = ?
        `).run(code, now, now, action.id, action.revision) as { changes: number };
        if (!oneRowChanged(result.changes)) continue;
        await this.appendEvent(runId, "action.failed", { actionId: action.id, fence: action.fence, code }, now);
        cancelled += 1;
      }
    });
    return cancelled;
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
  }, replayPolicy: ReplayPolicy): Promise<RuntimeActionRecord> {
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
        await this.upsertRecoveryState(input.runId, actionId, "waiting_recovery", undefined, now);
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
    });
    return await this.require(actionId);
  }

  private async succeed(
    actionId: string,
    fence: number,
    resultRef?: string,
    toolOutcome?: RuntimeToolOutcomeCommit,
    recoveryReason?: string,
  ): Promise<void> {
    const now = Date.now();
    await this.database.transaction(async () => {
      const row = await this.requireRow(actionId);
      const result = await this.database.prepare(`
        UPDATE runtime_actions
        SET state = 'succeeded', lease_until = NULL, revision = revision + 1,
            result_ref = ?, updated_at = ?, closed_at = ?
        WHERE id = ? AND state = 'dispatched' AND fence = ? AND revision = ?
      `).run(resultRef ?? null, now, now, actionId, fence, row.revision) as { changes: number };
      if (!oneRowChanged(result.changes)) {
        throw new AppError(
          "RUNTIME_ACTION_LEASE_LOST",
          "Runtime Action lease was lost before result commit",
          409,
          { actionId, fence },
        );
      }
      if (toolOutcome !== undefined) {
        if (row.kind !== "tool_call") throw new AppError("CONFLICT", "Only Tool Actions can commit Tool outcomes", 409);
        await this.database.prepare(`
          INSERT INTO tool_outcomes(
            run_id, tool_call_id, action_id, tool_name, content, is_error,
            failure_phase, result_locator, result_sha256, result_characters, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          row.run_id,
          toolOutcome.toolCallId,
          actionId,
          toolOutcome.toolName,
          toolOutcome.content,
          toolOutcome.isError ? 1 : 0,
          toolOutcome.failurePhase ?? null,
          toolOutcome.resultRef.locator,
          toolOutcome.resultRef.sha256,
          toolOutcome.resultRef.characters,
          now,
        );
        await this.appendEvent(row.run_id, "tool.outcome.committed", {
          actionId,
          toolCallId: toolOutcome.toolCallId,
          toolName: toolOutcome.toolName,
          content: toolOutcome.content,
          isError: toolOutcome.isError,
          ...(toolOutcome.failurePhase === undefined ? {} : { failurePhase: toolOutcome.failurePhase }),
          resultRef: toolOutcome.resultRef,
        }, now);
      }
      await this.appendEvent(row.run_id, "action.result_committed", {
        actionId,
        fence,
        ...(resultRef === undefined ? {} : { resultRef }),
      }, now);
      if (recoveryReason !== undefined) {
        await this.createRecoveryReview({
          runId: row.run_id,
          planId: row.plan_id ?? undefined,
          stepId: row.step_id ?? undefined,
          reason: recoveryReason,
          metadata: {
            reconciledActionId: actionId,
            reconciledFence: fence,
            ...(resultRef === undefined ? {} : { resultRef }),
          },
          replayPolicy: "unsafe",
          createdAt: now,
        });
      }
    });
  }

  private async fail(actionId: string, fence: number, code: string): Promise<void> {
    const now = Date.now();
    await this.database.transaction(async () => {
      const row = await this.requireRow(actionId);
      const result = await this.database.prepare(`
        UPDATE runtime_actions
        SET state = 'failed', lease_until = NULL, error_code = ?, revision = revision + 1,
            updated_at = ?, closed_at = ?
        WHERE id = ? AND state = 'dispatched' AND fence = ? AND revision = ?
      `).run(code, now, now, actionId, fence, row.revision) as { changes: number };
      if (!oneRowChanged(result.changes)) return;
      await this.appendEvent(row.run_id, "action.failed", { actionId, fence, code }, now);
    });
  }

  private async markRecoveryRequired(actionId: string, fence: number, reason: string): Promise<void> {
    const now = Date.now();
    await this.database.transaction(async () => {
      const row = await this.requireRow(actionId);
      const result = await this.database.prepare(`
        UPDATE runtime_actions
        SET state = 'recovery_required', lease_until = NULL, error_code = ?,
            revision = revision + 1, updated_at = ?
        WHERE id = ? AND state = 'dispatched' AND fence = ? AND revision = ?
      `).run(reason, now, actionId, fence, row.revision) as { changes: number };
      if (!oneRowChanged(result.changes)) return;
      await this.appendEvent(row.run_id, "action.recovery_required", { actionId, fence, reason }, now);
      await this.upsertRecoveryState(row.run_id, actionId, "waiting_recovery", undefined, now);
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
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'recovery_review', 'recovery_required', 0, 0,
                ?, NULL, NULL, 0, 1, ?, ?, ?)
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

function oneRowChanged(value: number | bigint): boolean {
  return value === 1 || value === 1n;
}

function safePreviewLimit(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : 50_000;
}

function projectStoredResult(content: string, maximum: number): string {
  if (content.length <= maximum) return content;
  const separator = "\n...[middle omitted from model view]...\n";
  const head = Math.ceil(maximum / 2);
  const tail = Math.floor(maximum / 2);
  return `${content.slice(0, head)}${separator}${content.slice(content.length - tail)}`;
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
