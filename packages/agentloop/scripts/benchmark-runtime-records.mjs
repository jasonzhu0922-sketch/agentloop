import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, platform, arch } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { AppDatabase } from "../src/storage/database.ts";
import { runtimePersistence } from "../src/storage/runtime-records.ts";
import { RedisRuntimeRecords } from "../src/storage/redis-runtime-records.ts";
import { RuntimeRedisClient } from "../src/storage/runtime-redis-client.ts";
import { RedisRuntimeStateStore } from "../src/storage/redis-runtime-state-store.ts";
import { RuntimeStateConnection } from "../src/storage/runtime-state-connection.ts";
import { RunRepository } from "../src/storage/repositories/run-repository.ts";
import { PlanningBudgetRepository } from "../src/runtime/planning-budget-repository.ts";

const directory = await mkdtemp(join(tmpdir(), "agentloop-record-benchmark-"));
let server;
const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))];
try {
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  server = spawn("redis-server", ["--bind", "127.0.0.1", "--port", String(port), "--dir", directory,
    "--appendonly", "yes", "--appendfsync", "always", "--maxmemory-policy", "noeviction", "--save", ""], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Temporary Redis startup timeout")), 10000);
    server.once("error", error => { clearTimeout(timer); reject(error); });
    server.once("exit", code => { clearTimeout(timer); reject(new Error(`Temporary Redis exited ${code}`)); });
    server.stdout.on("data", data => { if (String(data).includes("Ready to accept connections")) { clearTimeout(timer); resolve(); } });
  });
  const metrics = [];
  for (const backend of ["sqlite-disk", "redis-native-records", "redis-legacy-changeset"]) for (const concurrency of [1, 8, 32]) {
    const client = new RuntimeRedisClient(`redis://127.0.0.1:${port}`), commandTimes = [];
    const portAdapter = { async sendCommand(args) { const start = performance.now(); try { return await client.sendCommand(args); } finally { commandTimes.push(performance.now() - start); } }, close: () => client.close() };
    const prefix = `benchmark:{${randomUUID()}}`;
    let state;
    if (backend === "redis-native-records") state = await RedisRuntimeRecords.open(portAdapter, { prefix });
    else {
      const sql = backend === "sqlite-disk" ? new AppDatabase(join(directory, `${randomUUID()}.sqlite`)) :
        await AppDatabase.open({ connection: await RuntimeStateConnection.open(new RedisRuntimeStateStore(portAdapter, { prefix })) });
      await sql.ready(); state = runtimePersistence(sql);
    }
    try {
      const runs = new RunRepository(state), budgets = new PlanningBudgetRepository(state), transactionsPerRun = 8;
      for (let i = 0; i < concurrency; i++) {
        await runs.insertRun({ id: String(i), ownerUserId: "benchmark", allowDangerousTools: false, input: "storage workload", createdAt: 1 });
        await budgets.initialize(String(i), transactionsPerRun + 1, 1);
        await runs.appendEvent(String(i), { type: "benchmark.started", data: {}, createdAt: 1 });
      }
      commandTimes.length = 0;
      const latencies = [], start = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async (_, runIndex) => {
        for (let iteration = 0; iteration < transactionsPerRun; iteration++) {
          const started = performance.now();
          await state.transaction(async () => {
            await budgets.consume(String(runIndex), iteration + 2);
            await runs.appendEvent(String(runIndex), { type: "benchmark.progress", data: { iteration }, createdAt: iteration + 2 });
          });
          latencies.push(performance.now() - started);
        }
      }));
      const elapsedMs = performance.now() - start, redisCommands = commandTimes.length;
      for (let i = 0; i < concurrency; i++) {
        const budget = (await state.records.find("run_planning_budgets", { run_id: String(i) }))[0];
        if (budget.used_turns !== transactionsPerRun || (await runs.eventsByRun(String(i))).length !== transactionsPerRun + 1) throw new Error("Benchmark state verification failed");
      }
      const row = { backend, concurrency, transactions: latencies.length, elapsedMs, transactionsPerSecond: latencies.length * 1000 / elapsedMs,
        transactionLatencyMs: { p50: percentile(latencies, .5), p95: percentile(latencies, .95), max: Math.max(...latencies) },
        redisCommands, redisCommandsPerTransaction: redisCommands / latencies.length };
      metrics.push(row); console.log(JSON.stringify(row));
    } finally { await state.close(); await client.close(); }
  }
  const report = { recordedAt: new Date().toISOString(), node: process.version, platform: `${platform()}-${arch()}`,
    scope: "Storage-only budget consumption plus one ordered event per transaction. No model, tools, RunService, HTTP, archive or TiDB projection.",
    redis: { appendonly: true, appendfsync: "always", maxmemoryPolicy: "noeviction", topology: "one temporary local Redis server" }, metrics };
  if (process.argv[2]) await writeFile(resolve(process.argv[2]), JSON.stringify(report, null, 2) + "\n");
} finally {
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise(resolve => server.once("exit", resolve)); }
  await rm(directory, { recursive: true, force: true });
}
