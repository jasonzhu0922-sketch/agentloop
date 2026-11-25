import { randomUUID } from "node:crypto";
import { runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../storage/runtime-records.ts";
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
  private readonly database: RuntimePersistence;

  constructor(database: RuntimePersistenceInput) {
    this.database = runtimePersistence(database);
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
    await this.database.records.insert("run_checkpoints", { id, run_id: input.runId, plan_id: input.planId ?? null,
      action_id: input.actionId ?? null, reason: "execution_authority_lost", snapshot_json: JSON.stringify(input.snapshot), created_at: createdAt }, "ignore");
    return await this.requireByRun(input.runId);
  }

  async getByRun(runId: string): Promise<RunCheckpointRecord | undefined> {
    const row = (await this.database.records.find("run_checkpoints", { run_id: runId }))[0];
    return row === undefined ? undefined : toRecord(row);
  }

  async get(id: string): Promise<RunCheckpointRecord | undefined> {
    const row = (await this.database.records.find("run_checkpoints", { id }))[0];
    return row === undefined ? undefined : toRecord(row);
  }

  async claim(id: string, now = Date.now()): Promise<RunCheckpointRecord> {
    const changed = await this.database.records.update("run_checkpoints", { id, consumed_at: null, child_run_id: null }, () => ({ consumed_at: now }));
    if (changed !== 1) throw new AppError("CONFLICT", "Checkpoint has already been started", 409);
    return await this.require(id);
  }

  async attachChild(id: string, childRunId: string): Promise<void> {
    const changed = await this.database.records.update("run_checkpoints", { id, child_run_id: null }, row => row.consumed_at !== null ? { child_run_id: childRunId } : undefined);
    if (changed !== 1) throw new AppError("CONFLICT", "Checkpoint continuation is no longer claimable", 409);
  }

  async releaseClaim(id: string): Promise<void> {
    await this.database.records.update("run_checkpoints", { id, child_run_id: null }, () => ({ consumed_at: null }));
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
