import type { SqlConnection } from "../connection.ts";
import type { RuntimeResultRecord } from "../../runtime/runtime-result.ts";

export type RunOutcomeStatus = "completed" | "failed" | "cancelled";

export class RunOutcomeRepository {
  private readonly connection: SqlConnection;

  constructor(connection: SqlConnection) {
    this.connection = connection;
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
      await this.connection.prepare("UPDATE plans SET status = 'completed', updated_at = ? WHERE id = ?")
        .run(now, input.planId);
      await this.connection.prepare(`
        INSERT INTO run_outcomes(run_id, plan_id, status, output, result_ref, result_json, reason_code, committed_at)
        VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)
      `).run(input.runId, input.planId, output, input.result.ref.resultId, JSON.stringify(input.result), input.reasonCode, now);
      await this.connection.prepare(`
        UPDATE runs SET status = 'completed', output = ?, error_code = NULL, finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(output, now, input.runId);
      await this.connection.prepare("DELETE FROM run_recovery_states WHERE run_id = ?")
        .run(input.runId);
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
      if (input.planId !== undefined) {
        await this.connection.prepare("UPDATE plans SET status = 'failed', updated_at = ? WHERE id = ?")
          .run(now, input.planId);
      }
      await this.connection.prepare(`
        INSERT INTO run_outcomes(run_id, plan_id, status, output, reason_code, committed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.runId, input.planId ?? null, input.status, output, input.reasonCode, now);
      await this.connection.prepare(`
        UPDATE runs SET status = ?, output = ?, error_code = ?, finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(input.status, output, input.reasonCode, now, input.runId);
      await this.connection.prepare("DELETE FROM run_recovery_states WHERE run_id = ?")
        .run(input.runId);
    });
  }
}
