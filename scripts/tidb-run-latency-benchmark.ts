import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createConnection, createPool, type Pool, type PoolConnection } from "mysql2/promise";
import { RunService } from "../packages/agentloop/src/runtime/run-service.ts";
import type { ModelAdapter } from "../packages/agentloop/src/runtime/contracts.ts";
import { SkillService } from "../packages/agentloop/src/skills/skill-service.ts";
import { AppDatabase } from "../packages/agentloop/src/storage/database.ts";
import { TiDbConnection, type TiDbClientLike, type TiDbPoolLike } from "../packages/agentloop/src/storage/tidb-connection.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "../packages/agentloop/tests/runtime-test-helpers.ts";

interface QueryMetric {
  readonly sql: string;
  readonly durationMs: number;
  readonly payloadBytes: number;
}

class QueryRecorder {
  active = false;
  readonly queries: QueryMetric[] = [];

  async measure<T>(sql: string, values: readonly unknown[], operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      if (this.active) {
        this.queries.push({
          sql: sql.trim().replace(/\s+/g, " "),
          durationMs: performance.now() - started,
          payloadBytes: sql.includes("INSERT INTO run_events") && typeof values[3] === "string"
            ? Buffer.byteLength(values[3])
            : 0,
        });
      }
    }
  }
}

class MeasuredTiDbPool implements TiDbPoolLike {
  private readonly pool: Pool;
  private readonly recorder: QueryRecorder;

  constructor(pool: Pool, recorder: QueryRecorder) {
    this.pool = pool;
    this.recorder = recorder;
  }

  async getConnection(): Promise<TiDbClientLike> {
    return measuredClient(await this.pool.getConnection(), this.recorder);
  }

  async query(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    return await this.recorder.measure(sql, values, async () => await this.pool.query(sql, [...values]));
  }

  async end(): Promise<void> { await this.pool.end(); }
}

function measuredClient(client: PoolConnection, recorder: QueryRecorder): TiDbClientLike {
  return {
    execute: async (sql, values = []) => await recorder.measure(sql, values, async () => await client.execute(sql, [...values])),
    query: async (sql, values = []) => await recorder.measure(sql, values, async () => await client.query(sql, [...values])),
    release: () => client.release(),
  };
}

class DeterministicStreamingModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private readonly chunks: number;
  private readonly delayMs: number;
  private readonly chunkCharacters: number;

  constructor(
    chunks: number,
    delayMs: number,
    chunkCharacters: number,
  ) {
    this.chunks = chunks;
    this.delayMs = delayMs;
    this.chunkCharacters = chunkCharacters;
  }

  async complete() {
    return { content: "benchmark completed", finishReason: "stop" as const, toolCalls: [] };
  }

  async streamComplete(_invocation: Parameters<NonNullable<ModelAdapter["streamComplete"]>>[0], emit: Parameters<NonNullable<ModelAdapter["streamComplete"]>>[1]) {
    let content = "";
    for (let index = 0; index < this.chunks; index += 1) {
      const chunk = String(index % 10).repeat(this.chunkCharacters);
      content += chunk;
      await emit({ type: "text_delta", text: chunk });
      if (this.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
    return { content, finishReason: "stop" as const, toolCalls: [] };
  }
}

function argument(name: string): string | undefined {
  const prefix = "--" + name + "=";
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const label = argument("label") ?? "benchmark";
const adminUrl = process.env.TIDB_BENCHMARK_ADMIN_URL ?? "mysql://root@127.0.0.1:4000";
const databaseName = "agentloop_run_latency_benchmark";
const workspace = await mkdtemp(join(tmpdir(), "agentloop-tidb-benchmark-" + label + "-"));
const admin = await createConnection(adminUrl);
await admin.query("DROP DATABASE IF EXISTS " + databaseName);
await admin.query("CREATE DATABASE " + databaseName);
await admin.end();

const recorder = new QueryRecorder();
const pool = createPool(adminUrl + "/" + databaseName);
const database = await AppDatabase.open({ connection: TiDbConnection.fromPool(new MeasuredTiDbPool(pool, recorder)) });

try {
  const createService = (model: ModelAdapter) => new RunService({
    database,
    skills: new SkillService(database),
    workspaceRoot: workspace,
    modelFactory: () => model,
    plannerFactory: () => singleStepTestPlanner(),
    assessorFactory: () => approvingTestAssessor(),
    maxSteps: 2,
  });

  await createService(new DeterministicStreamingModel(4, 5, 64)).execute("benchmark-owner", "warm up the Runtime");

  recorder.queries.length = 0;
  recorder.active = true;
  const started = performance.now();
  const run = await createService(new DeterministicStreamingModel(120, 50, 512))
    .execute("benchmark-owner", "run the deterministic TiDB persistence benchmark");
  const totalDurationMs = performance.now() - started;
  recorder.active = false;

  const rows = await database.prepare("SELECT type, payload_json FROM run_events WHERE run_id = ? ORDER BY seq")
    .all<{ type: string; payload_json: string }>(run.id);
  const eventQueries = recorder.queries.filter((query) =>
    query.sql.includes("run_events") || query.sql.includes("run_event_sequences"),
  );
  const streamRows = rows.filter((row) => row.type === "assistant.streaming");

  console.log(JSON.stringify({
    label,
    commit: process.env.BENCHMARK_COMMIT ?? "unknown",
    runStatus: run.status,
    totalDurationMs,
    eventCount: rows.length,
    streamingEventCount: streamRows.length,
    persistedPayloadBytes: rows.reduce((sum, row) => sum + Buffer.byteLength(row.payload_json), 0),
    streamingPayloadBytes: streamRows.reduce((sum, row) => sum + Buffer.byteLength(row.payload_json), 0),
    eventSqlStatementCount: eventQueries.length,
    eventSqlDurationMs: eventQueries.reduce((sum, query) => sum + query.durationMs, 0),
    allSqlStatementCount: recorder.queries.length,
    allSqlDurationMs: recorder.queries.reduce((sum, query) => sum + query.durationMs, 0),
    eventInsertPayloadBytes: eventQueries.reduce((sum, query) => sum + query.payloadBytes, 0),
  }));
} finally {
  recorder.active = false;
  await database.close();
  const cleanup = await createConnection(adminUrl);
  await cleanup.query("DROP DATABASE IF EXISTS " + databaseName);
  await cleanup.end();
  await rm(workspace, { recursive: true, force: true });
}
