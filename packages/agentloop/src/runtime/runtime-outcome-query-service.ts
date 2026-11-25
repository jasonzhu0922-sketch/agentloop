import { runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../storage/runtime-records.ts";
import type { RuntimeDeliveryReceipt } from "./contracts.ts";
import { type RuntimeResultRecord, parseRuntimeResultJson } from "./runtime-result.ts";
import { RuntimeResultRepository } from "./runtime-result-repository.ts";

export interface RuntimeOutcomeProjection {
  readonly status: string;
  readonly reasonCode: string;
  readonly planId?: string;
  readonly output?: string;
  readonly result?: RuntimeResultRecord;
  readonly deliveryReceipt?: RuntimeDeliveryReceipt;
  readonly committedAt: number;
}

/** Read-only canonical Outcome projection; it does not infer completion from events or artifacts. */
export class RuntimeOutcomeQueryService {
  private readonly database: RuntimePersistence;
  private readonly results: RuntimeResultRepository;

  constructor(database: RuntimePersistenceInput, results: RuntimeResultRepository) {
    this.database = runtimePersistence(database);
    this.results = results;
  }

  async read(runId: string): Promise<RuntimeOutcomeProjection | undefined> {
    const row = (await this.database.records.find("run_outcomes", { run_id: runId }))[0];
    if (row === undefined) return undefined;
    const deliveryReceipt = row.status === "completed"
      ? await this.results.readDeliveryReceiptForRun(runId)
      : undefined;
    return {
      status: row.status,
      reasonCode: row.reason_code,
      ...(row.plan_id === null ? {} : { planId: row.plan_id }),
      ...(row.output === null ? {} : { output: row.output }),
      ...(row.result_json === null ? {} : { result: parseRuntimeResultJson(row.result_json) }),
      ...(deliveryReceipt === undefined ? {} : { deliveryReceipt }),
      committedAt: row.committed_at,
    };
  }
}
