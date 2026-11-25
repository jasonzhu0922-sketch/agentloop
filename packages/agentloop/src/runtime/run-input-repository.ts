import { randomUUID } from "node:crypto";
import { ascending, runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../storage/runtime-records.ts";
import { appendRunEvent } from "../storage/repositories/run-event-sequencer.ts";
import { AppError, badRequest, notFound } from "../shared/errors.ts";

export type RunInputStatus = "accepted" | "processing" | "applied" | "answered" | "needs_clarification" | "unprocessed";
export interface RunInputMessage {
  readonly id: string;
  readonly runId: string;
  readonly conversationId?: string;
  readonly requestId: string;
  readonly seq: number;
  readonly text: string;
  readonly status: RunInputStatus;
  readonly decision?: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}
interface Row {
  id: string; run_id: string; conversation_id: string | null; request_id: string;
  seq: number; text: string; status: string; decision_json: string | null;
  created_at: number; updated_at: number;
}
interface Control { received_seq: number; consumed_seq: number; lease_token: string | null; lease_until: number | null }
const project = (row: Row): RunInputMessage => ({ id: row.id, runId: row.run_id,
  ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }), requestId: row.request_id,
  seq: Number(row.seq), text: row.text, status: row.status as RunInputStatus,
  ...(row.decision_json === null ? {} : { decision: JSON.parse(row.decision_json) }),
  createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });

/** Durable ordering shared by input acceptance, Action dispatch and terminal/Round commits. */
export class RunInputRepository {
  private readonly db: RuntimePersistence;
  constructor(db: RuntimePersistenceInput) { this.db = runtimePersistence(db); }

  async lock(runId: string): Promise<Control> {
    return await this.db.transaction(async () => {
      await this.db.records.insert("run_input_controls", { run_id: runId, revision: 0, received_seq: 0, consumed_seq: 0 }, "ignore");
      await this.db.records.update("run_input_controls", { run_id: runId }, row => ({ revision: row.revision + 1 }));
      return (await this.db.records.find("run_input_controls", { run_id: runId }))[0]!;
    });
  }

  async accept(owner: string, runId: string, input: { requestId: string; text: string }): Promise<RunInputMessage> {
    if (typeof input.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId)) throw badRequest("requestId must be a stable identifier of at most 128 characters");
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 16_000) throw badRequest("text must contain 1 to 16000 characters");
    return await this.db.transaction(async () => {
      const ownerRun = (await this.db.records.find("runs", { id: runId }))[0];
      if (ownerRun?.owner_user_id !== owner) throw notFound("Run");
      const control = await this.lock(runId);
      const existing = (await this.db.records.find("run_input_messages", { run_id: runId, request_id: input.requestId }))[0];
      if (existing !== undefined) {
        if (existing.text !== input.text) throw new AppError("CONFLICT", "requestId already belongs to different text", 409);
        return project(existing);
      }
      const run = (await this.db.records.find("runs", { id: runId }))[0];
      if (run?.status !== "running") throw new AppError("CONFLICT", "Run is terminal; keep this message in the draft queue", 409, { reason: "run_terminal" });
      const now = Date.now(), seq = Number(control.received_seq) + 1, id = randomUUID();
      await this.db.records.insert("run_input_messages", { id, run_id: runId, owner_user_id: owner, conversation_id: run.conversation_id,
        request_id: input.requestId, seq, text: input.text, status: "accepted", created_at: now, updated_at: now });
      await this.db.records.update("run_input_controls", { run_id: runId }, () => ({ received_seq: seq }));
      const message: RunInputMessage = { id, runId, ...(run.conversation_id === null ? {} : { conversationId: run.conversation_id }), requestId: input.requestId, seq, text: input.text, status: "accepted", createdAt: now, updatedAt: now };
      await appendRunEvent(this.db, runId, { type: "run.input.accepted", data: { message }, createdAt: now });
      return message;
    });
  }

  async list(runId: string, afterSeq = 0): Promise<RunInputMessage[]> {
    return (await this.db.records.find("run_input_messages", { run_id: runId })).filter(row => row.seq > afterSeq).sort(ascending("seq")).map(project);
  }

  /** Must be called inside the transaction which dispatches or commits. */
  async assertDrained(runId: string): Promise<void> {
    const control = await this.lock(runId);
    if (Number(control.received_seq) !== Number(control.consumed_seq)) throw new AppError("STEER_PENDING", "Run has unprocessed user input", 409);
  }

  async checkpoint(runId: string): Promise<void> {
    await this.db.transaction(async () => { await this.assertDrained(runId); });
  }

  async claim(runId: string, token: string, now = Date.now()): Promise<RunInputMessage | undefined> {
    return await this.db.transaction(async () => {
      const control = await this.lock(runId);
      if (Number(control.received_seq) === Number(control.consumed_seq)) return undefined;
      if (control.lease_token !== null && control.lease_token !== token && Number(control.lease_until) > now) throw new AppError("CONFLICT", "Run input is owned by another consumer", 409);
      const run = (await this.db.records.find("runs", { id: runId }))[0];
      if (run?.status !== "running") return undefined;
      const row = (await this.db.records.find("run_input_messages", { run_id: runId, seq: Number(control.consumed_seq) + 1 }))[0]!;
      await this.db.records.update("run_input_controls", { run_id: runId }, () => ({ lease_token: token, lease_until: now + 300_000 }));
      await this.db.records.update("run_input_messages", { id: row.id }, () => ({ status: "processing", updated_at: now }));
      return project({ ...row, status: "processing", updated_at: now });
    });
  }

  async renew(runId: string, token: string): Promise<void> {
    const now = Date.now();
    const changed = await this.db.records.update("run_input_controls", { run_id: runId, lease_token: token }, row =>
      Number(row.lease_until) > now ? { lease_until: now + 300_000 } : undefined);
    if (changed !== 1) throw new AppError("CONFLICT", "Run input lease was lost", 409);
  }

  /** Failed semantic work has no committed decision; a later worker can retry it. */
  async release(runId: string, token: string): Promise<void> {
    await this.db.transaction(async () => {
      const control = await this.lock(runId);
      if (control.lease_token !== token) return;
      await this.db.records.update("run_input_messages", { run_id: runId, status: "processing" }, () => ({ status: "accepted", updated_at: Date.now() }));
      await this.db.records.update("run_input_controls", { run_id: runId, lease_token: token }, () => ({ lease_token: null, lease_until: null }));
    });
  }

  /** Invoke canonical/Plan writes in the same transaction as this consumption decision. */
  async finish(message: RunInputMessage, token: string, status: Exclude<RunInputStatus, "accepted" | "processing" | "unprocessed">,
    decision: Readonly<Record<string, unknown>>, commit?: () => Promise<void>): Promise<void> {
    await this.db.transaction(async () => {
      const control = await this.lock(message.runId);
      if (control.lease_token !== token || Number(control.lease_until) <= Date.now() || Number(control.consumed_seq) + 1 !== message.seq) throw new AppError("CONFLICT", "Run input lease or sequence is stale", 409);
      const run = (await this.db.records.find("runs", { id: message.runId }))[0];
      if (run?.status !== "running") throw new AppError("CONFLICT", "Run stopped before input decision", 409);
      await commit?.();
      const now = Date.now();
      await this.db.records.update("run_input_messages", { id: message.id }, () => ({ status, decision_json: JSON.stringify(decision), updated_at: now }));
      await this.db.records.update("run_input_controls", { run_id: message.runId }, () => ({ consumed_seq: message.seq, lease_token: null, lease_until: null }));
      await appendRunEvent(this.db, message.runId, { type: "run.input.decided", data: { message: { ...message, status, decision, updatedAt: now } }, createdAt: now });
    });
  }

  async stop(runId: string, reason: string): Promise<void> {
    await this.db.transaction(async () => {
    const control = await this.lock(runId);
    const now = Date.now();
    for (const message of (await this.list(runId)).filter(m => m.status === "accepted" || m.status === "processing")) {
      const decision = { reason };
      await this.db.records.update("run_input_messages", { id: message.id }, () => ({ status: "unprocessed", decision_json: JSON.stringify(decision), updated_at: now }));
      await appendRunEvent(this.db, runId, { type: "run.input.decided", data: { message: { ...message, status: "unprocessed", decision, updatedAt: now } }, createdAt: now });
    }
    await this.db.records.update("run_input_controls", { run_id: runId }, () => ({ consumed_seq: control.received_seq, lease_token: null, lease_until: null }));
    });
  }
}
