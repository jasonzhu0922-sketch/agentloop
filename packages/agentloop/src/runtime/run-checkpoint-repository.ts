import { randomUUID } from "node:crypto";
import type { SqlConnection } from "../storage/connection.ts";
import { AppError } from "../shared/errors.ts";

export interface RunCheckpointRecord {
  readonly id: string;
  readonly runId: string;
  readonly planId?: string;
  readonly actionId?: string;
  readonly reason: "execution_authority_lost";
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly childRunId?: string;
  readonly createdAt: number;
  readonly consumedAt?: number;
}

interface RunCheckpointRow {
  id: string;
  run_id: string;
  plan_id: string | null;
  action_id: string | null;
  reason: "execution_authority_lost";
  snapshot_json: string;
  child_run_id: string | null;
  created_at: number;
  consumed_at: number | null;
}

export class RunCheckpointRepository {
  private readonly database: SqlConnection;

  constructor(database: SqlConnection) {
    this.database = database;
  }

  async create(input: {
    runId: string;
    planId?: string;
    actionId?: string;
    snapshot: Readonly<Record<string, unknown>>;
    createdAt?: number;
  }): Promise<RunCheckpointRecord> {
    const id = randomUUID();
    const createdAt = input.createdAt ?? Date.now();
    await this.database.prepare(`
      INSERT INTO run_checkpoints(id, run_id, plan_id, action_id, reason, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, 'execution_authority_lost', ?, ?)
      ON CONFLICT(run_id) DO NOTHING
    `).run(
      id,
      input.runId,
      input.planId ?? null,
      input.actionId ?? null,
      JSON.stringify(input.snapshot),
      createdAt,
    );
    return await this.requireByRun(input.runId);
  }

  async getByRun(runId: string): Promise<RunCheckpointRecord | undefined> {
    const row = await this.database.prepare("SELECT * FROM run_checkpoints WHERE run_id = ?")
      .get(runId) as RunCheckpointRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  async get(id: string): Promise<RunCheckpointRecord | undefined> {
    const row = await this.database.prepare("SELECT * FROM run_checkpoints WHERE id = ?")
      .get(id) as RunCheckpointRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  async claim(id: string, now = Date.now()): Promise<RunCheckpointRecord> {
    const result = await this.database.prepare(`
      UPDATE run_checkpoints SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND child_run_id IS NULL
    `).run(now, id) as { changes: number };
    if (result.changes !== 1) throw new AppError("CONFLICT", "Checkpoint has already been started", 409);
    return await this.require(id);
  }

  async attachChild(id: string, childRunId: string): Promise<void> {
    const result = await this.database.prepare(`
      UPDATE run_checkpoints SET child_run_id = ?
      WHERE id = ? AND consumed_at IS NOT NULL AND child_run_id IS NULL
    `).run(childRunId, id) as { changes: number };
    if (result.changes !== 1) throw new AppError("CONFLICT", "Checkpoint continuation is no longer claimable", 409);
  }

  async releaseClaim(id: string): Promise<void> {
    await this.database.prepare(`
      UPDATE run_checkpoints SET consumed_at = NULL
      WHERE id = ? AND child_run_id IS NULL
    `).run(id);
  }

  private async require(id: string): Promise<RunCheckpointRecord> {
    const checkpoint = await this.get(id);
    if (checkpoint === undefined) throw new AppError("NOT_FOUND", "Run checkpoint not found", 404);
    return checkpoint;
  }

  private async requireByRun(runId: string): Promise<RunCheckpointRecord> {
    const checkpoint = await this.getByRun(runId);
    if (checkpoint === undefined) throw new AppError("NOT_FOUND", "Run checkpoint not found", 404);
    return checkpoint;
  }
}

function toRecord(row: RunCheckpointRow): RunCheckpointRecord {
  return {
    id: row.id,
    runId: row.run_id,
    ...(row.plan_id === null ? {} : { planId: row.plan_id }),
    ...(row.action_id === null ? {} : { actionId: row.action_id }),
    reason: row.reason,
    snapshot: JSON.parse(row.snapshot_json) as Readonly<Record<string, unknown>>,
    ...(row.child_run_id === null ? {} : { childRunId: row.child_run_id }),
    createdAt: row.created_at,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
  };
}
