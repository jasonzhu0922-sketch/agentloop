import { randomUUID } from "node:crypto";
import type { RunService } from "../runtime/run-service.ts";
import type { SqlConnection } from "../storage/connection.ts";
import { BatchRepository, type BatchRow } from "../storage/repositories/batch-repository.ts";
import { AppError, conflict, notFound } from "../shared/errors.ts";
import { requireRecord, requireString } from "../shared/validation.ts";

export type BatchStatus = "running" | "completed" | "failed" | "cancelled";
export type BatchItemStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface BatchRecord {
  readonly id: string;
  readonly ownerUserId: string;
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

export class BatchService {
  private readonly batches: BatchRepository;
  private readonly runs: RunService;

  constructor(database: SqlConnection, runs: RunService) {
    this.batches = new BatchRepository(database);
    this.runs = runs;
  }

  async create(actorUserId: string, inputValue: unknown): Promise<BatchRecord> {
    const input = parseBatchInput(inputValue);
    const existing = await this.findByIdempotencyKey(actorUserId, input.idempotencyKey);
    if (existing !== undefined) {
      await this.assertSameRequest(existing, input);
      return existing;
    }
    const batchId = randomUUID();
    const now = Date.now();
    try {
      await this.batches.createBatch({
        id: batchId,
        ownerUserId: actorUserId,
        idempotencyKey: input.idempotencyKey,
        concurrency: input.concurrency,
        failurePolicy: input.failurePolicy,
        allowDangerousTools: input.allowDangerousTools,
        items: input.items.map((item, position) => ({ id: randomUUID(), key: item.key, input: item.input, position })),
        now,
      });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        const winner = await this.findByIdempotencyKey(actorUserId, input.idempotencyKey);
        if (winner !== undefined) return winner;
        throw conflict("Batch contains duplicate item keys");
      }
      throw error;
    }

    const items = await this.items(actorUserId, batchId);
    let nextIndex = 0;
    let halt = false;
    const workers = Array.from({ length: Math.min(input.concurrency, items.length) }, async () => {
      while (true) {
        if (halt) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        const item = items[index];
        await this.batches.claimItem(item.id, Date.now());
        try {
          const run = await this.runs.execute(actorUserId, item.input, {
            allowDangerousTools: input.allowDangerousTools,
          });
          await this.batches.markItemCompleted({
            itemId: item.id,
            runId: run.id,
            output: run.output ?? "",
            finishedAt: Date.now(),
          });
        } catch (error) {
          const appError = error instanceof AppError
            ? error
            : new AppError("INTERNAL_ERROR", "Batch item failed", 500);
          const runId = typeof appError.details?.runId === "string" ? appError.details.runId : null;
          await this.batches.markItemFailed({
            itemId: item.id,
            runId,
            errorCode: appError.code,
            finishedAt: Date.now(),
          });
          if (input.failurePolicy === "fail-fast") halt = true;
        }
      }
    });
    await Promise.all(workers);
    if (halt) {
      await this.batches.cancelPendingItems(batchId, Date.now());
    }
    const failed = await this.batches.countFailed(batchId);
    await this.batches.finishBatch({
      batchId,
      status: failed > 0 ? "failed" : "completed",
      finishedAt: Date.now(),
    });
    return await this.get(actorUserId, batchId);
  }

  async get(actorUserId: string, batchId: string): Promise<BatchRecord> {
    const row = await this.batches.findByIdAndOwner(batchId, actorUserId);
    if (row === undefined) throw notFound("Batch");
    return toBatchRecord(row);
  }

  async items(actorUserId: string, batchId: string): Promise<BatchItemRecord[]> {
    await this.get(actorUserId, batchId);
    const rows = await this.batches.itemsByBatch(batchId);
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

  private async findByIdempotencyKey(actorUserId: string, key: string): Promise<BatchRecord | undefined> {
    const row = await this.batches.findIdByIdempotencyKey(actorUserId, key);
    return row === undefined ? undefined : this.get(actorUserId, row.id);
  }

  private async assertSameRequest(existing: BatchRecord, input: ParsedBatchInput): Promise<void> {
    const existingItems = await this.items(existing.ownerUserId, existing.id);
    const same = existing.concurrency === input.concurrency
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
