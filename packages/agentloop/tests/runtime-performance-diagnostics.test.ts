import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  RuntimePerformanceDiagnostics,
  type RuntimePerformanceRecord,
  type RuntimePerformanceSink,
} from "../src/diagnostics/runtime-performance.ts";
import { TiDbConnection, type TiDbClientLike, type TiDbPoolLike } from "../src/storage/tidb-connection.ts";
import { OpenAICompatibleModel } from "../src/runtime/models.ts";
import { completeWithStreaming } from "../src/runtime/model-streaming.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";

test("TiDB diagnostics attribute pool, SQL and commit waits without double-counting nested transactions", async () => {
  const records: RuntimePerformanceRecord[] = [];
  const diagnostics = collectingDiagnostics(records);
  const connection = TiDbConnection.fromPool(new DelayedPool());
  await diagnostics.runWithContext({ runId: "run-db" }, async () => {
    await connection.transaction(async () => {
      await connection.prepare("SELECT value FROM facts WHERE id = ?").get(42);
      await connection.transaction(async () => {
        await connection.prepare("UPDATE facts SET value = ? WHERE id = ?").run("x", 42);
      });
    });
    await connection.prepare("SELECT value FROM facts WHERE id = ?").get(7);
  });
  await diagnostics.close();

  const names = records.map(record => record.name);
  assert.equal(names.filter(name => name === "db.transaction").length, 1);
  assert.equal(names.filter(name => name === "db.transaction.reused").length, 1);
  assert.equal(names.filter(name => name === "db.sql.client").length, 3);
  assert.equal(names.filter(name => name === "db.pool.get_connection").length, 2);
  assert.ok(duration(records, "db.pool.get_connection") >= 8);
  assert.ok(duration(records, "db.transaction.commit") >= 10);
  assert.ok(records.filter(record => record.name === "db.sql.client").every(record =>
    record.attributes?.clientElapsedSemantics === "client_round_trip_including_driver_and_network_not_server_execution"));
  assert.equal(new Set(records.filter(record => record.name.startsWith("db.") && record.transactionId !== undefined).map(record => record.transactionId)).size, 1);
  assert.ok(records.some(record => record.name === "db.sql.client" && record.attributes?.inTransaction === false));
});

test("diagnostic contexts isolate concurrent Runs", async () => {
  const records: RuntimePerformanceRecord[] = [];
  const diagnostics = collectingDiagnostics(records);
  await Promise.all([
    diagnostics.runWithContext({ runId: "run-a" }, () => diagnostics.span("concurrent.operation", { category: "test" }, async () => await delay(12))),
    diagnostics.runWithContext({ runId: "run-b" }, () => diagnostics.span("concurrent.operation", { category: "test" }, async () => await delay(4))),
  ]);
  await diagnostics.close();
  assert.deepEqual(new Set(records.filter(record => record.name === "concurrent.operation").map(record => record.runId)), new Set(["run-a", "run-b"]));
});

test("TiDB rollback is independently attributed and preserves the operation error", async () => {
  const records: RuntimePerformanceRecord[] = [];
  const diagnostics = collectingDiagnostics(records);
  const connection = TiDbConnection.fromPool(new DelayedPool());
  const failure = new Error("operation failed");
  await assert.rejects(
    diagnostics.runWithContext({ runId: "run-rollback" }, async () =>
      await connection.transaction(async () => { throw failure; })),
    (error: unknown) => error === failure,
  );
  await diagnostics.close();
  assert.ok(records.some(record => record.name === "db.transaction.rollback" && record.status === "ok"));
  assert.ok(records.some(record => record.name === "db.transaction" && record.status === "error"));
});

test("Action diagnostics separate dispatch, tool body, prepare and commit without changing event order", async () => {
  const records: RuntimePerformanceRecord[] = [];
  const diagnostics = collectingDiagnostics(records);
  const database = new AppDatabase(":memory:");
  const runId = "run-action-diagnostics";
  try {
    await database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, "owner", "diagnose action", Date.now());
    const actions = new RuntimeActionRepository(database);
    const value = await diagnostics.runWithContext({ runId, stepId: "step-1", toolCallId: "tool-call-1" }, async () =>
      await actions.execute({
        runId, stepId: "step-1", kind: "tool_call", replayPolicy: "safe", deadlineMs: 1_000,
        metadata: { toolCallId: "tool-call-1", toolName: "delayed_tool" },
        prepareResult: async () => { await delay(7); return undefined as never; },
      }, async () => { await delay(13); return "ok"; }));
    assert.equal(value, "ok");
    const events = await database.prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY seq").all<{ type: string }>(runId);
    assert.deepEqual(events.map(event => event.type), [
      "action.created", "action.leased", "action.dispatched", "action.result_committed",
    ]);
  } finally {
    await database.close();
    await diagnostics.close();
  }
  assert.ok(duration(records, "tool.function") >= 11);
  assert.ok(duration(records, "action.prepare_result") >= 5);
  assert.ok(records.some(record => record.name === "action.dispatch" && record.toolCallId === "tool-call-1"));
  assert.ok(records.some(record => record.name === "action.commit_result" && record.actionId !== undefined));
});

test("model timings record transport receive boundaries and Runtime sink backpressure", async () => {
  const records: RuntimePerformanceRecord[] = [];
  const diagnostics = collectingDiagnostics(records);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    await delay(8);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        await delay(7);
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"A"},"finish_reason":null}]}\n\n'));
        await delay(5);
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  };
  try {
    await diagnostics.runWithContext({ runId: "run-model", requestId: "request-1" }, async () => {
      const model = new OpenAICompatibleModel({
        baseUrl: "https://models.example.test/v1", apiKey: "secret", model: "test-model",
        contextWindowTokens: 16_384, maxOutputTokens: 1_024, maxAttempts: 1,
      });
      const response = await completeWithStreaming({
        model, invocation: { runId: "run-model", phase: "execution", systemPrompt: "System", messages: [], tools: [] },
        base: { phase: "execution", requestId: "request-1" }, emit: async () => { await delay(6); },
      });
      const timing = response.performanceTiming as Record<string, number | string>;
      assert.ok(timing.requestToHeadersMs >= 7);
      assert.ok(timing.headersToFirstRawChunkMs >= 5);
      assert.ok(timing.sinkCallbackWaitMs >= 5);
      assert.equal(timing.accounting, "inclusive_timing_do_not_sum_or_subtract_to_claim_pure_provider_time");
    });
  } finally {
    globalThis.fetch = originalFetch;
    await diagnostics.close();
  }
  assert.ok(records.some(record => record.name === "model.transport.headers_wait"));
  assert.ok(records.some(record => record.name === "model.runtime_sink_callback"));
});

test("event callback diagnostics attribute durable delivery and log waits after commit", async () => {
  const records: RuntimePerformanceRecord[] = [];
  const diagnostics = collectingDiagnostics(records);
  const database = new AppDatabase(":memory:");
  const model = {
    limits: { contextWindowTokens: 16_384, maxOutputTokens: 1_024 },
    complete: async () => ({ content: "done", toolCalls: [], finishReason: "stop" as const }),
  };
  const runs = new RunService({
    database, skills: new SkillService(database), modelFactory: () => model, performanceDiagnostics: diagnostics,
    runEventLogSink: () => busyWait(6),
  });
  const subscribe = runs.subscribeRunEvents.bind(runs);
  try {
    const started = await runs.start("owner", "event callback attribution");
    const unsubscribe = subscribe(started.id, () => busyWait(7));
    await runs.whenRunIdle(started.id);
    unsubscribe();
  } finally {
    await runs.closePerformanceDiagnostics();
    await database.close();
  }
  assert.ok(records.some(record => record.name === "event.deliver" && record.durationMs >= 5));
  assert.ok(records.some(record => record.name === "event.log" && record.durationMs >= 4));
  assert.ok(records.some(record => record.name === "event.persist_through_commit"));
});

test("bounded diagnostics observe overflow and swallow sink failures", async () => {
  const sink: RuntimePerformanceSink = { write: async () => { throw new Error("sink unavailable"); } };
  const diagnostics = new RuntimePerformanceDiagnostics({ sink, capacity: 2, batchSize: 10, flushIntervalMs: 60_000 });
  await diagnostics.runWithContext({ runId: "run-failure" }, async () => {
    for (let index = 0; index < 5; index += 1) diagnostics.instant("overflow", { index });
  });
  await diagnostics.flush();
  const stats = diagnostics.stats();
  assert.ok(Number(stats.dropped) >= 5);
  assert.equal(stats.sinkFailures, 1);
  await diagnostics.close();
});

function collectingDiagnostics(records: RuntimePerformanceRecord[]): RuntimePerformanceDiagnostics {
  return new RuntimePerformanceDiagnostics({
    sink: { write: async batch => { records.push(...batch); } },
    capacity: 1_000, batchSize: 100, flushIntervalMs: 60_000,
  });
}

function duration(records: readonly RuntimePerformanceRecord[], name: string): number {
  return records.find(record => record.name === name)?.durationMs ?? 0;
}

function busyWait(milliseconds: number): void {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) { /* controlled synchronous callback delay */ }
}

class DelayedPool implements TiDbPoolLike {
  private readonly client = new DelayedClient();
  async getConnection(): Promise<TiDbClientLike> { await delay(9); return this.client; }
  async query(): Promise<[unknown, unknown]> { await delay(4); return [[], []]; }
  async end(): Promise<void> {}
}

class DelayedClient implements TiDbClientLike {
  async execute(sql: string): Promise<[unknown, unknown]> {
    await delay(sql.startsWith("SELECT") ? 6 : 8);
    return [sql.startsWith("SELECT") ? [{ value: "ok" }] : { affectedRows: 1 }, []];
  }
  async query(sql: string): Promise<[unknown, unknown]> {
    await delay(sql === "COMMIT" ? 11 : 3);
    return [{ affectedRows: 0 }, []];
  }
  release(): void {}
}
