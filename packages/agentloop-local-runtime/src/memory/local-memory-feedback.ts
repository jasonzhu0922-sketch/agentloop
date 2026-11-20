import type { SqlConnection } from "@zhujun/agentloop";
import { reconcileMemoryFeedback, type MemoryStore } from "@zhujun/agentloop-memory";
import { LocalMemorySettlementReader } from "./local-memory-settlement-reader.ts";
import { memoryFeedbackEffect } from "./local-memory-feedback-semantics.ts";

/** Incrementally reads durable canonical feedback. The Memory cursor advances
 * only after revocation and replay scheduling; a crash safely repeats the event.
 * Source IDs must be stable per account/Runtime database, never array positions. */
export class LocalMemoryFeedback {
  private readonly input: {
    readonly store: MemoryStore;
    readonly tenantId: string;
    readonly sources: () => readonly { readonly sourceId: string; readonly database: SqlConnection }[];
    readonly now?: () => number;
  };
  constructor(input: LocalMemoryFeedback["input"]) { this.input = input; }

  async poll(): Promise<void> {
    const sources = this.input.sources();
    for (const { sourceId, database } of sources) {
      const key = `${this.input.tenantId}:${sourceId}`;
      const saved = await this.input.store.feedbackCursor(key);
      const anchor = saved ? await database.prepare("SELECT run_id, seq FROM run_events WHERE rowid = ?").get<{ run_id: string; seq: number }>(saved.position) : undefined;
      // SQLite may reuse rowids after deleting Runs. Never skip a new event
      // just because its reused rowid is below a deleted cursor anchor.
      const cursor = saved && anchor && `${anchor.run_id}:${anchor.seq}` === saved.eventKey ? saved.position : 0;
      const events = await database.prepare(`SELECT rowid AS cursor, run_id, seq, type, payload_json FROM run_events
        WHERE rowid > ? AND type IN ('conversation.outcome.disputed', 'conversation.outcome.superseded')
        ORDER BY rowid LIMIT 100`).all<{ cursor: number; run_id: string; seq: number; type: string; payload_json: string }>(cursor);
      for (const event of events) {
        let targetRunId: unknown;
        let effect: ReturnType<typeof memoryFeedbackEffect> = "unknown";
        try {
          const payload = JSON.parse(event.payload_json);
          if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            targetRunId = payload.targetRunId;
            effect = memoryFeedbackEffect(event.type, payload);
          }
        } catch { /* Invalid evidence cannot nominate a target. */ }
        if (["disputed", "corrected"].includes(effect) && typeof targetRunId === "string" && targetRunId !== event.run_id) {
          // Target must belong to the same owner AND conversation. Payloads
          // cannot select another user's or another chat's remembered result.
          const source = await database.prepare("SELECT owner_user_id, conversation_id FROM runs WHERE id = ?")
            .get<{ owner_user_id: string; conversation_id: string | null }>(event.run_id);
          let target: { owner_user_id: string; result_ref: string | null; committed_at: number } | undefined;
          if (source?.conversation_id) for (const candidate of sources) {
            target = await candidate.database.prepare(`SELECT target.owner_user_id, outcome.result_ref, outcome.committed_at
              FROM runs target JOIN run_outcomes outcome ON outcome.run_id = target.id
              WHERE target.id = ? AND target.owner_user_id = ? AND target.conversation_id = ?`)
              .get<typeof target>(targetRunId, source.owner_user_id, source.conversation_id);
            if (target) break;
          }
          if (target) {
            const scope = { tenantId: this.input.tenantId, ownerUserId: target.owner_user_id };
            // Fence out older publications immediately, including a worker
            // currently processing an otherwise successful evidence snapshot.
            await this.input.store.invalidateRun(scope, targetRunId,
              { type: "user_feedback", runId: event.run_id, sourceId: `${event.run_id}:${event.seq}` }, this.input.now?.() ?? Date.now());
            const jobs = await this.input.store.settlementJobs(scope, targetRunId);
            // A busy outbox must finish its current snapshot before replay.
            // Leave the cursor here so the event is retried after it finishes.
            if (jobs.some(job => job.status === "processing")) break;
            const evidence = await new LocalMemorySettlementReader(() => sources.map(source => source.database), this.input.tenantId).read({
              ...scope, runId: targetRunId, terminalCommitRef: target.result_ref ?? `${targetRunId}:${target.committed_at}`,
            });
            if (evidence) {
              await reconcileMemoryFeedback(this.input.store, evidence, this.input.now?.() ?? Date.now());
              await this.input.store.replaySettlement(scope, targetRunId, this.input.now?.() ?? Date.now());
            }
          }
        }
        await this.input.store.advanceFeedbackCursor(key, { position: event.cursor, eventKey: `${event.run_id}:${event.seq}` });
      }
    }
  }
}
