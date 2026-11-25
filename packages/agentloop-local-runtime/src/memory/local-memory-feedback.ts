import { runtimePersistence, ascending, type RuntimePersistenceInput } from "@zhujun/agentloop";
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
    readonly sources: () => readonly { readonly sourceId: string; readonly database: RuntimePersistenceInput }[];
    readonly now?: () => number;
  };
  constructor(input: LocalMemoryFeedback["input"]) { this.input = input; }

  async poll(): Promise<void> {
    const sources = this.input.sources();
    for (const { sourceId, database } of sources) {
      const state = runtimePersistence(database);
      let cursor: string | undefined;
      do {
      const page = await state.records.scan("runs", cursor, 100); cursor = page.cursor;
      for (const sourceRun of page.rows) {
      const key = `${this.input.tenantId}:${sourceId}:${sourceRun.id}`;
      const saved = await this.input.store.feedbackCursor(key);
      const events = (await state.records.find("run_events", { run_id: sourceRun.id }))
        .filter(event => event.seq > (saved?.position ?? 0) && ["conversation.outcome.disputed", "conversation.outcome.superseded"].includes(event.type)).sort(ascending("seq"));
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
          const source = sourceRun;
          let target: { owner_user_id: string; result_ref: string | null; committed_at: number } | undefined;
          if (source.conversation_id) for (const candidate of sources) {
            const candidateState = runtimePersistence(candidate.database);
            const run = (await candidateState.records.find("runs", { id: targetRunId, owner_user_id: source.owner_user_id, conversation_id: source.conversation_id }))[0];
            const outcome = run && (await candidateState.records.find("run_outcomes", { run_id: run.id }))[0];
            if (run && outcome) { target = { ...outcome, owner_user_id: run.owner_user_id }; break; }
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
        await this.input.store.advanceFeedbackCursor(key, { position: event.seq, eventKey: `${event.run_id}:${event.seq}` });
      }
      }
      } while (cursor);
    }
  }
}
