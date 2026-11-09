import { randomUUID } from "node:crypto";
import type { SqlConnection } from "../storage/connection.ts";
import { insertIfAbsentSql } from "../storage/dialect-sql.ts";
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
  seq: number; text: string; status: RunInputStatus; decision_json: string | null;
  created_at: number; updated_at: number;
}
interface Control { received_seq: number; consumed_seq: number; lease_token: string | null; lease_until: number | null }
const project = (row: Row): RunInputMessage => ({ id: row.id, runId: row.run_id,
  ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }), requestId: row.request_id,
  seq: Number(row.seq), text: row.text, status: row.status,
  ...(row.decision_json === null ? {} : { decision: JSON.parse(row.decision_json) }),
  createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });

/** Durable ordering shared by input acceptance, Action dispatch and terminal/Round commits. */
export class RunInputRepository {
  private readonly db: SqlConnection;
  constructor(db: SqlConnection) { this.db = db; }

  async lock(runId: string): Promise<Control> {
    await this.db.prepare(insertIfAbsentSql({ dialect: this.db.dialect,
      insert: "INSERT INTO run_input_controls(run_id, revision, received_seq, consumed_seq) VALUES (?, 0, 0, 0)", keyColumn: "run_id" })).run(runId);
    await this.db.prepare("UPDATE run_input_controls SET revision = revision + 1 WHERE run_id = ?").run(runId);
    // Locking reads are current reads on TiDB, even under repeatable read.
    return (await this.db.prepare(`SELECT received_seq, consumed_seq, lease_token, lease_until FROM run_input_controls WHERE run_id = ?${this.db.dialect === "sqlite" ? "" : " FOR UPDATE"}`)
      .get<Control>(runId))!;
  }

  async accept(owner: string, runId: string, input: { requestId: string; text: string }): Promise<RunInputMessage> {
    if (typeof input.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId)) throw badRequest("requestId must be a stable identifier of at most 128 characters");
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 16_000) throw badRequest("text must contain 1 to 16000 characters");
    return await this.db.transaction(async () => {
      const ownerRun = await this.db.prepare("SELECT owner_user_id FROM runs WHERE id = ?").get<{ owner_user_id: string }>(runId);
      if (ownerRun?.owner_user_id !== owner) throw notFound("Run");
      const control = await this.lock(runId);
      const existing = await this.db.prepare(`SELECT * FROM run_input_messages WHERE run_id = ? AND request_id = ?${this.db.dialect === "sqlite" ? "" : " FOR UPDATE"}`).get<Row>(runId, input.requestId);
      if (existing !== undefined) {
        if (existing.text !== input.text) throw new AppError("CONFLICT", "requestId already belongs to different text", 409);
        return project(existing);
      }
      const run = await this.db.prepare(`SELECT status, conversation_id FROM runs WHERE id = ?${this.db.dialect === "sqlite" ? "" : " FOR UPDATE"}`)
        .get<{ status: string; conversation_id: string | null }>(runId);
      if (run?.status !== "running") throw new AppError("CONFLICT", "Run is terminal; keep this message in the draft queue", 409, { reason: "run_terminal" });
      const now = Date.now(), seq = Number(control.received_seq) + 1, id = randomUUID();
      await this.db.prepare(`INSERT INTO run_input_messages(id, run_id, owner_user_id, conversation_id, request_id, seq, text, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`).run(id, runId, owner, run.conversation_id, input.requestId, seq, input.text, now, now);
      await this.db.prepare("UPDATE run_input_controls SET received_seq = ? WHERE run_id = ?").run(seq, runId);
      const message: RunInputMessage = { id, runId, ...(run.conversation_id === null ? {} : { conversationId: run.conversation_id }), requestId: input.requestId, seq, text: input.text, status: "accepted", createdAt: now, updatedAt: now };
      await appendRunEvent(this.db, runId, { type: "run.input.accepted", data: { message }, createdAt: now });
      return message;
    });
  }

  async list(runId: string, afterSeq = 0): Promise<RunInputMessage[]> {
    return (await this.db.prepare("SELECT * FROM run_input_messages WHERE run_id = ? AND seq > ? ORDER BY seq").all<Row>(runId, afterSeq)).map(project);
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
      const run = await this.db.prepare(`SELECT status FROM runs WHERE id = ?${this.db.dialect === "sqlite" ? "" : " FOR UPDATE"}`).get<{ status: string }>(runId);
      if (run?.status !== "running") return undefined;
      const row = (await this.db.prepare(`SELECT * FROM run_input_messages WHERE run_id = ? AND seq = ?${this.db.dialect === "sqlite" ? "" : " FOR UPDATE"}`).get<Row>(runId, Number(control.consumed_seq) + 1))!;
      await this.db.prepare("UPDATE run_input_controls SET lease_token = ?, lease_until = ? WHERE run_id = ?").run(token, now + 300_000, runId);
      await this.db.prepare("UPDATE run_input_messages SET status = 'processing', updated_at = ? WHERE id = ?").run(now, row.id);
      return project({ ...row, status: "processing", updated_at: now });
    });
  }

  async renew(runId: string, token: string): Promise<void> {
    const result = await this.db.prepare("UPDATE run_input_controls SET lease_until = ? WHERE run_id = ? AND lease_token = ? AND lease_until > ?")
      .run(Date.now() + 300_000, runId, token, Date.now());
    if (Number(result.changes) !== 1) throw new AppError("CONFLICT", "Run input lease was lost", 409);
  }

  /** Failed semantic work has no committed decision; a later worker can retry it. */
  async release(runId: string, token: string): Promise<void> {
    await this.db.transaction(async () => {
      const control = await this.lock(runId);
      if (control.lease_token !== token) return;
      await this.db.prepare("UPDATE run_input_messages SET status = 'accepted', updated_at = ? WHERE run_id = ? AND status = 'processing'").run(Date.now(), runId);
      await this.db.prepare("UPDATE run_input_controls SET lease_token = NULL, lease_until = NULL WHERE run_id = ? AND lease_token = ?").run(runId, token);
    });
  }

  /** Invoke canonical/Plan writes in the same transaction as this consumption decision. */
  async finish(message: RunInputMessage, token: string, status: Exclude<RunInputStatus, "accepted" | "processing" | "unprocessed">,
    decision: Readonly<Record<string, unknown>>, commit?: () => Promise<void>): Promise<void> {
    await this.db.transaction(async () => {
      const control = await this.lock(message.runId);
      if (control.lease_token !== token || Number(control.lease_until) <= Date.now() || Number(control.consumed_seq) + 1 !== message.seq) throw new AppError("CONFLICT", "Run input lease or sequence is stale", 409);
      const run = await this.db.prepare(`SELECT status FROM runs WHERE id = ?${this.db.dialect === "sqlite" ? "" : " FOR UPDATE"}`).get<{ status: string }>(message.runId);
      if (run?.status !== "running") throw new AppError("CONFLICT", "Run stopped before input decision", 409);
      await commit?.();
      const now = Date.now();
      await this.db.prepare("UPDATE run_input_messages SET status = ?, decision_json = ?, updated_at = ? WHERE id = ?").run(status, JSON.stringify(decision), now, message.id);
      await this.db.prepare("UPDATE run_input_controls SET consumed_seq = ?, lease_token = NULL, lease_until = NULL WHERE run_id = ?").run(message.seq, message.runId);
      await appendRunEvent(this.db, message.runId, { type: "run.input.decided", data: { message: { ...message, status, decision, updatedAt: now } }, createdAt: now });
    });
  }

  async stop(runId: string, reason: string): Promise<void> {
    const control = await this.lock(runId);
    const now = Date.now();
    for (const message of (await this.list(runId)).filter(m => m.status === "accepted" || m.status === "processing")) {
      const decision = { reason };
      await this.db.prepare("UPDATE run_input_messages SET status = 'unprocessed', decision_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(decision), now, message.id);
      await appendRunEvent(this.db, runId, { type: "run.input.decided", data: { message: { ...message, status: "unprocessed", decision, updatedAt: now } }, createdAt: now });
    }
    await this.db.prepare("UPDATE run_input_controls SET consumed_seq = ?, lease_token = NULL, lease_until = NULL WHERE run_id = ?").run(control.received_seq, runId);
  }
}
