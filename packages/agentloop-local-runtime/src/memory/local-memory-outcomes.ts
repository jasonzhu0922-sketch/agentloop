import type { SqlConnection } from "@zhujun/agentloop";
import type { MemoryStore } from "@zhujun/agentloop-memory";

/** run_outcomes is the durable terminal outbox, written in the same transaction
 * as canonical completion. A notification is only an optimization. Acknowledge
 * each source position only after the idempotent Memory enqueue succeeds. */
export class LocalMemoryOutcomes {
  private readonly input: {
    readonly store: MemoryStore;
    readonly tenantId: string;
    readonly sources: () => readonly { readonly sourceId: string; readonly database: SqlConnection }[];
    readonly now?: () => number;
  };
  constructor(input: LocalMemoryOutcomes["input"]) { this.input = input; }

  async poll(): Promise<void> {
    for (const { sourceId, database } of this.input.sources()) {
      const key = `${this.input.tenantId}:outcomes:${sourceId}`;
      const saved = await this.input.store.feedbackCursor(key);
      const anchor = saved ? await database.prepare("SELECT run_id, result_ref, committed_at FROM run_outcomes WHERE rowid = ?")
        .get<{ run_id: string; result_ref: string | null; committed_at: number }>(saved.position) : undefined;
      const eventKey = (row: { run_id: string; result_ref: string | null; committed_at: number }) =>
        `${row.run_id}:${row.result_ref ?? row.committed_at}`;
      const cursor = saved && anchor && eventKey(anchor) === saved.eventKey ? saved.position : 0;
      const rows = await database.prepare(`SELECT outcome.rowid AS position, outcome.run_id, outcome.result_ref,
        outcome.committed_at, run.owner_user_id FROM run_outcomes outcome JOIN runs run ON run.id = outcome.run_id
        WHERE outcome.rowid > ? ORDER BY outcome.rowid LIMIT 100`)
        .all<{ position: number; run_id: string; result_ref: string | null; committed_at: number; owner_user_id: string }>(cursor);
      for (const row of rows) {
        await this.input.store.enqueueSettlement({
          scope: { tenantId: this.input.tenantId, ownerUserId: row.owner_user_id },
          runId: row.run_id, terminalCommitRef: row.result_ref ?? `${row.run_id}:${row.committed_at}`,
          now: this.input.now?.() ?? Date.now(),
        });
        await this.input.store.advanceFeedbackCursor(key, { position: row.position, eventKey: eventKey(row) });
      }
    }
  }
}
