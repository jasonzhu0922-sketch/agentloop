import { parseRoundScope } from "../planning/round-scope.ts";
import type { RoundScope } from "../planning/contracts.ts";
import { AppError } from "../shared/errors.ts";
import { ascending, runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../storage/runtime-records.ts";
import type { RuntimeResultRef } from "./runtime-result.ts";

export interface RoundResult {
  readonly schema: "agentloop.roundResult/v1";
  readonly runId: string;
  readonly roundNumber: number;
  readonly planId: string;
  readonly planVersion: number;
  readonly canonicalRevision: number;
  readonly roundScope?: RoundScope;
  readonly evidenceFingerprints?: readonly string[];
  readonly output: string;
  readonly reasonCode: string;
  readonly decision: { readonly kind: "complete_goal" | "next_round"; readonly canonicalRevision: number; readonly openGapIds?: readonly string[]; readonly openTargetIds?: readonly string[] };
  readonly steps: readonly { readonly stepId: string; readonly result: RuntimeResultRef; readonly assessmentId: string }[];
}

export interface RoundHistoryEntry {
  readonly roundScope?: RoundScope;
  readonly roundNumber: number;
  readonly status: string;
  readonly planId?: string;
  readonly revision: number;
  readonly result?: RoundResult;
}

export class RunRoundRepository {
  private readonly database: RuntimePersistence;

  constructor(database: RuntimePersistenceInput) {
    this.database = runtimePersistence(database);
  }

  async createInitial(runId: string, now: number): Promise<void> {
    await this.database.records.insert("run_rounds", { run_id: runId, round_number: 1, status: "planning", revision: 1, created_at: now, updated_at: now });
  }

  async bindPlan(runId: string, planId: string, now: number): Promise<void> {
    await this.database.transaction(async () => {
      const row = (await this.database.records.find("run_rounds", { run_id: runId, status: "planning", plan_id: null })).sort(ascending("round_number")).at(-1);
      if (!row) throw new AppError("CONFLICT", "Initial Round is no longer available for Plan admission", 409);
      await this.database.records.update("run_rounds", { run_id: runId, round_number: row.round_number }, value => ({ status: "executing" as const, plan_id: planId, revision: value.revision + 1, updated_at: now }));
    });
  }

  async commitResult(result: RoundResult, now: number): Promise<boolean> {
    return await this.database.transaction(async () => {
      const key = { run_id: result.runId, round_number: result.roundNumber };
      const round = (await this.database.records.find("run_rounds", key))[0];
      if (!round) return false;
      if (round.status !== "executing" || round.plan_id !== result.planId) throw new AppError("CONFLICT", "Round Result does not match the active Plan", 409);
      await this.database.records.insert("run_round_results", { ...key, plan_id: result.planId, canonical_revision: result.canonicalRevision, result_json: JSON.stringify(result), created_at: now });
      await this.database.records.update("run_rounds", key, row => ({ status: "completed" as const, revision: row.revision + 1, updated_at: now }));
      return true;
    });
  }

  async roundForPlan(runId: string, planId: string): Promise<number> {
    const row = (await this.database.records.find("run_rounds", { run_id: runId, plan_id: planId }))[0];
    if (!row) throw new AppError("NOT_FOUND", "Round for Plan not found", 404);
    return row.round_number;
  }

  async createNext(runId: string, previousRoundNumber: number, now: number): Promise<number> {
    return await this.database.transaction(async () => {
      const next = previousRoundNumber + 1;
      const existing = await this.database.records.find("run_rounds", { run_id: runId, round_number: next });
      const previous = (await this.database.records.find("run_rounds", { run_id: runId, round_number: previousRoundNumber }))[0];
      if (existing.length || previous?.status !== "completed") throw new AppError("CONFLICT", "Previous Round is not complete or the next Round already exists", 409);
      await this.database.records.insert("run_rounds", { run_id: runId, round_number: next, status: "planning", revision: 1, created_at: now, updated_at: now });
      return next;
    });
  }

  async list(runId: string): Promise<Array<{ readonly roundNumber: number; readonly status: string; readonly planId?: string; readonly revision: number }>> {
    const rows = (await this.database.records.find("run_rounds", { run_id: runId })).sort(ascending("round_number"));
    return rows.map((row) => ({ roundNumber: row.round_number, status: row.status, ...(row.plan_id === null ? {} : { planId: row.plan_id }), revision: row.revision }));
  }

  async history(runId: string): Promise<RoundHistoryEntry[]> {
    return await this.database.transaction(async () => {
      const rows = (await this.database.records.find("run_rounds", { run_id: runId })).sort(ascending("round_number"));
      const history: RoundHistoryEntry[] = [];
      for (const row of rows) {
        const plan = row.plan_id === null ? undefined : (await this.database.records.find("plans", { id: row.plan_id }))[0];
        const scope = !plan ? undefined : (await this.database.records.find("plan_round_scopes", { plan_id: plan.id, plan_version: plan.version }))[0];
        const result = await this.result(runId, row.round_number);
        history.push({ roundNumber: row.round_number, status: row.status, revision: row.revision,
          ...(row.plan_id === null ? {} : { planId: row.plan_id }), ...(scope ? { roundScope: parseRoundScope(JSON.parse(scope.scope_json)) } : {}),
          ...(result ? { result } : {}) });
      }
      return history;
    });
  }

  async assertNextAllowed(input: {
    readonly runId: string;
    readonly roundNumber: number;
    readonly maxRounds: number;
    readonly progressKey: string;
  }): Promise<void> {
    if (input.roundNumber >= input.maxRounds) {
      throw new AppError("ROUND_BUDGET_EXHAUSTED", `Run reached the maximum of ${input.maxRounds} Rounds`, 422);
    }
    const previous = (await this.database.records.find("run_round_results", { run_id: input.runId })).sort(ascending("round_number")).at(-1);
    if (previous === undefined) return;
    const result = JSON.parse(previous.result_json) as RoundResult;
    if (result.decision.kind !== "next_round") return;
    const previousKey = JSON.stringify({
      openGapIds: [...(result.decision.openGapIds ?? [])].sort(),
      openTargetIds: [...(result.decision.openTargetIds ?? [])].sort(),
      evidenceFingerprints: [...(result.evidenceFingerprints ?? [])].sort(),
    });
    if (previousKey === input.progressKey) {
      throw new AppError("ROUND_NO_PROGRESS", "The next Round would repeat the same unresolved state", 422, {
        roundNumber: input.roundNumber,
        maxRounds: input.maxRounds,
      });
    }
  }

  async result(runId: string, roundNumber: number): Promise<RoundResult | undefined> {
    const row = (await this.database.records.find("run_round_results", { run_id: runId, round_number: roundNumber }))[0];
    return row === undefined ? undefined : JSON.parse(row.result_json) as RoundResult;
  }

  async priorResultRefs(runId: string, currentPlanId: string): Promise<RuntimeResultRef[]> {
    const rows = (await this.database.records.find("run_round_results", { run_id: runId })).filter(row => row.plan_id !== currentPlanId).sort(ascending("round_number"));
    const seen = new Set<string>();
    const refs: RuntimeResultRef[] = [];
    for (const row of rows) {
      const result = JSON.parse(row.result_json) as RoundResult;
      for (const step of result.steps) {
        if (seen.has(step.result.resultId)) continue;
        seen.add(step.result.resultId);
        refs.push(step.result);
      }
    }
    return refs;
  }

  /** Historical Runs have no Round row and continue through the legacy path. */
  async finish(runId: string, status: "completed" | "failed" | "cancelled", now: number): Promise<void> {
    await this.database.transaction(async () => {
      const row = (await this.database.records.find("run_rounds", { run_id: runId })).filter(row => row.status === "planning" || row.status === "executing").sort(ascending("round_number")).at(-1);
      if (row) await this.database.records.update("run_rounds", { run_id: runId, round_number: row.round_number }, value => ({ status, revision: value.revision + 1, updated_at: now }));
    });
  }
}
