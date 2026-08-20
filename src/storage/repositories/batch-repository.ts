import type { SqlConnection } from "../connection.ts";

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
  private readonly connection: SqlConnection;

  constructor(connection: SqlConnection) {
    this.connection = connection;
  }

  createBatch(input: {
    id: string;
    ownerUserId: string;
    idempotencyKey: string;
    concurrency: number;
    failurePolicy: "continue" | "fail-fast";
    allowDangerousTools: boolean;
    items: Array<{ id: string; key: string; input: string }>;
    now: number;
  }): void {
    this.connection.transaction(() => {
      this.connection.prepare(`
        INSERT INTO batches(
          id, owner_user_id, idempotency_key, status, concurrency,
          failure_policy, allow_dangerous_tools, created_at
        ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
      `).run(
        input.id,
        input.ownerUserId,
        input.idempotencyKey,
        input.concurrency,
        input.failurePolicy,
        input.allowDangerousTools ? 1 : 0,
        input.now,
      );
      const insertItem = this.connection.prepare(`
        INSERT INTO batch_items(id, batch_id, item_key, position, input, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `);
      for (const item of input.items) {
        insertItem.run(item.id, input.id, item.key, item.position, item.input);
      }
    });
  }

  findIdByIdempotencyKey(ownerUserId: string, key: string): { id: string } | undefined {
    return this.connection.prepare(`
      SELECT id FROM batches WHERE owner_user_id = ? AND idempotency_key = ?
    `).get(ownerUserId, key) as { id: string } | undefined;
  }

  findByIdAndOwner(batchId: string, ownerUserId: string): BatchRow | undefined {
    return this.connection.prepare(`
      SELECT b.*,
        COUNT(i.id) AS total,
        SUM(CASE WHEN i.status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN i.status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN i.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
      FROM batches b LEFT JOIN batch_items i ON i.batch_id = b.id
      WHERE b.id = ? AND b.owner_user_id = ? GROUP BY b.id
    `).get(batchId, ownerUserId) as BatchRow | undefined;
  }

  itemsByBatch(batchId: string): BatchItemRow[] {
    return this.connection.prepare(`
      SELECT id, batch_id, item_key, position, input, status, run_id, output,
             error_code, started_at, finished_at
      FROM batch_items WHERE batch_id = ? ORDER BY position
    `).all(batchId) as unknown as BatchItemRow[];
  }

  claimItem(itemId: string, now: number): void {
    this.connection.prepare(`
      UPDATE batch_items SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'
    `).run(now, itemId);
  }

  markItemCompleted(input: { itemId: string; runId: string; output: string; finishedAt: number }): void {
    this.connection.prepare(`
      UPDATE batch_items
      SET status = 'completed', run_id = ?, output = ?, finished_at = ? WHERE id = ?
    `).run(input.runId, input.output, input.finishedAt, input.itemId);
  }

  markItemFailed(input: { itemId: string; runId: string | null; errorCode: string; finishedAt: number }): void {
    this.connection.prepare(`
      UPDATE batch_items
      SET status = 'failed', run_id = ?, error_code = ?, finished_at = ? WHERE id = ?
    `).run(input.runId, input.errorCode, input.finishedAt, input.itemId);
  }

  cancelPendingItems(batchId: string, now: number): void {
    this.connection.prepare(`
      UPDATE batch_items SET status = 'cancelled', finished_at = ?
      WHERE batch_id = ? AND status = 'pending'
    `).run(now, batchId);
  }

  countFailed(batchId: string): number {
    const row = this.connection.prepare(`
      SELECT COUNT(*) AS count FROM batch_items WHERE batch_id = ? AND status = 'failed'
    `).get(batchId) as { count: number };
    return row.count;
  }

  finishBatch(input: { batchId: string; status: BatchStatus; finishedAt: number }): void {
    this.connection.prepare("UPDATE batches SET status = ?, finished_at = ? WHERE id = ?")
      .run(input.status, input.finishedAt, input.batchId);
  }
}