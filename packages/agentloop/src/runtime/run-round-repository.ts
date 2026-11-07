import { AppError } from "../shared/errors.ts";
import type { SqlConnection } from "../storage/connection.ts";
import type { RuntimeResultRef } from "./runtime-result.ts";

export interface RoundResult {
  readonly schema: "agentloop.roundResult/v1";
  readonly runId: string;
  readonly roundNumber: number;
  readonly planId: string;
  readonly planVersion: number;
  readonly canonicalRevision: number;
  readonly output: string;
  readonly reasonCode: string;
  readonly decision: { readonly kind: "complete_goal" | "next_round"; readonly canonicalRevision: number; readonly openGapIds?: readonly string[]; readonly openTargetIds?: readonly string[] };
  readonly steps: readonly { readonly stepId: string; readonly result: RuntimeResultRef; readonly assessmentId: string }[];
}

export interface RoundHistoryEntry {
  readonly roundNumber: number;
  readonly status: string;
  readonly planId?: string;
  readonly revision: number;
  readonly result?: RoundResult;
}

export class RunRoundRepository {
  private readonly database: SqlConnection;

  constructor(database: SqlConnection) {
    this.database = database;
  }

  async createInitial(runId: string, now: number): Promise<void> {
    await this.database.prepare(`
      INSERT INTO run_rounds(run_id, round_number, status, revision, created_at, updated_at)
      VALUES (?, 1, 'planning', 1, ?, ?)
    `).run(runId, now, now);
  }

  async bindPlan(runId: string, planId: string, now: number): Promise<void> {
    const result = await this.database.prepare(`
      UPDATE run_rounds SET status = 'executing', plan_id = ?, revision = revision + 1, updated_at = ?
      WHERE run_id = ? AND status = 'planning' AND plan_id IS NULL
        AND round_number = (SELECT MAX(round_number) FROM run_rounds WHERE run_id = ? AND status = 'planning' AND plan_id IS NULL)
    `).run(planId, now, runId, runId);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Initial Round is no longer available for Plan admission", 409);
  }

  async commitResult(result: RoundResult, now: number): Promise<boolean> {
    const round = await this.database.prepare("SELECT status, plan_id FROM run_rounds WHERE run_id = ? AND round_number = ?")
      .get<{ status: string; plan_id: string | null }>(result.runId, result.roundNumber);
    if (round === undefined) return false;
    if (round.status !== "executing" || round.plan_id !== result.planId) {
      throw new AppError("CONFLICT", "Round Result does not match the active Plan", 409);
    }
    await this.database.prepare(`INSERT INTO run_round_results
      (run_id, round_number, plan_id, canonical_revision, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(result.runId, result.roundNumber, result.planId, result.canonicalRevision, JSON.stringify(result), now);
    await this.database.prepare(`UPDATE run_rounds SET status = 'completed', revision = revision + 1, updated_at = ?
      WHERE run_id = ? AND round_number = ? AND status = 'executing'`).run(now, result.runId, result.roundNumber);
    return true;
  }

  async roundForPlan(runId: string, planId: string): Promise<number> {
    const row = await this.database.prepare("SELECT round_number FROM run_rounds WHERE run_id = ? AND plan_id = ?")
      .get<{ round_number: number }>(runId, planId);
    if (row === undefined) throw new AppError("NOT_FOUND", "Round for Plan not found", 404);
    return row.round_number;
  }

  async createNext(runId: string, previousRoundNumber: number, now: number): Promise<number> {
    const next = previousRoundNumber + 1;
    const existing = await this.database.prepare("SELECT round_number FROM run_rounds WHERE run_id = ? AND round_number = ?")
      .get(runId, next);
    if (existing !== undefined) throw new AppError("CONFLICT", "The next Round already exists", 409);
    const result = await this.database.prepare(`INSERT INTO run_rounds(run_id, round_number, status, revision, created_at, updated_at)
      SELECT run_id, ?, 'planning', 1, ?, ? FROM run_rounds
      WHERE run_id = ? AND round_number = ? AND status = 'completed'`).run(next, now, now, runId, previousRoundNumber);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Previous Round is not complete or the next Round already exists", 409);
    return next;
  }

  async list(runId: string): Promise<Array<{ readonly roundNumber: number; readonly status: string; readonly planId?: string; readonly revision: number }>> {
    const rows = await this.database.prepare(`SELECT round_number, status, plan_id, revision
      FROM run_rounds WHERE run_id = ? ORDER BY round_number`).all(runId) as unknown as Array<{ round_number: number; status: string; plan_id: string | null; revision: number }>;
    return rows.map((row) => ({ roundNumber: row.round_number, status: row.status, ...(row.plan_id === null ? {} : { planId: row.plan_id }), revision: row.revision }));
  }

  async history(runId: string): Promise<RoundHistoryEntry[]> {
    const rows = await this.database.prepare(`SELECT r.round_number, r.status, r.plan_id, r.revision,
        rr.result_json
      FROM run_rounds r
      LEFT JOIN run_round_results rr
        ON rr.run_id = r.run_id AND rr.round_number = r.round_number
      WHERE r.run_id = ? ORDER BY r.round_number`).all(runId) as unknown as Array<{
        round_number: number; status: string; plan_id: string | null; revision: number; result_json: string | null;
      }>;
    return rows.map((row) => ({
      roundNumber: row.round_number,
      status: row.status,
      ...(row.plan_id === null ? {} : { planId: row.plan_id }),
      revision: row.revision,
      ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as RoundResult }),
    }));
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
    const previous = await this.database.prepare(`SELECT result_json FROM run_round_results
      WHERE run_id = ? ORDER BY round_number DESC LIMIT 1`).get<{ result_json: string }>(input.runId);
    if (previous === undefined) return;
    const result = JSON.parse(previous.result_json) as RoundResult;
    if (result.decision.kind !== "next_round") return;
    const previousKey = JSON.stringify({
      openGapIds: [...(result.decision.openGapIds ?? [])].sort(),
      openTargetIds: [...(result.decision.openTargetIds ?? [])].sort(),
      resultIds: result.steps.map((step) => step.result.resultId).sort(),
    });
    if (previousKey === input.progressKey) {
      throw new AppError("ROUND_NO_PROGRESS", "The next Round would repeat the same unresolved state", 422, {
        roundNumber: input.roundNumber,
        maxRounds: input.maxRounds,
      });
    }
  }

  async result(runId: string, roundNumber: number): Promise<RoundResult | undefined> {
    const row = await this.database.prepare("SELECT result_json FROM run_round_results WHERE run_id = ? AND round_number = ?")
      .get<{ result_json: string }>(runId, roundNumber);
    return row === undefined ? undefined : JSON.parse(row.result_json) as RoundResult;
  }

  async priorResultRefs(runId: string, currentPlanId: string): Promise<RuntimeResultRef[]> {
    const rows = await this.database.prepare(`SELECT result_json FROM run_round_results
      WHERE run_id = ? AND plan_id <> ? ORDER BY round_number`).all(runId, currentPlanId) as unknown as Array<{ result_json: string }>;
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
    await this.database.prepare(`
      UPDATE run_rounds SET status = ?, revision = revision + 1, updated_at = ?
      WHERE run_id = ? AND status IN ('planning', 'executing')
        AND round_number = (SELECT MAX(round_number) FROM run_rounds WHERE run_id = ? AND status IN ('planning', 'executing'))
    `).run(status, now, runId, runId);
  }
}
