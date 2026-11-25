import { ascending, runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../runtime-records.ts";
import { AppError } from "../../shared/errors.ts";

/** Host admission receipts participate in the same transaction as Kernel Run creation. */
export class RuntimeHostStateRepository {
  private readonly state: RuntimePersistence;
  private readonly scope: string;
  constructor(state: RuntimePersistenceInput, scope: string) { this.state = runtimePersistence(state); this.scope = scope; }
  async request(requestId: string): Promise<{ fingerprint: string; runId: string } | undefined> {
    const row = (await this.state.records.find("runtime_requests", { scope: this.scope, request_id: requestId }))[0];
    return row ? { fingerprint: row.fingerprint, runId: row.run_id } : undefined;
  }
  async admit(input: { requestId: string; fingerprint: string; runId: string; ownerUserId: string; conversationId: string; maxConcurrentRuns?: number; runtimeId?: string }): Promise<void> {
    await this.state.transaction(async () => {
      const runs = await this.state.records.find("runs", { owner_user_id: input.ownerUserId, status: "running" });
      if (runs.some(row => row.id !== input.runId && row.conversation_id === input.conversationId)) throw new AppError("CONFLICT", "Conversation has another active Run", 409);
      const paused = new Set<string>();
      for (const run of runs) if ((await this.state.records.find("human_loop_requests", { run_id: run.id, status: "open" })).length) paused.add(run.id);
      if (input.maxConcurrentRuns !== undefined && runs.filter(row => !paused.has(row.id)).length > input.maxConcurrentRuns) throw new AppError("CONFLICT", "Runtime admission capacity reached", 429);
      if (input.runtimeId) await this.state.records.insert("runtime_executors", { remote_run_id: input.runId, runtime_id: input.runtimeId,
        dispatch_key: `${this.scope}:${input.requestId}`, owner_user_id: input.ownerUserId, accepted_at: Date.now() });
      await this.state.records.insert("runtime_requests", { scope: this.scope, request_id: input.requestId, fingerprint: input.fingerprint, run_id: input.runId });
    });
  }
  async observe(input: { id: string; category: string; createdAt: number; payload: unknown }, create = false): Promise<void> {
    const row = { scope: this.scope, id: input.id, category: input.category, created_at: input.createdAt, payload_json: JSON.stringify(input.payload) };
    if (create) await this.state.records.insert("runtime_observations", row);
    else await this.state.records.update("runtime_observations", { scope: this.scope, id: input.id, category: input.category }, () => row);
  }
  async observations(limit = 50): Promise<unknown[]> {
    const rows = (await this.state.records.find("runtime_observations", { scope: this.scope })).sort(ascending("created_at", "id")).reverse().slice(0, Math.max(1, Math.min(100, Math.trunc(limit))));
    return rows.map(row => JSON.parse(row.payload_json));
  }
  async observation(id: string): Promise<unknown | undefined> {
    const row = (await this.state.records.find("runtime_observations", { scope: this.scope, id }))[0];
    return row ? JSON.parse(row.payload_json) : undefined;
  }
}
