import { ascending, runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../runtime-records.ts";

export type BatchStatus = "running" | "completed" | "failed" | "cancelled";
export type BatchItemStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface BatchRow {
  id: string; owner_user_id: string; idempotency_key: string;
  status: BatchStatus; concurrency: number; failure_policy: "continue" | "fail-fast";
  allow_dangerous_tools: number; created_at: number; finished_at: number | null;
  total: number; completed: number; failed: number; cancelled: number;
}

export interface BatchItemRow {
  id: string; batch_id: string; item_key: string; position: number; input: string;
  status: BatchItemStatus; run_id: string | null; output: string | null; error_code: string | null;
  started_at: number | null; finished_at: number | null;
}

export class BatchRepository {
  private readonly connection: RuntimePersistence;

  constructor(connection: RuntimePersistenceInput) {
    this.connection = runtimePersistence(connection);
  }

  async createBatch(input: {
    id: string;
    ownerUserId: string;
    idempotencyKey: string;
    concurrency: number;
    failurePolicy: "continue" | "fail-fast";
    allowDangerousTools: boolean;
    items: Array<{ id: string; key: string; position: number; input: string }>;
    now: number;
  }): Promise<void> {
    await this.connection.transaction(async () => {
      await this.connection.records.insert("batches", { id: input.id, owner_user_id: input.ownerUserId, idempotency_key: input.idempotencyKey,
        status: "running", concurrency: input.concurrency, failure_policy: input.failurePolicy, allow_dangerous_tools: input.allowDangerousTools ? 1 : 0, created_at: input.now });
      for (const item of input.items) await this.connection.records.insert("batch_items", { id: item.id, batch_id: input.id, item_key: item.key, position: item.position, input: item.input, status: "pending" });
    });
  }

  async findIdByIdempotencyKey(ownerUserId: string, key: string): Promise<{ id: string } | undefined> {
    return (await this.connection.records.find("batches", { owner_user_id: ownerUserId, idempotency_key: key }))[0];
  }

  async findByIdAndOwner(batchId: string, ownerUserId: string): Promise<BatchRow | undefined> {
    return await this.connection.transaction(async () => {
      const row = (await this.connection.records.find("batches", { id: batchId, owner_user_id: ownerUserId }))[0];
      if (!row) return undefined;
      const items = await this.connection.records.find("batch_items", { batch_id: batchId });
      return { ...row, total: items.length, completed: items.filter(item => item.status === "completed").length,
        failed: items.filter(item => item.status === "failed").length, cancelled: items.filter(item => item.status === "cancelled").length };
    });
  }

  async itemsByBatch(batchId: string): Promise<BatchItemRow[]> {
    return (await this.connection.records.find("batch_items", { batch_id: batchId })).sort(ascending("position"));
  }

  async claimItem(itemId: string, now: number): Promise<void> {
    await this.connection.records.update("batch_items", { id: itemId, status: "pending" }, () => ({ status: "running" as const, started_at: now }));
  }

  async markItemCompleted(input: { itemId: string; runId: string; output: string; finishedAt: number }): Promise<void> {
    await this.connection.records.update("batch_items", { id: input.itemId }, () => ({ status: "completed" as const, run_id: input.runId, output: input.output, finished_at: input.finishedAt }));
  }

  async markItemFailed(input: { itemId: string; runId: string | null; errorCode: string; finishedAt: number }): Promise<void> {
    await this.connection.records.update("batch_items", { id: input.itemId }, () => ({ status: "failed" as const, run_id: input.runId, error_code: input.errorCode, finished_at: input.finishedAt }));
  }

  async cancelPendingItems(batchId: string, now: number): Promise<void> {
    await this.connection.records.update("batch_items", { batch_id: batchId, status: "pending" }, () => ({ status: "cancelled" as const, finished_at: now }));
  }

  async countFailed(batchId: string): Promise<number> {
    return (await this.connection.records.find("batch_items", { batch_id: batchId, status: "failed" })).length;
  }

  async finishBatch(input: { batchId: string; status: BatchStatus; finishedAt: number }): Promise<void> {
    await this.connection.records.update("batches", { id: input.batchId }, () => ({ status: input.status, finished_at: input.finishedAt }));
  }
}