import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalRuntimeFactory, LocalRunAdmissionService, LocalMemorySettlementReader } from "@zhujun/agentloop-local-runtime/host";
import { LocalMemoryOutcomes } from "../src/memory/local-memory-outcomes.ts";
import { InMemoryMemoryStore } from "@zhujun/agentloop-memory";
import { modelPort } from "./fixtures/models.ts";

test("Local Runtime chooses sqlite → native redis → sqlite with isolated history, native admission and Memory evidence", async t => {
  const root = await mkdtemp(join(tmpdir(), "local-native-state-"));
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const redisDirectory = join(root, "redis"); await mkdir(redisDirectory);
  const redis = spawn("redis-server", ["--bind", "127.0.0.1", "--port", String(port), "--dir", redisDirectory,
    "--appendonly", "yes", "--appendfsync", "always", "--maxmemory-policy", "noeviction", "--save", ""], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { if (redis.exitCode === null) { redis.kill("SIGTERM"); await new Promise(resolve => redis.once("exit", resolve)); } await rm(root, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Redis startup timeout")), 10000);
    redis.once("error", error => { clearTimeout(timer); reject(error); });
    redis.stdout.on("data", data => { if (String(data).includes("Ready to accept connections")) { clearTimeout(timer); resolve(); } });
  });
  const skills = join(root, "skills"); await mkdir(skills);
  const definition = { id: "device", storageKey: "default", displayName: "Device", isDefault: true };
  const configuration = { customSkillDirectories: [], mcpServers: [], integrationEnvironment: { WEB_SEARCH_DISABLED: "1" } };
  const open = (backend: "sqlite" | "redis") => new LocalRuntimeFactory({ databasePath: join(root, "runtime.sqlite"),
    skillPackageStoreRoot: join(root, "packages"), models: modelPort(), environment: { AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: skills,
      AGENTLOOP_RUNTIME_STATE_BACKEND: backend, AGENTLOOP_RUNTIME_REDIS_URL: `redis://127.0.0.1:${port}`, AGENTLOOP_RUNTIME_REDIS_NAMESPACE: "local-contract" },
  }).create(definition, configuration, join(root, "workspace"), join(root, "uploads"));
  const input = { requestId: "same", input: "你好", modelKey: "local:test" };
  let localId: string, nativeId: string;
  for (const backend of ["sqlite", "redis", "redis", "sqlite"] as const) {
    const control = await open(backend), admissions = new LocalRunAdmissionService(control);
    try {
      const run = await admissions.start("owner", input); await control.runs.whenRunIdle(run.id); await admissions.flushSettlements();
      assert.equal((await control.runs.get("owner", run.id)).status, "completed");
      if (backend === "sqlite") { localId ??= run.id; assert.equal(run.id, localId); }
      else {
        nativeId ??= run.id; assert.equal(run.id, nativeId); assert.notEqual(run.id, localId!);
        assert.equal((await control.database.prepare("SELECT COUNT(*) AS n FROM runs WHERE id=?").get<{ n: number }>(run.id))!.n, 0);
        assert.equal((await control.runtimeState!.records.find("runtime_executors", { remote_run_id: run.id }))[0].runtime_id, "local:device");
        const memory = new InMemoryMemoryStore();
        const poller = new LocalMemoryOutcomes({ store: memory, tenantId: "device", sources: () => [{ sourceId: "native", database: control.runtimeState! }] });
        await poller.poll(); await poller.poll();
        const jobs = await memory.settlementJobs({ tenantId: "device", ownerUserId: "owner" }, run.id); assert.equal(jobs.length, 1);
        const evidence = await new LocalMemorySettlementReader(control.runtimeState!, "device").read({ tenantId: "device", ownerUserId: "owner", runId: run.id, terminalCommitRef: jobs[0]!.terminalCommitRef });
        assert.ok(evidence);
      }
    } finally { await control.close?.(); await control.database.close(); }
  }
  const control = await open("redis");
  try {
    const admissions = new LocalRunAdmissionService(control);
    const run = await admissions.start("owner", input);
    await control.runs.deleteConversation("owner", run.conversationId!);
    await assert.rejects(admissions.start("owner", input), /admission_run_deleted/);
    assert.equal(await new LocalMemorySettlementReader(control.runtimeState!, "device").isDeleted({ tenantId: "device", ownerUserId: "owner", runId: run.id }), true);
  } finally { await control.close?.(); await control.database.close(); }
});
