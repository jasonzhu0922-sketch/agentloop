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
  const { RunService } = await import("../src/runtime/run-service.ts");
  const { SkillService } = await import("../src/skills/skill-service.ts");
  const { singleStepTestPlanner, approvingTestAssessor, TEST_MODEL_LIMITS } = await import("../tests/runtime-test-helpers.ts");
  for (const backend of ["sqlite-disk", "redis-native-records", "redis-legacy-changeset"]) for (const concurrency of (process.env.AGENTLOOP_BENCHMARK_CONCURRENCY ?? "1,8,16").split(",").map(Number)) {
    const prefix = `benchmark:{${randomUUID()}}`, commandTimes = [];
    const clients = [];
    const adapter = () => {
      const client = new RuntimeRedisClient(`redis://127.0.0.1:${port}`); clients.push(client);
      return { async sendCommand(args) { const start = performance.now(); try { return await client.sendCommand(args); } finally { commandTimes.push(performance.now() - start); } }, close: () => client.close() };
    };
    let state, other;
    if (backend === "redis-native-records") { state = await RedisRuntimeRecords.open(adapter(), { prefix }); other = await RedisRuntimeRecords.open(adapter(), { prefix }); }
    else {
      const sql = backend === "sqlite-disk" ? new AppDatabase(join(directory, `${randomUUID()}.sqlite`)) :
        await AppDatabase.open({ connection: await RuntimeStateConnection.open(new RedisRuntimeStateStore(adapter(), { prefix })) });
      await sql.ready(); state = runtimePersistence(sql); other = state;
    }
    const catalogue = new AppDatabase(join(directory, `${randomUUID()}-catalogue.sqlite`));
    const services = [state, other].map(database => new RunService({ database, skills: new SkillService(catalogue), workspaceRoot: directory,
      plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async () => ({ content: "Verified benchmark answer.", finishReason: "stop", toolCalls: [] }) }) }));
    try {
      const count = Number(process.env.AGENTLOOP_BENCHMARK_RUNS ?? 32), latencies = []; let next = 0;
      commandTimes.length = 0; const start = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
        for (;;) {
          const index = next++; if (index >= count) break;
          const started = performance.now(), run = await services[worker % 2].execute("benchmark", `Explain benchmark statement ${index}.`);
          await services[worker % 2].whenRunIdle(run.id);
          if (run.status !== "completed" || run.output !== "Verified benchmark answer.") throw new Error(`Benchmark Run failed: ${JSON.stringify(run)}`);
          latencies.push(performance.now() - started);
        }
      }));
      const elapsedMs = performance.now() - start;
      const row = { backend, concurrency, serviceInstances: 2, completedRuns: latencies.length, elapsedMs, runsPerSecond: latencies.length * 1000 / elapsedMs,
        runLatencyMs: { p50: percentile(latencies, .5), p95: percentile(latencies, .95), max: Math.max(...latencies) },
        redisCommands: commandTimes.length, redisCommandsPerRun: commandTimes.length / latencies.length,
        redisCommandLatencyMs: commandTimes.length ? { p50: percentile(commandTimes, .5), p95: percentile(commandTimes, .95) } : undefined };
      metrics.push(row); console.log(JSON.stringify(row));
    } finally {
      for (const service of services) await service.closeRunEvents();
      if (other !== state) await other.close(); await state.close(); await catalogue.close();
    }
  }
  const report = { recordedAt: new Date().toISOString(), node: process.version, platform: `${platform()}-${arch()}`,
    scope: "Full RunService, deterministic mocked model, single-step Plan, Action, Result/Outcome, durable event commits. Two service instances in one process; no HTTP, external model/tools, archive or TiDB projection. A concurrency sweep, not a sustained production capacity claim.",
    redis: { appendonly: true, appendfsync: "always", maxmemoryPolicy: "noeviction", topology: "one temporary local Redis server" }, metrics };
  if (process.argv[2]) await writeFile(resolve(process.argv[2]), JSON.stringify(report, null, 2) + "\n");
} finally {
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise(resolve => server.once("exit", resolve)); }
  await rm(directory, { recursive: true, force: true });
}
