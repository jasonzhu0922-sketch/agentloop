import type { SqlConnection } from "../connection.ts";

export type RunOutcomeStatus = "completed" | "failed" | "cancelled";

export class RunOutcomeRepository {
  private readonly connection: SqlConnection;

  constructor(connection: SqlConnection) {
    this.connection = connection;
  }

  /** Commit a successfully assessed Plan: mark plan/run completed and record the outcome, atomically. */
  commitCompleted(input: { runId: string; planId: string; output: string }): void {
    this.commitCompletedWithReason({ ...input, reasonCode: "plan_assessed_and_completed" });
  }

  /** Commit a completed run whose output carries explicit unresolved validation caveats. */
  commitCompletedWithDeferredValidation(input: { runId: string; planId: string; output: string }): void {
    this.commitCompletedWithReason({ ...input, reasonCode: "completed_with_deferred_validation" });
  }

  /** Commit a completed run whose output carries explicit unresolved quality or process caveats. */
  commitCompletedWithCaveats(input: { runId: string; planId: string; output: string; reasonCode: string }): void {
    this.commitCompletedWithReason(input);
  }

  private commitCompletedWithReason(input: { runId: string; planId: string; output: string; reasonCode: string }): void {
    const now = Date.now();
    this.connection.transaction(() => {
      this.connection.prepare("UPDATE plans SET status = 'completed', updated_at = ? WHERE id = ?")
        .run(now, input.planId);
      this.connection.prepare(`
        INSERT INTO run_outcomes(run_id, plan_id, status, output, reason_code, committed_at)
        VALUES (?, ?, 'completed', ?, ?, ?)
      `).run(input.runId, input.planId, input.output, input.reasonCode, now);
      this.connection.prepare(`
        UPDATE runs SET status = 'completed', output = ?, error_code = NULL, finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(input.output, now, input.runId);
    });
  }

  /** Commit a stopped run (failed/cancelled), optionally failing its Plan, atomically. */
  commitStopped(input: {
    runId: string;
    planId?: string;
    status: "failed" | "cancelled";
    reasonCode: string;
  }): void {
    const now = Date.now();
    this.connection.transaction(() => {
      if (input.planId !== undefined) {
        this.connection.prepare("UPDATE plans SET status = 'failed', updated_at = ? WHERE id = ?")
          .run(now, input.planId);
      }
      this.connection.prepare(`
        INSERT INTO run_outcomes(run_id, plan_id, status, output, reason_code, committed_at)
        VALUES (?, ?, ?, NULL, ?, ?)
      `).run(input.runId, input.planId ?? null, input.status, input.reasonCode, now);
      this.connection.prepare(`
        UPDATE runs SET status = ?, error_code = ?, finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(input.status, input.reasonCode, now, input.runId);
    });
  }
}
