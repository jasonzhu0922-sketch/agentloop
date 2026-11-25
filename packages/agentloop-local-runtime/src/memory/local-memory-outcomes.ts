import { runtimePersistence, type RuntimePersistenceInput } from "@zhujun/agentloop";
import type { MemoryStore } from "@zhujun/agentloop-memory";

/** run_outcomes is the durable terminal outbox, written in the same transaction
 * as canonical completion. A notification is only an optimization. Acknowledge
 * each source position only after the idempotent Memory enqueue succeeds. */
export class LocalMemoryOutcomes {
  private readonly input: {
    readonly store: MemoryStore;
    readonly tenantId: string;
    readonly sources: () => readonly { readonly sourceId: string; readonly database: RuntimePersistenceInput }[];
    readonly now?: () => number;
  };
  constructor(input: LocalMemoryOutcomes["input"]) { this.input = input; }

  async poll(): Promise<void> {
    for (const { sourceId, database } of this.input.sources()) {
      const state = runtimePersistence(database);
      let cursor: string | undefined;
      do {
        const page = await state.records.scan("run_outcomes", cursor, 100);
        cursor = page.cursor;
        for (const row of page.rows) {
          const key = `${this.input.tenantId}:outcomes:${sourceId}:${row.run_id}`;
          const eventKey = row.result_ref ?? `${row.run_id}:${row.committed_at}`;
          if ((await this.input.store.feedbackCursor(key))?.eventKey === eventKey) continue;
          const run = (await state.records.find("runs", { id: row.run_id }))[0];
          if (!run) continue;
          await this.input.store.enqueueSettlement({ scope: { tenantId: this.input.tenantId, ownerUserId: run.owner_user_id },
            runId: row.run_id, terminalCommitRef: eventKey, now: this.input.now?.() ?? Date.now() });
          await this.input.store.advanceFeedbackCursor(key, { position: 1, eventKey });
        }
      } while (cursor);
    }
  }
}
