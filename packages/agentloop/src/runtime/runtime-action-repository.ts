import { RunInputRepository } from "./run-input-repository.ts";
import { ascending, recordTransaction, runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../storage/runtime-records.ts";
import { appendRunEvent, appendRunEvents } from "../storage/repositories/run-event-sequencer.ts";
import { randomUUID } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import {
  failureEffectState,
  failedResultEffectState,
  type RuntimeActionEffectState,
} from "./action-effect.ts";
import type { RuntimeResultRecord } from "./runtime-result.ts";
import { runtimePerformanceSpan, withRuntimePerformanceContext } from "../diagnostics/runtime-performance.ts";

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
  private readonly database: RuntimePersistence;

  private readonly flushPendingEvents?: (runId: string) => Promise<void>;

  constructor(database: RuntimePersistenceInput, flushPendingEvents?: (runId: string) => Promise<void>) {
    this.database = runtimePersistence(database);
    this.flushPendingEvents = flushPendingEvents;
  }

  async list(runId: string): Promise<RuntimeActionRecord[]> {
    const rows = (await this.database.records.find("runtime_actions", { run_id: runId })).sort(ascending("created_at", "id"));
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
    /** A completed operation receipt may prove its effect boundary despite an operation failure. */
    resultFailureEffectState?: (value: unknown) => RuntimeActionEffectState;
    /** Commit an observed return value with its Action, including operation failures. */
    prepareResult?: (value: T, action: RuntimeActionRecord) => Promise<RuntimeResultRecord>;
    /**
     * Observability hook invoked after the Action and lease are durable, but
     * before the operation begins. It lets an operation correlate its own
     * progress events with the Action that owns it.
     */
    onDispatched?: (action: RuntimeActionRecord) => Promise<void> | void;
  }, operation: () => Promise<T>): Promise<T> {
    const toolCallId = typeof input.metadata?.toolCallId === "string" ? input.metadata.toolCallId : undefined;
    return await withRuntimePerformanceContext({
      runId: input.runId, stepId: input.stepId, toolCallId,
      ...(typeof input.metadata?.requestId === "string" ? { requestId: input.metadata.requestId } : {}),
    }, async () => {
      const action = await runtimePerformanceSpan("action.dispatch", {
        category: "action", actionKind: input.kind, replayPolicy: input.replayPolicy,
        ...(typeof input.metadata?.toolName === "string" ? { toolName: input.metadata.toolName } : {}),
      }, async () => await this.dispatch(input));
      return await withRuntimePerformanceContext({ actionId: action.id }, async () => {
        try {
          await runtimePerformanceSpan("action.on_dispatched", { category: "action", actionKind: input.kind },
            async () => await input.onDispatched?.(action));
          const value = await runtimePerformanceSpan(input.kind === "tool_call" ? "tool.function" : "action.operation", {
            category: input.kind === "tool_call" ? "tool" : "action", actionKind: input.kind,
            ...(typeof input.metadata?.toolName === "string" ? { toolName: input.metadata.toolName } : {}),
          }, operation);
          const resultFailureCode = input.resultFailureCode?.(value);
          const result = await runtimePerformanceSpan("action.prepare_result", { category: "action", actionKind: input.kind },
            async () => await input.prepareResult?.(value, action));
          await this.flushPendingEvents?.(input.runId);
          await runtimePerformanceSpan("action.commit_result", { category: "action", actionKind: input.kind }, async () =>
            await this.commitResult(action.id, action.fence, result, resultFailureCode === undefined ? undefined : {
              code: resultFailureCode,
              effectState: input.resultFailureEffectState?.(value) ?? failedResultEffectState(value),
            }));
          return value;
        } catch (error) {
          await runtimePerformanceSpan("action.fail", { category: "action", actionKind: input.kind, code: errorCode(error) },
            async () => await this.fail(action.id, action.fence, errorCode(error), failureEffectState(error)));
          throw error;
        }
      });
    });
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
    await this.flushPendingEvents?.(input.runId);
    const id = randomUUID();
    const now = Date.now();
    const deadlineAt = now + input.deadlineMs;
    const metadata = input.metadata ?? {};
    await recordTransaction(this.database, async () => {
      if (input.kind === "tool_call") await new RunInputRepository(this.database).assertDrained(input.runId);
      const run = (await this.database.records.find("runs", { id: input.runId }))[0];
      if (run === undefined || run.status !== "running") {
        throw new AppError("CONFLICT", "Cannot dispatch an Action for a terminal Run", 409);
      }
      await this.database.records.insert("runtime_actions", { id, run_id: input.runId, plan_id: input.planId ?? null, step_id: input.stepId ?? null,
        kind: input.kind, state: "dispatched", attempt: 1, max_attempts: 1, replay_policy: input.replayPolicy, deadline_at: deadlineAt,
        lease_until: deadlineAt, fence: 1, revision: 1, metadata_json: JSON.stringify(metadata), effect_state: "not_started", created_at: now, updated_at: now });
      await appendRunEvents(this.database, input.runId, [
        { type: "action.created", data: {
          actionId: id, kind: input.kind, planId: input.planId, stepId: input.stepId,
          replayPolicy: input.replayPolicy, effectState: "not_started", deadlineAt,
        }, createdAt: now },
        { type: "action.leased", data: { actionId: id, fence: 1, leaseUntil: deadlineAt }, createdAt: now },
        { type: "action.dispatched", data: { actionId: id, fence: 1 }, createdAt: now },
      ]);
    });
    return await this.require(id);
  }

  async reconcileRunningRuns(runIds?: readonly string[]): Promise<InterruptedRunRecord[]> {
    const candidates = runIds === undefined ? (await this.database.records.find("runs", { status: "running" })).map(row => row.id) : [...new Set(runIds)];
    const now = Date.now(), interrupted: InterruptedRunRecord[] = [];
    // Each Run is its own reconciliation unit. Never hold unrelated Runs across persistence I/O.
    for (const runId of candidates) await this.database.transaction(async () => {
      const run = (await this.database.records.find("runs", { id: runId, status: "running" }))[0];
      if (!run || (await this.database.records.find("run_planning_recovery", { run_id: runId, state: "resuming" })).length) return;
      const actions = await this.database.records.find("runtime_actions", { run_id: runId });
      if (run.created_at <= now - LEGACY_ACTIONLESS_RUN_GRACE_MS && (!actions.length ||
        (!(await this.database.records.find("canonical_run_states", { run_id: runId })).length && !actions.some(row => row.state === "dispatched" || row.state === "recovery_required")))) {
        interrupted.push({ runId, reason: "legacy_state_incomplete" });
      }
      const recovery = (await this.database.records.find("run_recovery_states", { run_id: runId }))[0];
      for (const action of actions) {
        const expired = action.state === "dispatched" && ((action.deadline_at !== null && action.deadline_at <= now) || (action.lease_until !== null && action.lease_until <= now));
        const stranded = action.state === "failed" && action.error_code === "EXECUTION_AUTHORITY_LOST";
        const legacyPaused = action.state === "recovery_required" && recovery?.action_id === action.id && recovery.state === "waiting_recovery";
        const legacyReason = stringMetadataField(action.metadata_json, "reason");
        if (!expired && !stranded && (!legacyPaused || legacyReason === "assessment_failed_boundary" || legacyReason === "human_loop_requested")) continue;
        if (!stranded) {
          await this.database.records.update("runtime_actions", { id: action.id, state: action.state, fence: action.fence, revision: action.revision }, row =>
            ({ state: "failed" as const, lease_until: expired ? null : row.lease_until, error_code: "EXECUTION_AUTHORITY_LOST", effect_state: "unknown" as const,
              revision: row.revision + 1, updated_at: now, closed_at: now }));
          if (legacyPaused) await this.database.records.remove("run_recovery_states", { run_id: runId, action_id: action.id });
          await this.appendEvent(runId, "action.interrupted", { actionId: action.id, fence: action.fence,
            reason: legacyPaused ? legacyReason ?? "worker_lease_expired" : action.deadline_at !== null && action.deadline_at <= now ? "deadline_expired" : "worker_lease_expired",
            ...(legacyPaused ? { migratedFrom: "waiting_recovery" } : {}), effectState: "unknown" }, now);
        }
        interrupted.push({ runId, actionId: action.id, ...(action.plan_id === null ? {} : { planId: action.plan_id }),
          ...(action.step_id === null ? {} : { stepId: action.step_id }), replayPolicy: action.replay_policy, fence: action.fence,
          reason: legacyPaused ? legacyReason === "legacy_state_incomplete" ? "legacy_state_incomplete" : "worker_lease_expired" :
            action.deadline_at !== null && action.deadline_at <= now ? "deadline_expired" : "worker_lease_expired" });
      }
    });
    return interrupted;
  }

  async cancelDispatchedForRun(runId: string, code = "CANCELLED"): Promise<number> {
    const now = Date.now();
    let cancelled = 0;
    await this.database.transaction(async () => {
      const actions = await this.database.records.find("runtime_actions", { run_id: runId, state: "dispatched" });
      for (const action of actions) {
        const changed = await this.database.records.update("runtime_actions", { id: action.id, state: "dispatched", revision: action.revision }, row =>
          ({ state: "failed" as const, lease_until: null, error_code: code, effect_state: "unknown" as const, revision: row.revision + 1, updated_at: now, closed_at: now }));
        if (changed !== 1) continue;
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
      const changed = await this.database.records.update("runtime_actions", { id: actionId, kind: "recovery_review", state: "recovery_required", revision: row.revision }, value =>
        ({ state: "succeeded" as const, revision: value.revision + 1, updated_at: now, closed_at: now }));
      if (changed !== 1) throw new AppError("CONFLICT", "Recovery review is no longer pending", 409);
      await this.appendEvent(row.run_id, "action.result_committed", { actionId, fence: row.fence, effectState: "applied" }, now);
    });
  }

  async requireRecoveryReview(input: {
    readonly runId: string;
    readonly planId?: string;
    readonly stepId?: string;
    readonly reason: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly replayPolicy?: ReplayPolicy;
  }): Promise<RuntimeActionRecord> {
    return this.requireRecoveryReviewWithPolicy(input, input.replayPolicy ?? "unsafe");
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

  /**
   * A resumed Step can itself pause for new human input.  That is a new
   * recovery boundary, not a second use of the Action that resumed the prior
   * Step.  Rotate the durable Action atomically so the new request always
   * resumes the Step that actually asked for it.
   */
  async replaceRecoveryReviewWithHumanLoopResume(input: {
    readonly previousActionId: string;
    readonly runId: string;
    readonly planId?: string;
    readonly stepId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<RuntimeActionRecord> {
    const now = Date.now();
    let actionId = "";
    await this.database.transaction(async () => {
      const previous = await this.requireRow(input.previousActionId);
      if (
        previous.run_id !== input.runId
        || previous.kind !== "recovery_review"
        || previous.state !== "recovery_required"
      ) {
        throw new AppError("CONFLICT", "Recovery review is no longer pending for Human-in-the-Loop replacement", 409);
      }
      const changed = await this.database.records.update("runtime_actions", { id: previous.id, kind: "recovery_review", state: "recovery_required", revision: previous.revision }, value =>
        ({ state: "succeeded" as const, revision: value.revision + 1, updated_at: now, closed_at: now }));
      if (changed !== 1) throw new AppError("CONFLICT", "Recovery review changed before Human-in-the-Loop replacement", 409);
      await this.appendEvent(previous.run_id, "action.result_committed", {
        actionId: previous.id,
        fence: previous.fence,
        effectState: "applied",
      }, now);
      actionId = await this.createRecoveryReview({
        runId: input.runId,
        planId: input.planId,
        stepId: input.stepId,
        reason: "human_loop_requested",
        metadata: input.metadata,
        replayPolicy: "safe",
        createdAt: now,
      });
    });
    return await this.require(actionId);
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
      const existing = (await this.database.records.find("runtime_actions", { run_id: input.runId, state: "recovery_required" })).sort(ascending("created_at")).at(-1);
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
        await this.database.records.remove("run_recovery_states", { run_id: input.runId, action_id: actionId });
      }
    });
    return await this.require(actionId);
  }

  private async commitResult(actionId: string, fence: number, runtimeResult?: RuntimeResultRecord,
    failure?: { readonly code: string; readonly effectState: RuntimeActionEffectState }): Promise<void> {
    const now = Date.now();
    await recordTransaction(this.database, async () => {
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
      const effectState = failure?.effectState ?? "applied";
      const changed = await this.database.records.update("runtime_actions", { id: actionId, state: "dispatched", fence, revision: row.revision }, value =>
        ({ state: failure === undefined ? "succeeded" as const : "failed" as const, lease_until: null, error_code: failure?.code ?? null, effect_state: effectState,
          result_ref: resultRef ?? null, metadata_json: JSON.stringify(runtimeResult === undefined ? metadata : { ...metadata, runtimeResult }),
          revision: value.revision + 1, updated_at: now, closed_at: now }));
      if (changed !== 1) throw new AppError("CONFLICT", "Runtime Action lease was lost before result commit", 409);
      await this.appendEvent(row.run_id, failure === undefined ? "action.result_committed" : "action.failed", {
        actionId,
        fence,
        effectState,
        ...(failure === undefined ? {} : { code: failure.code }),
        ...(resultRef === undefined ? {} : { resultRef }),
      }, now);
    });
  }

  private async fail(
    actionId: string,
    fence: number,
    code: string,
    effectState: RuntimeActionEffectState,
  ): Promise<void> {
    const now = Date.now();
    await recordTransaction(this.database, async () => {
      const row = await this.requireRow(actionId);
      const changed = await this.database.records.update("runtime_actions", { id: actionId, state: "dispatched", fence, revision: row.revision }, value =>
        ({ state: "failed" as const, lease_until: null, error_code: code, effect_state: effectState, revision: value.revision + 1, updated_at: now, closed_at: now }));
      if (changed !== 1) return;
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
    await this.database.records.insert("runtime_actions", { id, run_id: input.runId, plan_id: input.planId ?? null, step_id: input.stepId ?? null,
      kind: "recovery_review", state: "recovery_required", attempt: 0, max_attempts: 0, replay_policy: input.replayPolicy, fence: 0, revision: 1,
      metadata_json: JSON.stringify(metadata), effect_state: "not_started", created_at: input.createdAt, updated_at: input.createdAt });
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
    await this.database.records.insert("run_recovery_states", { run_id: runId, state, action_id: actionId, question: question ?? null, updated_at: now }, "replace");
  }

  private async require(actionId: string): Promise<RuntimeActionRecord> {
    return toRuntimeActionRecord(await this.requireRow(actionId));
  }

  private async requireRow(actionId: string): Promise<RuntimeActionRow> {
    const row = (await this.database.records.find("runtime_actions", { id: actionId }))[0];
    if (row === undefined) throw new AppError("NOT_FOUND", "Runtime Action not found", 404);
    return row;
  }

  private async appendEvent(runId: string, type: string, data: Readonly<Record<string, unknown>>, createdAt: number): Promise<void> {
    await appendRunEvent(this.database, runId, { type, data, createdAt });
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
