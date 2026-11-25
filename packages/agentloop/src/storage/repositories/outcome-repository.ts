import { runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../runtime-records.ts";
import { AppError } from "../../shared/errors.ts";
import type { RuntimeResultRecord } from "../../runtime/runtime-result.ts";

export type RunOutcomeStatus = "completed" | "failed" | "cancelled";

export class RunOutcomeRepository {
  private readonly connection: RuntimePersistence;

  constructor(connection: RuntimePersistenceInput) {
    this.connection = runtimePersistence(connection);
  }

  /** Commit a successfully assessed Plan: mark plan/run completed and record the outcome, atomically. */
  async commitCompleted(input: { runId: string; planId: string; result: RuntimeResultRecord }): Promise<void> {
    await this.commitCompletedWithReason({ ...input, reasonCode: "plan_assessed_and_completed" });
  }

  /** Commit a completed run whose output carries explicit unresolved validation caveats. */
  async commitCompletedWithDeferredValidation(input: { runId: string; planId: string; result: RuntimeResultRecord }): Promise<void> {
    await this.commitCompletedWithReason({ ...input, reasonCode: "completed_with_deferred_validation" });
  }

  /** Commit a completed run whose output carries explicit unresolved quality or process caveats. */
  async commitCompletedWithCaveats(input: { runId: string; planId: string; result: RuntimeResultRecord; reasonCode: string }): Promise<void> {
    await this.commitCompletedWithReason(input);
  }

  private async commitCompletedWithReason(input: { runId: string; planId: string; result: RuntimeResultRecord; reasonCode: string }): Promise<void> {
    const now = Date.now();
    if (
      input.result.kind !== "run"
      || input.result.publication.status !== "published"
      || input.result.producer.runId !== input.runId
      || input.result.producer.planId !== input.planId
    ) throw new TypeError("Run outcome requires a matching published Runtime result");
    const output = input.result.payload.content;
    await this.connection.transaction(async () => {
      await this.assertRunning(input.runId, input.planId);
      await this.connection.records.update("plans", { id: input.planId }, () => ({ status: "completed" as const, updated_at: now }));
      await this.connection.records.insert("run_outcomes", { run_id: input.runId, plan_id: input.planId, status: "completed", output,
        result_ref: input.result.ref.resultId, result_json: JSON.stringify(input.result), reason_code: input.reasonCode, committed_at: now });
      await this.connection.records.update("runs", { id: input.runId, status: "running" }, () => ({ status: "completed" as const, output, error_code: null, finished_at: now }));
      await this.connection.records.remove("run_recovery_states", { run_id: input.runId });
    });
  }

  /** Commit a stopped run (failed/cancelled), optionally failing its Plan, atomically. */
  async commitStopped(input: {
    runId: string;
    planId?: string;
    status: "failed" | "cancelled";
    reasonCode: string;
    output?: string;
  }): Promise<void> {
    const now = Date.now();
    const output = input.status === "failed" ? input.output ?? null : null;
    await this.connection.transaction(async () => {
      await this.assertRunning(input.runId, input.planId);
      if (input.planId !== undefined) await this.connection.records.update("plans", { id: input.planId }, () => ({ status: "failed" as const, updated_at: now }));
      await this.connection.records.insert("run_outcomes", { run_id: input.runId, plan_id: input.planId ?? null, status: input.status, output, reason_code: input.reasonCode, committed_at: now });
      await this.connection.records.update("runs", { id: input.runId, status: "running" }, () => ({ status: input.status, output, error_code: input.reasonCode, finished_at: now }));
      await this.connection.records.remove("run_recovery_states", { run_id: input.runId });
    });
  }
  private async assertRunning(runId: string, planId?: string): Promise<void> {
    const run = (await this.connection.records.find("runs", { id: runId }))[0];
    if (run?.status !== "running") throw new AppError("CONFLICT", "Run is already terminal", 409);
    if (planId !== undefined && !(await this.connection.records.find("plans", { id: planId, run_id: runId })).length) {
      throw new AppError("CONFLICT", "Outcome Plan belongs to another Run", 409);
    }
  }

}
