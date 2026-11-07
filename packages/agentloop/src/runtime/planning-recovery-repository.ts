import { AppError } from "../shared/errors.ts";
import type { SqlConnection } from "../storage/connection.ts";

export interface PlanningRecoveryRecord {
  readonly run_id: string;
  readonly state: "prepared" | "waiting" | "resuming" | "completed" | "cancelled";
  readonly context_json: string;
  readonly failure_phase: "intent" | "plan" | null;
  readonly error_code: string | null;
  readonly request_id: string | null;
  readonly resume_attempts: number;
  readonly lease_token: string | null;
  readonly lease_until: number | null;
  readonly revision: number;
}

export class PlanningRecoveryRepository {
  private readonly database: SqlConnection;
  constructor(database: SqlConnection) { this.database = database; }

  async get(runId: string): Promise<PlanningRecoveryRecord | undefined> {
    return await this.database.prepare("SELECT * FROM run_planning_recovery WHERE run_id = ?").get<PlanningRecoveryRecord>(runId);
  }

  async create(runId: string, context: unknown, now: number): Promise<void> {
    await this.database.prepare(`INSERT INTO run_planning_recovery(run_id, state, context_json, revision, updated_at)
      VALUES (?, 'prepared', ?, 1, ?)` ).run(runId, JSON.stringify(context), now);
  }

  async updateContext(runId: string, context: unknown, now: number): Promise<void> {
    const result = await this.database.prepare(`UPDATE run_planning_recovery
      SET context_json = ?, revision = revision + 1, updated_at = ?
      WHERE run_id = ? AND state IN ('prepared', 'resuming')`).run(JSON.stringify(context), now, runId);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Planning recovery context is no longer mutable", 409);
  }

  async prepareNextRound(runId: string, context: unknown, now: number): Promise<void> {
    const result = await this.database.prepare(`UPDATE run_planning_recovery
      SET state = 'resuming', context_json = ?, failure_phase = NULL, error_code = NULL,
          request_id = NULL, lease_token = NULL, lease_until = NULL, resume_attempts = 0,
          revision = revision + 1, updated_at = ?
      WHERE run_id = ? AND state = 'completed'`).run(JSON.stringify(context), now, runId);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Run cannot start another planning Round", 409);
  }

  async wait(runId: string, phase: "intent" | "plan", code: string, requestId: string, now: number): Promise<void> {
    const result = await this.database.prepare(`UPDATE run_planning_recovery
      SET state = 'waiting', failure_phase = ?, error_code = ?, request_id = ?, revision = revision + 1, updated_at = ?
          , lease_token = NULL, lease_until = NULL
      WHERE run_id = ? AND state IN ('prepared', 'resuming')
        AND EXISTS (SELECT 1 FROM runs WHERE runs.id = run_planning_recovery.run_id AND runs.status = 'running')`)
      .run(phase, code, requestId, now, runId);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Planning recovery cannot enter waiting state", 409);
  }

  async claim(runId: string, requestId: string, now: number): Promise<void> {
    const result = await this.database.prepare(`UPDATE run_planning_recovery
      SET state = 'resuming', resume_attempts = resume_attempts + 1, revision = revision + 1, updated_at = ?
      WHERE run_id = ? AND state = 'waiting' AND request_id = ? AND resume_attempts < 1
        AND EXISTS (SELECT 1 FROM runs WHERE runs.id = run_planning_recovery.run_id AND runs.status = 'running')`)
      .run(now, runId, requestId);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Planning recovery is no longer actionable", 409);
  }

  async finish(runId: string, state: "completed" | "cancelled", now: number): Promise<void> {
    await this.database.prepare(`UPDATE run_planning_recovery SET state = ?, revision = revision + 1, updated_at = ?
      WHERE run_id = ? AND state IN ('prepared', 'waiting', 'resuming')`).run(state, now, runId);
  }

  async acquireLease(runId: string, token: string, now: number, duration: number): Promise<boolean> {
    const result = await this.database.prepare(`UPDATE run_planning_recovery
      SET lease_token = ?, lease_until = ?, revision = revision + 1, updated_at = ?
      WHERE run_id = ? AND state = 'resuming' AND (lease_until IS NULL OR lease_until <= ?)
        AND EXISTS (SELECT 1 FROM runs WHERE runs.id = run_planning_recovery.run_id AND runs.status = 'running')`)
      .run(token, now + duration, now, runId, now);
    return result.changes === 1;
  }

  async renewLease(runId: string, token: string, now: number, duration: number): Promise<boolean> {
    const result = await this.database.prepare(`UPDATE run_planning_recovery SET lease_until = ?, updated_at = ?
      WHERE run_id = ? AND state = 'resuming' AND lease_token = ? AND lease_until > ?`)
      .run(now + duration, now, runId, token, now);
    return result.changes === 1;
  }

  async guardLease(runId: string, token: string, now: number): Promise<void> {
    const result = await this.database.prepare(`UPDATE run_planning_recovery SET revision = revision + 1, updated_at = ?
      WHERE run_id = ? AND state = 'resuming' AND lease_token = ? AND lease_until > ?`)
      .run(now, runId, token, now);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Planning recovery lease was lost", 409);
  }

  async finishLease(runId: string, token: string, now: number): Promise<void> {
    const result = await this.database.prepare(`UPDATE run_planning_recovery
      SET state = 'completed', lease_token = NULL, lease_until = NULL, revision = revision + 1, updated_at = ?
      WHERE run_id = ? AND state = 'resuming' AND lease_token = ? AND lease_until > ?`)
      .run(now, runId, token, now);
    if (result.changes !== 1) throw new AppError("CONFLICT", "Planning recovery lease was lost", 409);
  }
}
