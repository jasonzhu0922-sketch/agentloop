import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

export interface RuntimePerformanceContext {
  readonly runId?: string;
  readonly stepId?: string;
  readonly actionId?: string;
  readonly requestId?: string;
  readonly toolCallId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly transactionId?: string;
}

export interface RuntimePerformanceRecord extends RuntimePerformanceContext {
  readonly schema: "agentloop.runtimePerformance/v1";
  readonly kind: "span" | "instant" | "run_summary" | "diagnostic_status";
  readonly name: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly status: "ok" | "error";
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface RuntimePerformanceSink {
  write(records: readonly RuntimePerformanceRecord[]): Promise<void>;
  close?(): Promise<void>;
}

export interface RuntimePerformanceDiagnosticsOptions {
  readonly sink: RuntimePerformanceSink;
  readonly capacity?: number;
  readonly batchSize?: number;
  readonly flushIntervalMs?: number;
  readonly topOperations?: number;
}

interface MutableState {
  queue: RuntimePerformanceRecord[];
  flushing?: Promise<void>;
  flushScheduled: boolean;
  closed: boolean;
  dropped: number;
  sinkFailures: number;
  accepted: number;
  written: number;
  timer?: NodeJS.Timeout;
  incomplete: Map<string, { name: string; startedAt: number; context: RuntimePerformanceContext }>;
  byRun: Map<string, RuntimePerformanceRecord[]>;
  retainedSummaryRecords: number;
}

const contextStorage = new AsyncLocalStorage<RuntimePerformanceContext>();
const diagnosticsStorage = new AsyncLocalStorage<RuntimePerformanceDiagnostics>();
let activeDiagnostics: RuntimePerformanceDiagnostics | undefined;

export class RuntimePerformanceDiagnostics {
  private readonly capacity: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly topOperations: number;
  private readonly sink: RuntimePerformanceSink;
  private readonly state: MutableState = {
    queue: [], flushScheduled: false, closed: false, dropped: 0, sinkFailures: 0, accepted: 0, written: 0,
    incomplete: new Map(), byRun: new Map(), retainedSummaryRecords: 0,
  };

  constructor(options: RuntimePerformanceDiagnosticsOptions) {
    this.capacity = positiveInteger(options.capacity, 8_192, "capacity");
    this.batchSize = positiveInteger(options.batchSize, 128, "batchSize");
    this.flushIntervalMs = positiveInteger(options.flushIntervalMs, 250, "flushIntervalMs");
    this.topOperations = positiveInteger(options.topOperations, 20, "topOperations");
    this.sink = options.sink;
    this.state.timer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
    this.state.timer.unref();
  }

  installGlobal(): () => void {
    const previous = activeDiagnostics;
    activeDiagnostics = this;
    return () => { if (activeDiagnostics === this) activeDiagnostics = previous; };
  }

  runWithContext<T>(context: RuntimePerformanceContext, operation: () => T): T {
    return diagnosticsStorage.run(this, () =>
      contextStorage.run(mergeContext(contextStorage.getStore(), context), operation));
  }

  async span<T>(name: string, attributes: Readonly<Record<string, unknown>> | undefined, operation: () => T | Promise<T>): Promise<T> {
    if (this.state.closed) return await operation();
    const inherited = contextStorage.getStore();
    const spanId = randomUUID();
    const context = mergeContext(inherited, {
      spanId,
      ...(inherited?.spanId === undefined ? {} : { parentSpanId: inherited.spanId }),
    });
    const startedAt = Date.now();
    const startedMono = performance.now();
    this.state.incomplete.set(spanId, { name, startedAt, context });
    let status: RuntimePerformanceRecord["status"] = "ok";
    try {
      return await contextStorage.run(context, operation);
    } catch (error) {
      status = "error";
      throw error;
    } finally {
      const durationMs = Math.max(0, performance.now() - startedMono);
      this.state.incomplete.delete(spanId);
      this.record({
        schema: "agentloop.runtimePerformance/v1", kind: "span", name,
        ...context, startedAt, endedAt: Date.now(), durationMs, status,
        ...(attributes === undefined ? {} : { attributes }),
      });
    }
  }

  spanSync<T>(name: string, attributes: Readonly<Record<string, unknown>>, operation: () => T): T {
    const startedAt = Date.now(), startedMono = performance.now(), spanId = randomUUID();
    const context = mergeContext(contextStorage.getStore(), { spanId });
    let status: RuntimePerformanceRecord["status"] = "ok";
    try { return contextStorage.run(context, operation); }
    catch (error) { status = "error"; throw error; }
    finally { this.record({ schema: "agentloop.runtimePerformance/v1", kind: "span", name, ...context,
      startedAt, endedAt: Date.now(), durationMs: performance.now() - startedMono, status, attributes }); }
  }

  instant(name: string, attributes?: Readonly<Record<string, unknown>>): void {
    const now = Date.now();
    this.record({
      schema: "agentloop.runtimePerformance/v1", kind: "instant", name,
      ...contextStorage.getStore(), startedAt: now, endedAt: now, durationMs: 0, status: "ok",
      ...(attributes === undefined ? {} : { attributes }),
    });
  }

  async finishRun(runId: string, attributes?: Readonly<Record<string, unknown>>): Promise<void> {
    const operations = this.state.byRun.get(runId) ?? [];
    this.state.byRun.delete(runId);
    this.state.retainedSummaryRecords = Math.max(0, this.state.retainedSummaryRecords - operations.length);
    const startedAt = operations.reduce((minimum, item) => Math.min(minimum, item.startedAt), Date.now());
    const endedAt = operations.reduce((maximum, item) => Math.max(maximum, item.endedAt), startedAt);
    const runTotal = [...operations].reverse().find(item => item.name === "run.total");
    const spans = operations.filter(item => item.kind === "span");
    const environment = Object.assign({}, ...operations.filter(item => item.name === "run.environment").map(item => item.attributes ?? {}));
    const categoryTotals = new Map<string, number>();
    for (const item of spans) {
      const category = String(item.attributes?.category ?? item.name.split(".", 1)[0] ?? "other");
      categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + item.durationMs);
    }
    const summary: RuntimePerformanceRecord = {
      schema: "agentloop.runtimePerformance/v1", kind: "run_summary", name: "run.summary", runId,
      startedAt: runTotal?.startedAt ?? startedAt,
      endedAt: runTotal?.endedAt ?? endedAt,
      durationMs: runTotal?.durationMs ?? Math.max(0, endedAt - startedAt), status: "ok",
      attributes: {
        accounting: "wall_duration_and_child_spans_overlap;do_not_sum_to_reconstruct_run_duration",
        operationCount: spans.length, droppedRecords: this.state.dropped, sinkFailures: this.state.sinkFailures,
        categoryInclusiveMs: Object.fromEntries(categoryTotals),
        slowestOperations: [...spans].sort((left, right) => right.durationMs - left.durationMs).slice(0, this.topOperations).map(item => ({
          name: item.name, durationMs: item.durationMs, spanId: item.spanId, parentSpanId: item.parentSpanId,
          stepId: item.stepId, actionId: item.actionId, requestId: item.requestId, toolCallId: item.toolCallId, transactionId: item.transactionId,
        })),
        ...environment,
        ...(attributes === undefined ? {} : attributes),
      },
    };
    this.record(summary);
    // A diagnostic sink must never extend the Run's business completion path.
    // Graceful host shutdown uses close() when it needs a durable flush.
    this.scheduleFlush();
  }

  stats(): Readonly<Record<string, number | boolean>> {
    return {
      capacity: this.capacity, queued: this.state.queue.length, accepted: this.state.accepted,
      written: this.state.written, dropped: this.state.dropped, sinkFailures: this.state.sinkFailures,
      incomplete: this.state.incomplete.size, retainedSummaryRecords: this.state.retainedSummaryRecords, closed: this.state.closed,
    };
  }

  async flush(): Promise<void> {
    if (this.state.flushing !== undefined) return await this.state.flushing;
    this.state.flushing = this.flushBatches().finally(() => { this.state.flushing = undefined; });
    return await this.state.flushing;
  }

  async close(): Promise<void> {
    if (this.state.closed) return;
    this.state.closed = true;
    if (this.state.timer !== undefined) clearInterval(this.state.timer);
    const incomplete = [...this.state.incomplete.entries()];
    this.state.incomplete.clear();
    const now = Date.now();
    for (const [spanId, item] of incomplete) this.record({
      schema: "agentloop.runtimePerformance/v1", kind: "diagnostic_status", name: "diagnostic.incomplete_span",
      ...item.context, spanId, startedAt: item.startedAt, endedAt: now, durationMs: Math.max(0, now - item.startedAt), status: "error",
      attributes: { originalName: item.name, reason: "diagnostics_closed_before_span_completed" },
    });
    await this.flush();
    try { await this.sink.close?.(); } catch { this.state.sinkFailures += 1; }
  }

  private record(record: RuntimePerformanceRecord): void {
    if (this.state.closed && record.name !== "diagnostic.incomplete_span") return;
    this.state.accepted += 1;
    if (record.runId !== undefined && (record.kind === "span" || record.name === "run.environment")) {
      const retained = this.state.byRun.get(record.runId) ?? [];
      retained.push(record);
      this.state.retainedSummaryRecords += 1;
      this.state.byRun.set(record.runId, retained);
      while (this.state.retainedSummaryRecords > this.capacity) this.dropOldestSummaryRecord();
    }
    if (this.state.queue.length >= this.capacity) {
      if (record.kind === "run_summary" || record.kind === "diagnostic_status") {
        this.state.queue.shift();
        this.state.dropped += 1;
      } else {
        this.state.dropped += 1;
        return;
      }
    }
    this.state.queue.push(record);
    if (this.state.queue.length >= this.batchSize) this.scheduleFlush();
  }

  private dropOldestSummaryRecord(): void {
    let oldestRunId: string | undefined;
    let oldestStartedAt = Number.POSITIVE_INFINITY;
    for (const [runId, records] of this.state.byRun) {
      const startedAt = records[0]?.startedAt;
      if (startedAt !== undefined && startedAt < oldestStartedAt) { oldestRunId = runId; oldestStartedAt = startedAt; }
    }
    if (oldestRunId === undefined) return;
    const records = this.state.byRun.get(oldestRunId)!;
    records.shift();
    this.state.retainedSummaryRecords = Math.max(0, this.state.retainedSummaryRecords - 1);
    this.state.dropped += 1;
    if (records.length === 0) this.state.byRun.delete(oldestRunId);
  }

  private scheduleFlush(): void {
    if (this.state.flushScheduled || this.state.closed) return;
    this.state.flushScheduled = true;
    const immediate = setImmediate(() => {
      this.state.flushScheduled = false;
      void this.flush();
    });
    immediate.unref();
  }

  private async flushBatches(): Promise<void> {
    while (this.state.queue.length > 0) {
      const batch = this.state.queue.splice(0, this.batchSize);
      try {
        await this.sink.write(batch);
        this.state.written += batch.length;
      } catch {
        this.state.sinkFailures += 1;
        this.state.dropped += batch.length;
      }
    }
  }
}

export class JsonlRuntimePerformanceSink implements RuntimePerformanceSink {
  private handle?: Awaited<ReturnType<typeof open>>;
  private readonly file: string;
  constructor(file: string) { this.file = file; }
  async write(records: readonly RuntimePerformanceRecord[]): Promise<void> {
    if (this.handle === undefined) {
      await mkdir(dirname(this.file), { recursive: true });
      this.handle = await open(this.file, "a");
    }
    await this.handle.appendFile(`${records.map(record => JSON.stringify(record)).join("\n")}\n`);
  }
  async close(): Promise<void> { await this.handle?.close(); this.handle = undefined; }
}

export function currentRuntimePerformanceDiagnostics(): RuntimePerformanceDiagnostics | undefined {
  return diagnosticsStorage.getStore() ?? activeDiagnostics;
}
export function currentRuntimePerformanceContext(): RuntimePerformanceContext | undefined { return contextStorage.getStore(); }
export function withRuntimePerformanceContext<T>(context: RuntimePerformanceContext, operation: () => T): T {
  return activeDiagnostics?.runWithContext(context, operation) ?? contextStorage.run(mergeContext(contextStorage.getStore(), context), operation);
}
export async function runtimePerformanceSpan<T>(
  name: string,
  attributes: Readonly<Record<string, unknown>> | undefined,
  operation: () => T | Promise<T>,
): Promise<T> {
  const diagnostics = diagnosticsStorage.getStore() ?? activeDiagnostics;
  return diagnostics === undefined ? await operation() : await diagnostics.span(name, attributes, operation);
}
export function runtimePerformanceInstant(name: string, attributes?: Readonly<Record<string, unknown>>): void {
  (diagnosticsStorage.getStore() ?? activeDiagnostics)?.instant(name, attributes);
}

export function createRuntimePerformanceDiagnosticsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimePerformanceDiagnostics | undefined {
  const file = environment.AGENTLOOP_RUNTIME_DIAGNOSTICS_FILE?.trim();
  if (!file) return undefined;
  return new RuntimePerformanceDiagnostics({
    sink: new JsonlRuntimePerformanceSink(file),
    capacity: optionalEnvironmentInteger(environment.AGENTLOOP_RUNTIME_DIAGNOSTICS_CAPACITY),
    batchSize: optionalEnvironmentInteger(environment.AGENTLOOP_RUNTIME_DIAGNOSTICS_BATCH_SIZE),
    flushIntervalMs: optionalEnvironmentInteger(environment.AGENTLOOP_RUNTIME_DIAGNOSTICS_FLUSH_MS),
  });
}

function mergeContext(base: RuntimePerformanceContext | undefined, overlay: RuntimePerformanceContext): RuntimePerformanceContext {
  return { ...(base ?? {}), ...Object.fromEntries(Object.entries(overlay).filter(([, value]) => value !== undefined)) };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return resolved;
}

function optionalEnvironmentInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
