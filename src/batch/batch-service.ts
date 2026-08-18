import { randomUUID } from "node:crypto";
import type { AgentService } from "../agents/agent-service.ts";
import type { RunService } from "../runtime/run-service.ts";
import type { AppDatabase } from "../storage/database.ts";
import { AppError, conflict, notFound } from "../shared/errors.ts";
import { requireRecord, requireString } from "../shared/validation.ts";

export type BatchStatus = "running" | "completed" | "failed" | "cancelled";
export type BatchItemStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface BatchRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly agentId: string;
  readonly idempotencyKey: string;
  readonly status: BatchStatus;
  readonly concurrency: number;
  readonly failurePolicy: "continue" | "fail-fast";
  readonly allowDangerousTools: boolean;
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly createdAt: number;
  readonly finishedAt?: number;
}

export interface BatchItemRecord {
  readonly id: string;
  readonly batchId: string;
  readonly key: string;
  readonly position: number;
  readonly input: string;
  readonly status: BatchItemStatus;
  readonly runId?: string;
  readonly output?: string;
  readonly errorCode?: string;
  readonly startedAt?: number;
  readonly finishedAt?: number;
}

interface BatchRow {
  id: string; owner_user_id: string; agent_id: string; idempotency_key: string;
  status: BatchStatus; concurrency: number; failure_policy: "continue" | "fail-fast";
  allow_dangerous_tools: number; created_at: number; finished_at: number | null;
  total: number; completed: number; failed: number; cancelled: number;
}

export class BatchService {
  private readonly database: AppDatabase;
  private readonly agents: AgentService;
  private readonly runs: RunService;

  constructor(database: AppDatabase, agents: AgentService, runs: RunService) {
    this.database = database;
    this.agents = agents;
    this.runs = runs;
  }

  async create(actorUserId: string, inputValue: unknown): Promise<BatchRecord> {
    const input = parseBatchInput(inputValue);
    this.agents.get(actorUserId, input.agentId);
    const existing = this.findByIdempotencyKey(actorUserId, input.idempotencyKey);
    if (existing !== undefined) {
      this.assertSameRequest(existing, input);
      return existing;
    }
    const batchId = randomUUID();
    const now = Date.now();
    try {
      this.database.transaction(() => {
        this.database.raw.prepare(`
          INSERT INTO batches(
            id, owner_user_id, agent_id, idempotency_key, status, concurrency,
            failure_policy, allow_dangerous_tools, created_at
          ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)
        `).run(
          batchId,
          actorUserId,
          input.agentId,
          input.idempotencyKey,
          input.concurrency,
          input.failurePolicy,
          input.allowDangerousTools ? 1 : 0,
          now,
        );
        const insertItem = this.database.raw.prepare(`
          INSERT INTO batch_items(id, batch_id, item_key, position, input, status)
          VALUES (?, ?, ?, ?, ?, 'pending')
        `);
        for (const [position, item] of input.items.entries()) {
          insertItem.run(randomUUID(), batchId, item.key, position, item.input);
        }
      });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        const winner = this.findByIdempotencyKey(actorUserId, input.idempotencyKey);
        if (winner !== undefined) return winner;
        throw conflict("Batch contains duplicate item keys");
      }
      throw error;
    }

    const items = this.items(actorUserId, batchId);
    let nextIndex = 0;
    let halt = false;
    const workers = Array.from({ length: Math.min(input.concurrency, items.length) }, async () => {
      while (true) {
        if (halt) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        const item = items[index];
        this.database.raw.prepare(`
          UPDATE batch_items SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'
        `).run(Date.now(), item.id);
        try {
          const run = await this.runs.execute(actorUserId, input.agentId, item.input, {
            allowDangerousTools: input.allowDangerousTools,
          });
          this.database.raw.prepare(`
            UPDATE batch_items
            SET status = 'completed', run_id = ?, output = ?, finished_at = ? WHERE id = ?
          `).run(run.id, run.output ?? "", Date.now(), item.id);
        } catch (error) {
          const appError = error instanceof AppError
            ? error
            : new AppError("INTERNAL_ERROR", "Batch item failed", 500);
          const runId = typeof appError.details?.runId === "string" ? appError.details.runId : null;
          this.database.raw.prepare(`
            UPDATE batch_items
            SET status = 'failed', run_id = ?, error_code = ?, finished_at = ? WHERE id = ?
          `).run(runId, appError.code, Date.now(), item.id);
          if (input.failurePolicy === "fail-fast") halt = true;
        }
      }
    });
    await Promise.all(workers);
    if (halt) {
      this.database.raw.prepare(`
        UPDATE batch_items SET status = 'cancelled', finished_at = ?
        WHERE batch_id = ? AND status = 'pending'
      `).run(Date.now(), batchId);
    }
    const failed = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM batch_items WHERE batch_id = ? AND status = 'failed'
    `).get(batchId) as { count: number }).count;
    this.database.raw.prepare("UPDATE batches SET status = ?, finished_at = ? WHERE id = ?")
      .run(failed > 0 ? "failed" : "completed", Date.now(), batchId);
    return this.get(actorUserId, batchId);
  }

  get(actorUserId: string, batchId: string): BatchRecord {
    const row = this.database.raw.prepare(`
      SELECT b.*,
        COUNT(i.id) AS total,
        SUM(CASE WHEN i.status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN i.status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN i.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
      FROM batches b LEFT JOIN batch_items i ON i.batch_id = b.id
      WHERE b.id = ? AND b.owner_user_id = ? GROUP BY b.id
    `).get(batchId, actorUserId) as BatchRow | undefined;
    if (row === undefined) throw notFound("Batch");
    return toBatchRecord(row);
  }

  items(actorUserId: string, batchId: string): BatchItemRecord[] {
    this.get(actorUserId, batchId);
    const rows = this.database.raw.prepare(`
      SELECT id, batch_id, item_key, position, input, status, run_id, output,
             error_code, started_at, finished_at
      FROM batch_items WHERE batch_id = ? ORDER BY position
    `).all(batchId) as unknown as Array<{
      id: string; batch_id: string; item_key: string; position: number; input: string;
      status: BatchItemStatus; run_id: string | null; output: string | null; error_code: string | null;
      started_at: number | null; finished_at: number | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      batchId: row.batch_id,
      key: row.item_key,
      position: row.position,
      input: row.input,
      status: row.status,
      ...(row.run_id === null ? {} : { runId: row.run_id }),
      ...(row.output === null ? {} : { output: row.output }),
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    }));
  }

  private findByIdempotencyKey(actorUserId: string, key: string): BatchRecord | undefined {
    const row = this.database.raw.prepare(`
      SELECT id FROM batches WHERE owner_user_id = ? AND idempotency_key = ?
    `).get(actorUserId, key) as { id: string } | undefined;
    return row === undefined ? undefined : this.get(actorUserId, row.id);
  }

  private assertSameRequest(existing: BatchRecord, input: ParsedBatchInput): void {
    const existingItems = this.items(existing.ownerUserId, existing.id);
    const same = existing.agentId === input.agentId
      && existing.concurrency === input.concurrency
      && existing.failurePolicy === input.failurePolicy
      && existing.allowDangerousTools === input.allowDangerousTools
      && existingItems.length === input.items.length
      && existingItems.every((item, index) =>
        item.key === input.items[index].key && item.input === input.items[index].input
      );
    if (!same) throw conflict("Idempotency key was already used for a different batch request");
  }
}

interface ParsedBatchInput {
  agentId: string;
  idempotencyKey: string;
  concurrency: number;
  failurePolicy: "continue" | "fail-fast";
  allowDangerousTools: boolean;
  items: Array<{ key: string; input: string }>;
}

function parseBatchInput(value: unknown): ParsedBatchInput {
  const record = requireRecord(value, "batch");
  if (!Array.isArray(record.items) || record.items.length === 0 || record.items.length > 1_000) {
    throw new AppError("BAD_REQUEST", "items must contain between 1 and 1000 entries", 400);
  }
  const concurrency = record.concurrency === undefined ? 4 : record.concurrency;
  if (!Number.isSafeInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > 32) {
    throw new AppError("BAD_REQUEST", "concurrency must be an integer between 1 and 32", 400);
  }
  const failurePolicy = record.failurePolicy ?? "continue";
  if (failurePolicy !== "continue" && failurePolicy !== "fail-fast") {
    throw new AppError("BAD_REQUEST", "failurePolicy must be continue or fail-fast", 400);
  }
  if (record.allowDangerousTools !== undefined && typeof record.allowDangerousTools !== "boolean") {
    throw new AppError("BAD_REQUEST", "allowDangerousTools must be boolean", 400);
  }
  const items = record.items.map((item, index) => {
    const row = requireRecord(item, `items[${index}]`);
    return {
      key: requireString(row.key, `items[${index}].key`, { max: 200 }),
      input: requireString(row.input, `items[${index}].input`, { max: 200_000 }),
    };
  });
  if (new Set(items.map((item) => item.key)).size !== items.length) {
    throw conflict("Batch item keys must be unique");
  }
  return {
    agentId: requireString(record.agentId, "agentId", { max: 128 }),
    idempotencyKey: record.idempotencyKey === undefined
      ? randomUUID()
      : requireString(record.idempotencyKey, "idempotencyKey", { max: 200 }),
    concurrency: concurrency as number,
    failurePolicy,
    allowDangerousTools: record.allowDangerousTools === true,
    items,
  };
}

function toBatchRecord(row: BatchRow): BatchRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    agentId: row.agent_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    concurrency: row.concurrency,
    failurePolicy: row.failure_policy,
    allowDangerousTools: row.allow_dangerous_tools === 1,
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
    failed: Number(row.failed ?? 0),
    cancelled: Number(row.cancelled ?? 0),
    createdAt: row.created_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  };
}
