import { AppError } from "../shared/errors.ts";
import { runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../storage/runtime-records.ts";
import type { RuntimeRows } from "../storage/runtime-record-schema.ts";

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
  private readonly database: RuntimePersistence;
  constructor(database: RuntimePersistenceInput) { this.database = runtimePersistence(database); }

  async get(runId: string): Promise<PlanningRecoveryRecord | undefined> {
    const row = (await this.database.records.find("run_planning_recovery", { run_id: runId }))[0];
    if (!row) return undefined;
    if (row.failure_phase !== null && row.failure_phase !== "intent" && row.failure_phase !== "plan") throw new TypeError("Invalid planning recovery phase");
    return { ...row, failure_phase: row.failure_phase };
  }

  async create(runId: string, context: unknown, now: number): Promise<void> {
    await this.database.records.insert("run_planning_recovery", { run_id: runId, state: "prepared", context_json: JSON.stringify(context), revision: 1, updated_at: now });
  }

  private async change(runId: string, now: number, predicate: (row: RuntimeRows["run_planning_recovery"]) => boolean,
    patch: Partial<RuntimeRows["run_planning_recovery"]> | ((row: RuntimeRows["run_planning_recovery"]) => Partial<RuntimeRows["run_planning_recovery"]>),
    error?: string, running = false): Promise<boolean> {
    return await this.database.transaction(async () => {
      if (running && !(await this.database.records.find("runs", { id: runId, status: "running" })).length) {
        if (error) throw new AppError("CONFLICT", error, 409);
        return false;
      }
      const changed = await this.database.records.update("run_planning_recovery", { run_id: runId }, row => predicate(row) ?
        { revision: row.revision + 1, updated_at: now, ...(typeof patch === "function" ? patch(row) : patch) } : undefined);
      if (changed !== 1 && error) throw new AppError("CONFLICT", error, 409);
      return changed === 1;
    });
  }

  async updateContext(runId: string, context: unknown, now: number): Promise<void> {
    await this.change(runId, now, row => row.state === "prepared" || row.state === "resuming",
      { context_json: JSON.stringify(context) }, "Planning recovery context is no longer mutable");
  }

  async prepareNextRound(runId: string, context: unknown, now: number): Promise<void> {
    await this.change(runId, now, row => row.state === "completed", { state: "resuming", context_json: JSON.stringify(context),
      failure_phase: null, error_code: null, request_id: null, lease_token: null, lease_until: null, resume_attempts: 0 }, "Run cannot start another planning Round");
  }

  async wait(runId: string, phase: "intent" | "plan", code: string, requestId: string, now: number): Promise<void> {
    await this.change(runId, now, row => row.state === "prepared" || row.state === "resuming",
      { state: "waiting", failure_phase: phase, error_code: code, request_id: requestId, lease_token: null, lease_until: null },
      "Planning recovery cannot enter waiting state", true);
  }

  async claim(runId: string, requestId: string, now: number): Promise<void> {
    await this.change(runId, now, row => row.state === "waiting" && row.request_id === requestId && row.resume_attempts < 1,
      row => ({ state: "resuming", resume_attempts: row.resume_attempts + 1 }), "Planning recovery is no longer actionable", true);
  }

  async finish(runId: string, state: "completed" | "cancelled", now: number): Promise<void> {
    await this.change(runId, now, row => ["prepared", "waiting", "resuming"].includes(row.state), { state });
  }

  async resumeInput(runId: string, requestId: string, now: number): Promise<void> {
    await this.change(runId, now, row => row.state === "waiting" && row.request_id === requestId && row.error_code === "RUN_INPUT_CLARIFICATION",
      { state: "resuming" }, "Input clarification is no longer actionable");
  }

  async acquireLease(runId: string, token: string, now: number, duration: number): Promise<boolean> {
    return await this.change(runId, now, row => row.state === "resuming" && (row.lease_until === null || row.lease_until <= now),
      { lease_token: token, lease_until: now + duration }, undefined, true);
  }

  async renewLease(runId: string, token: string, now: number, duration: number): Promise<boolean> {
    return await this.change(runId, now, row => row.state === "resuming" && row.lease_token === token && Number(row.lease_until) > now,
      row => ({ lease_until: now + duration, revision: row.revision }));
  }

  async guardLease(runId: string, token: string, now: number): Promise<void> {
    await this.change(runId, now, row => row.state === "resuming" && row.lease_token === token && Number(row.lease_until) > now,
      {}, "Planning recovery lease was lost");
  }

  async finishLease(runId: string, token: string, now: number): Promise<void> {
    await this.change(runId, now, row => row.state === "resuming" && row.lease_token === token && Number(row.lease_until) > now,
      { state: "completed", lease_token: null, lease_until: null }, "Planning recovery lease was lost");
  }
}
