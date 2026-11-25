import { promisify } from "node:util";
import { RuntimeStateConnection } from "../src/storage/runtime-state-connection.ts";
import { RedisRuntimeStateStore } from "../src/storage/redis-runtime-state-store.ts";
import { streamRuntimeRun } from "../src/runtime/runtime-run-stream.ts";
import { createServer as createHttpServer } from "node:http";
import { exportRuntimeRecords, importRuntimeRecords } from "../src/storage/runtime-record-transfer.ts";
import { HUMAN_LOOP_TOOL_NAME } from "../src/tools/human-loop-tool.ts";
import { RuntimeRecordMaintenance, SqlRuntimeSummarySink, restoreRuntimeArchives } from "../src/storage/runtime-record-maintenance.ts";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { singleStepTestPlanner, approvingTestAssessor, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { RunInputRepository } from "../src/runtime/run-input-repository.ts";
import { RunOutcomeRepository } from "../src/storage/repositories/outcome-repository.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { runtimePersistence, type RuntimePersistence } from "../src/storage/runtime-records.ts";
import { RedisRuntimeRecords } from "../src/storage/redis-runtime-records.ts";
import { RuntimeRedisClient } from "../src/storage/runtime-redis-client.ts";
import { PlanningBudgetRepository } from "../src/runtime/planning-budget-repository.ts";
import type { RuntimeRedisPort } from "../src/storage/redis-runtime-state-store.ts";
import { RunRepository } from "../src/storage/repositories/run-repository.ts";
import { HumanLoopRepository } from "../src/runtime/human-loop.ts";
import { CanonicalRunStateRepository } from "../src/runtime/canonical-run-state-repository.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { openRuntimeRecordBackend } from "../src/storage/runtime-record-backend.ts";
import { appendRunEvent, appendRunEvents } from "../src/storage/repositories/run-event-sequencer.ts";

let directory: string, process: ChildProcess, url: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "agentloop-native-contract-"));
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  url = `redis://127.0.0.1:${port}`;
  process = spawn("redis-server", ["--bind", "127.0.0.1", "--port", String(port), "--dir", directory,
    "--appendonly", "yes", "--appendfsync", "always", "--maxmemory-policy", "noeviction", "--save", ""], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Temporary Redis did not start")), 10000);
    process.once("error", error => { clearTimeout(timer); reject(error); });
    process.once("exit", code => { clearTimeout(timer); reject(new Error(`Temporary Redis exited: ${code}`)); });
    process.stdout!.on("data", data => { if (String(data).includes("Ready to accept connections")) { clearTimeout(timer); resolve(); } });
  });
});
after(async () => {
  if (process && process.exitCode === null) { process.kill("SIGTERM"); await new Promise(resolve => process.once("exit", resolve)); }
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function open(backend: "sqlite" | "redis", id = randomUUID()): Promise<RuntimePersistence> {
  if (backend === "redis") return await RedisRuntimeRecords.open(new RuntimeRedisClient(url), { prefix: `contract:{${id}}` });
  const sql = new AppDatabase(join(directory, `${id}.sqlite`)); await sql.ready(); return runtimePersistence(sql);
}
async function run(db: RuntimePersistence, id = "run") {
  await db.records.insert("runs", { id, owner_user_id: "owner", depth: 0, allow_dangerous_tools: 0, input: "test", status: "running", created_at: 1 });
}
for (const backend of ["sqlite", "redis"] as const) {
  test(`${backend}: early tool dispatch overlaps its streaming model and commits each effect once`, async () => {
    const id = randomUUID(), db = await open(backend, id);
    const catalogue = new AppDatabase(join(directory, `${id}-catalogue.sqlite`));
    await mkdir(join(directory, id));
    let effects = 0, turns = 0, effectStarted!: () => void;
    const ready = new Promise<void>(resolve => { effectStarted = resolve; });
    const service = new RunService({ database: db, skills: new SkillService(catalogue), workspaceRoot: join(directory, id),
      plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
      tools: [{ name: "echo", description: "Read a fixture value", inputSchema: { type: "object" }, executionMode: "parallel", replaySafe: true,
        parse: value => value, execute: async () => { effects++; effectStarted(); return { value: 42 }; } }],
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS,
        complete: async () => ({ content: "The value is 42.", finishReason: "stop", toolCalls: [] }),
        streamComplete: async (_request, sink) => {
          if (++turns !== 1) return { content: "The value is 42.", finishReason: "stop", toolCalls: [] };
          const call = { id: "early-echo", name: "echo", arguments: {} };
          await sink({ type: "tool_call_ready", index: 0, ...call });
          await Promise.all(Array.from({ length: 16 }, () => sink({ type: "text_delta", text: " " })));
          await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("Tool was not dispatched before model completion")), 3000))]);
          return { content: "", finishReason: "tool_calls", toolCalls: [call] };
        } }),
    });
    try {
      const result = await service.execute("owner", "Read the fixture with echo and answer.");
      assert.equal(result.status, "completed"); assert.equal(effects, 1);
      const events = await service.events("owner", result.id);
      assert.ok(events.some(e => e.type === "tool.completed"));
      assert.equal(events.some(e => e.type === "model.request.failed"), false);
      assert.deepEqual(events.map(e => e.seq), Array.from({ length: events.length }, (_, i) => i + 1));
      assert.ok((await new RuntimeActionRepository(db).list(result.id)).every(action => action.state === "succeeded"));
    } finally { await service.closeRunEvents(); await db.close(); await catalogue.close(); }
  });
  test(`${backend}: Action transactions overlap streaming events without repeating effects`, async () => {
    const db = await open(backend);
    try {
      await run(db);
      const actions = new RuntimeActionRepository(db);
      let effects = 0;
      const observing = (async () => {
        for (let i = 0; i < 40; i++) await appendRunEvent(db, "run", { type: "assistant.streaming", data: { i }, createdAt: i });
      })();
      await Promise.all([observing, ...Array.from({ length: 4 }, () => actions.execute({ runId: "run", kind: "tool_call", replayPolicy: "unsafe", deadlineMs: 10000 }, async () => {
        effects++; await new Promise(resolve => setTimeout(resolve, 1)); return "tool receipt";
      }))]);
      assert.equal(effects, 4);
      const stored = await actions.list("run");
      assert.equal(stored.length, 4); assert.ok(stored.every(action => action.state === "succeeded"));
      const events = (await db.records.find("run_events", { run_id: "run" })).sort((a, b) => a.seq - b.seq);
      assert.equal(events.length, 56);
      assert.deepEqual(events.map(e => e.seq), Array.from({ length: 56 }, (_, i) => i + 1));
    } finally { await db.close(); }
  });
  test(`${backend}: a streaming model with overlapping sink callbacks finishes its Run`, async () => {
    const id = randomUUID(), db = await open(backend, id);
    const catalogue = new AppDatabase(join(directory, `${id}-catalogue.sqlite`));
    await mkdir(join(directory, id));
    const service = new RunService({ database: db, skills: new SkillService(catalogue), workspaceRoot: join(directory, id),
      plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS,
        complete: async () => ({ content: "Streamed answer.", finishReason: "stop", toolCalls: [] }),
        streamComplete: async (_request, emit) => {
          await Promise.all(Array.from({ length: 16 }, () => emit({ type: "text_delta", text: "text " })));
          return { content: "Streamed answer.", finishReason: "stop", toolCalls: [] };
        },
      }) });
    try {
      const result = await service.execute("owner", "Answer the statement.").catch(async error => {
        const id = error.details?.runId;
        const failures = id ? (await service.events("owner", id)).filter(event => /failed|error/.test(event.type)) : error;
        throw new Error(JSON.stringify(failures), { cause: error });
      });
      assert.equal(result.status, "completed");
      const events = await service.events("owner", result.id);
      assert.ok(events.some(event => event.type === "assistant.streaming"));
      assert.deepEqual(events.map(event => event.seq), Array.from({ length: events.length }, (_, i) => i + 1));
    } finally { await service.closeRunEvents(); await db.close(); await catalogue.close(); }
  });
  test(`${backend}: concurrent streaming and action event writers allocate every sequence exactly once`, async () => {
    const id = randomUUID(), db = await open(backend, id);
    const second = backend === "redis" ? await open(backend, id) : db;
    try {
      await run(db);
      const sequences = await Promise.all(Array.from({ length: 48 }, (_, i) =>
        i % 2 ? appendRunEvent(db, "run", { type: "model.stream", data: { index: i }, createdAt: i }) :
          appendRunEvents(second, "run", [{ type: "action.observed", data: { index: i }, createdAt: i },
            { type: "action.persisted", data: { index: i }, createdAt: i }])));
      const expected = Array.from({ length: 72 }, (_, i) => i + 1);
      assert.deepEqual(sequences.flat().sort((a, b) => a - b), expected);
      const events = await db.records.find("run_events", { run_id: "run" });
      assert.deepEqual(events.map(e => e.seq).sort((a, b) => a - b), expected);
      assert.equal((await db.records.find("run_event_sequences", { run_id: "run" }))[0].next_seq, 73);
    } finally { if (second !== db) await second.close(); await db.close(); }
  });
  test(`${backend}: deleting a terminal conversation never reconciles another executor's live Run`, async () => {
    const db = await open(backend), catalogue = new AppDatabase(join(directory, `${randomUUID()}-control.sqlite`));
    const service = new RunService({ database: db, executionRuntimeId: "host-b", skills: new SkillService(catalogue),
      workspaceRoot: directory, modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async () => ({ content: "ok", finishReason: "stop", toolCalls: [] }) }) });
    try {
      const repository = new RunRepository(db);
      await repository.insertConversation({ id: "done", ownerUserId: "owner", title: "done", createdAt: 1 });
      await run(db, "terminal"); await db.records.update("runs", { id: "terminal" }, () => ({ conversation_id: "done", status: "completed" }));
      await run(db, "remote");
      await db.records.insert("runtime_executors", { remote_run_id: "remote", runtime_id: "host-a", dispatch_key: "remote", owner_user_id: "owner", accepted_at: 1 });
      await service.deleteConversation("owner", "done");
      assert.equal((await repository.get("remote"))?.status, "running");
      assert.equal(await service.reconcileInterruptedRuns(), 0);
      for (const command of [() => service.respondHumanLoop("owner", "remote", "request", {}, 1),
        () => service.submitInput("owner", "remote", { requestId: "input", text: "continue" }),
        () => service.cancel("owner", "remote"), () => service.advanceRecovery("owner", "remote"),
        () => service.resumeRecovery("owner", "remote"), () => service.reconcileInterruptedRuns(["remote"])])
        await assert.rejects(command(), (error: any) => error.details?.reason === "runtime_execution_owner_mismatch" && error.details.runtimeId === "host-a");
      assert.equal((await repository.get("remote"))?.status, "running");
      assert.equal((await db.records.find("run_input_messages", { run_id: "remote" })).length, 0);
    } finally { await service.closeRunEvents(); await db.close(); await catalogue.close(); }
  });
  test(`${backend}: full HIL Run pauses, reopens, resumes and finishes without replaying old tool effects`, async () => {
    const id = randomUUID(); let db = await open(backend, id); let calls = 0;
    const catalogue = new AppDatabase(join(directory, `${id}-catalogue.sqlite`)); await mkdir(join(directory, id));
    const create = () => new RunService({ database: db, skills: new SkillService(catalogue), workspaceRoot: join(directory, id),
      plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async () => ++calls === 1 ?
        { content: "", finishReason: "tool_calls", toolCalls: [{ id: "choose", name: HUMAN_LOOP_TOOL_NAME, arguments: {
          kind: "selection", title: "Choose", prompt: "Choose source", rationale: "User scope", evidenceRefs: [],
          responseSchema: { type: "select", minSelections: 1, maxSelections: 1, options: [{ id: "group", label: "Group" }] }, resume: { mode: "continue_step" },
        } }] } : { content: "Resumed answer.", finishReason: "stop", toolCalls: [] } }) });
    let service = create();
    try {
      const started = await service.execute("owner", "Query selected source"); await service.whenRunIdle(started.id);
      const request = await service.currentHumanLoop("owner", started.id); assert.ok(request);
      await service.closeRunEvents(); await db.close(); db = await open(backend, id); service = create();
      await service.reconcileInterruptedRuns([started.id]);
      await service.respondHumanLoop("owner", started.id, request.id, ["group"], request.revision);
      for (let attempt = 0; attempt < 500 && (await service.get("owner", started.id)).status === "running"; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      await service.whenRunIdle(started.id);
      assert.equal((await service.get("owner", started.id)).status, "completed"); assert.equal(calls, 2);
      assert.equal(await service.currentHumanLoop("owner", started.id), undefined);
    } finally { await service.closeRunEvents(); await db.close(); await catalogue.close(); }
  });
  test(`${backend}: offline transfer is checksummed, resumable and preserves parent/child and event indexes`, async () => {
    const source = await open(backend), target = await open(backend === "redis" ? "sqlite" : "redis");
    try {
      await run(source, "parent"); await source.records.insert("runs", { id: "child", parent_run_id: "parent", depth: 1, allow_dangerous_tools: 0, owner_user_id: "owner", input: "child", status: "running", created_at: 2 });
      await new RunRepository(source).appendEvent("child", { type: "sample", data: {}, createdAt: 2 });
      const manifest = await exportRuntimeRecords(source, "frozen-test");
      const imported = await importRuntimeRecords(target, manifest); assert.ok(imported.inserted >= 3);
      assert.equal((await importRuntimeRecords(target, manifest)).inserted, 0);
      assert.equal((await exportRuntimeRecords(target, "frozen-test")).sha256, manifest.sha256);
      assert.deepEqual((await new RunRepository(target).eventsByRunAfter("child", 0)).map(row => row.type), ["sample"]);
      const tampered = structuredClone(manifest); tampered.tables.runs![0].input = "changed";
      await assert.rejects(importRuntimeRecords(target, tampered), /checksum/);
      await target.records.update("runs", { id: "child" }, () => ({ input: "changed" }));
      await assert.rejects(importRuntimeRecords(target, manifest), /target differs/);
    } finally { await source.close(); await target.close(); }
  });

  test(`${backend}: complete RunService executes with separate catalogue and reopens its Plan, Actions, Result and Outcome`, async () => {
    const id = randomUUID(); let db = await open(backend, id);
    await mkdir(join(directory, id));
    const catalogue = new AppDatabase(join(directory, `${id}-catalogue.sqlite`));
    try {
      const service = new RunService({ database: db, skills: new SkillService(catalogue), workspaceRoot: join(directory, id),
        plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async () => ({ content: "The verified answer.", finishReason: "stop", toolCalls: [] }) }) });
      const run = await service.execute("owner", "Explain this statement.");
      assert.equal(run.status, "completed", JSON.stringify(await service.events("owner", run.id)));
      const plan = (await service.plan("owner", run.id)).plan;
      assert.equal(plan.status, "completed");
      assert.ok((await new RuntimeActionRepository(db).list(run.id)).every(action => action.state === "succeeded"));
      assert.equal((await catalogue.prepare("SELECT COUNT(*) AS n FROM runs").get<{ n: number }>())!.n, 0, "execution state never touches catalogue SQL");
      await service.closeRunEvents(); await db.close(); db = await open(backend, id);
      assert.equal((await new RunRepository(db).get(run.id))?.status, "completed");
      assert.equal(JSON.parse((await db.records.find("run_outcomes", { run_id: run.id }))[0].result_json!).kind, "run");
      const objects = new Map<string, Uint8Array>(); let manifest: { key: string; sha256: string } | undefined;
      const archive = { put: async (key: string, bytes: Uint8Array, sha256: string) => { objects.set(key, bytes); if (key.includes("/snapshots/")) manifest = { key, sha256 }; },
        get: async (key: string) => { const bytes = objects.get(key); if (!bytes) throw new Error("missing archive object"); return bytes; } };
      const worker = new RuntimeRecordMaintenance({ state: db, namespace: id, archive });
      await worker.archiveNow(); await worker.close(); assert.ok(manifest);
      const restored = await open(backend);
      try {
        await restoreRuntimeArchives(restored, archive, [manifest]);
        assert.equal((await new RunRepository(restored).get(run.id))?.output, "The verified answer.");
        assert.equal((await new RunRepository(restored).eventsByRunAfter(run.id, 0)).length, (await new RunRepository(db).eventsByRunAfter(run.id, 0)).length);
      } finally { await restored.close(); }
      await assert.rejects(new RunOutcomeRepository(db).commitStopped({ runId: run.id, status: "cancelled", reasonCode: "stale" }), /already terminal/);
      assert.equal((await db.records.find("run_outcomes", { run_id: run.id }))[0].status, "completed");
      const repository = new RunRepository(db);
      await repository.insertConversation({ id: "completed-chat", ownerUserId: "owner", title: "completed", createdAt: 1 });
      await db.records.update("runs", { id: run.id }, () => ({ conversation_id: "completed-chat" }));
      await repository.deleteConversation("owner", "completed-chat");
      for (const table of ["runs", "plans", "runtime_actions", "run_events", "run_outcomes"] as const)
        assert.equal((await db.records.find(table)).length, 0, `full Run cascade deletes ${table}`);
      assert.equal((await db.records.find("runtime_deletions", { run_id: run.id })).length, 1);
    } finally { await db.close(); await catalogue.close(); }
  });
  test(`${backend}: independent Runs execute concurrently through two service instances`, async () => {
    const id = randomUUID(); const db = await open(backend, id);
    const other = backend === "redis" ? await open(backend, id) : db;
    const catalogue = new AppDatabase(join(directory, `${id}-catalogue.sqlite`));
    await mkdir(join(directory, id));
    try {
      const services = [db, other].map(state => new RunService({ database: state, skills: new SkillService(catalogue), workspaceRoot: join(directory, id),
        plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async () => ({ content: "Concurrent answer.", finishReason: "stop", toolCalls: [] }) }) }));
      const results = await Promise.all(Array.from({ length: 4 }, (_, index) => services[index % 2].execute("owner", `Explain statement ${index}.`)));
      for (const run of results) {
        assert.equal(run.status, "completed", JSON.stringify(await services[0].events("owner", run.id)));
        assert.equal((await services[1].get("owner", run.id)).output, "Concurrent answer.");
        const events = await services[1].eventsAfter("owner", run.id, 2);
        assert.equal(events[0].seq, 3);
        assert.ok(events.every((event, index) => index === 0 || event.seq === events[index - 1].seq + 1));
      }
      for (const service of services) await service.closeRunEvents();
    } finally { if (other !== db) await other.close(); await db.close(); await catalogue.close(); }
  });
  test(`${backend}: durable subscription catches another instance and resumes from its Last-Event-ID`, async () => {
    const id = randomUUID(); const writer = await open(backend, id), reader = backend === "redis" ? await open(backend, id) : writer;
    const catalogue = new AppDatabase(join(directory, `${id}-catalogue.sqlite`));
    await mkdir(join(directory, id));
    const service = new RunService({ database: reader, skills: new SkillService(catalogue), workspaceRoot: join(directory, id), modelFactory: () => { throw new Error("read only"); } });
    try {
      await run(writer);
      const runs = new RunRepository(writer);
      await runs.appendEvent("run", { type: "first", data: {}, createdAt: 1 });
      const observed: number[] = [];
      let delivered!: () => void;
      const ready = new Promise<void>(resolve => { delivered = resolve; });
      const unsubscribe = service.subscribeRunEvents("run", event => { observed.push(event.seq); if (event.seq === 3) delivered(); }, 1);
      await runs.appendEvent("run", { type: "second", data: {}, createdAt: 2 });
      await runs.appendEvent("run", { type: "third", data: {}, createdAt: 3 });
      await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("subscription timeout")), 3000))]);
      unsubscribe(); assert.deepEqual(observed, [2, 3]);
      assert.equal((await new RunRepository(reader).latestEventByRun("run"))?.seq, 3);
      assert.deepEqual((await new RunRepository(reader).eventsByRunAfter("run", 2)).map(row => row.seq), [3]);
    } finally { await service.closeRunEvents(); if (reader !== writer) await reader.close(); await writer.close(); await catalogue.close(); }
  });
  test(`${backend}: input decision, Plan work and event roll back together; stale Action cannot commit after cancellation`, async () => {
    const db = await open(backend);
    try {
      await run(db); const inputs = new RunInputRepository(db);
      const message = await inputs.accept("owner", "run", { requestId: "stable", text: "change" });
      assert.equal((await inputs.accept("owner", "run", { requestId: "stable", text: "change" })).id, message.id);
      await inputs.claim("run", "consumer");
      await assert.rejects(inputs.finish(message, "consumer", "applied", {}, async () => {
        await db.records.update("runs", { id: "run" }, () => ({ output: "uncommitted" })); throw new Error("decision rollback");
      }), /decision rollback/);
      assert.equal((await inputs.list("run"))[0].status, "processing");
      assert.equal((await new RunRepository(db).get("run"))?.output, null);
      await inputs.finish(message, "consumer", "answered", {});
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const actions = new RuntimeActionRepository(db);
      const executing = actions.execute({ runId: "run", kind: "tool_call", replayPolicy: "unsafe", deadlineMs: 1000 }, async () => { entered(); await gate; return "late"; });
      await ready;
      await db.transaction(async () => { await actions.cancelDispatchedForRun("run"); await new RunOutcomeRepository(db).commitStopped({ runId: "run", status: "cancelled", reasonCode: "CANCELLED" }); });
      release(); await assert.rejects(executing, /lease was lost/);
      assert.equal((await actions.list("run"))[0].state, "failed");
      assert.equal((await db.records.find("run_outcomes", { run_id: "run" }))[0].status, "cancelled");
    } finally { await db.close(); }
  });
  test(`${backend}: failed summary projection retries independently from verified event archival`, async () => {
    const db = await open(backend); const summaries = new AppDatabase(join(directory, `${randomUUID()}-summary.sqlite`));
    const blobs = new Map<string, Uint8Array>(); let unavailable = true;
    const sink = new SqlRuntimeSummarySink(async () => { if (unavailable) throw new Error("TiDB unavailable"); return summaries; });
    const maintenance = new RuntimeRecordMaintenance({ state: db, namespace: "contract", archive: { async put(key, bytes) { blobs.set(key, bytes); } }, summary: sink });
    try {
      await new RunRepository(db).insertConversation({ id: "conversation", ownerUserId: "owner", title: "test", createdAt: 1 });
      await run(db);
      await db.records.update("runs", { id: "run" }, () => ({ conversation_id: "conversation" }));
      await new RunRepository(db).appendEvent("run", { type: "run.started", data: {}, createdAt: 1 });
      await new RunOutcomeRepository(db).commitStopped({ runId: "run", status: "failed", reasonCode: "test" });
      await assert.rejects(maintenance.projectNow(), /TiDB unavailable/);
      await maintenance.archiveNow();
      assert.equal(maintenance.status().archivedRuns, 1);
      assert.equal(maintenance.status().projectionPending, true);
      const manifest = [...blobs].find(([key]) => key.includes("/snapshots/"));
      assert.ok(manifest); assert.equal(JSON.parse(Buffer.from(manifest[1]).toString()).summary.run.status, "failed");
      unavailable = false; await maintenance.projectNow();
      assert.equal(maintenance.status().projectionPending, false);
      const current = await summaries.prepare("SELECT payload_json FROM runtime_run_summaries").get<{ payload_json: string }>();
      const latest = JSON.parse(current!.payload_json);
      await sink.write("contract", { ...latest, lastEventSeq: 0, outcome: { ...latest.outcome, reason_code: "stale" } });
      assert.equal(JSON.parse((await summaries.prepare("SELECT payload_json FROM runtime_run_summaries").get<{ payload_json: string }>())!.payload_json).outcome.reason_code, "test");
      assert.equal((await summaries.prepare("SELECT COUNT(*) AS n FROM run_events").get<{ n: number }>())!.n, 0);
      await new RunRepository(db).deleteConversation("owner", "conversation");
      assert.equal((await db.records.find("runtime_deletions", { run_id: "run" }))[0].last_seq, latest.lastEventSeq + 1);
      await maintenance.projectNow();
      await sink.write("contract", latest);
      assert.equal(JSON.parse((await summaries.prepare("SELECT payload_json FROM runtime_run_summaries").get<{ payload_json: string }>())!.payload_json).outcome.status, "deleted");
    } finally { await maintenance.close(); await db.close(); }
  });
  test(`${backend}: domain HIL survives reopening, answers and events commit together`, async () => {
    const id = randomUUID(); let db = await open(backend, id);
    try {
      const runs = new RunRepository(db);
      await runs.insertRun({ id: "run", ownerUserId: "owner", allowDangerousTools: false, input: "test", createdAt: 1 });
      const initial = createCanonicalRunState({ runId: "run", userInput: "test", understanding: understandTask({ objective: "test" }), now: 1 });
      await new CanonicalRunStateRepository(db).create(initial);
      const request = await new HumanLoopRepository(db).create({ runId: "run", origin: "planner", kind: "confirmation",
        title: "Continue", prompt: "Continue this work?", rationale: "Need a decision", evidenceRefs: [],
        responseSchema: { type: "confirm", acceptLabel: "Continue", rejectLabel: "Stop" }, resume: { mode: "run_input" } });
      await db.close(); db = await open(backend, id);
      const hil = new HumanLoopRepository(db);
      assert.equal((await hil.current("run"))?.id, request.id);
      await assert.rejects(db.transaction(async () => {
        await hil.respond({ runId: "run", requestId: request.id, actorUserId: "owner", expectedRevision: 1, value: true });
        throw new Error("rollback HIL");
      }), /rollback HIL/);
      assert.equal((await hil.current("run"))?.revision, 1);
      assert.equal((await new RunRepository(db).eventsByRun("run")).length, 1);
      await hil.respond({ runId: "run", requestId: request.id, actorUserId: "owner", expectedRevision: 1, value: true });
      await assert.rejects(hil.respond({ runId: "run", requestId: request.id, actorUserId: "owner", expectedRevision: 1, value: { accepted: false } }), /changed before response/);
      const events = await new RunRepository(db).eventsByRunAfter("run", 1);
      assert.deepEqual(events.map(event => [event.seq, event.type]), [[2, "human_loop.answered"]]);
      assert.equal((await hil.answers("run"))[0].eventSeq, 2);
      const states = new CanonicalRunStateRepository(db);
      const current = await states.get("run");
      const next = { ...current, revision: current.revision + 1, updatedAt: 2 };
      await states.commit({ expectedRevision: current.revision, state: next, reason: "test" });
      await assert.rejects(states.commit({ expectedRevision: current.revision, state: next, reason: "stale" }), /revision is stale/);
    } finally { await db.close(); }
  });
  test(`${backend}: records, Plan, Action, event and Outcome survive reopening`, async () => {
    const id = randomUUID(); let db = await open(backend, id);
    try {
      await db.transaction(async () => {
        await run(db);
        await db.records.insert("plans", { id: "plan", run_id: "run", version: 1, goal: "test", selected_skill_ids_json: "[]", status: "admitted", created_at: 1, updated_at: 1 });
        await db.records.insert("runtime_actions", { id: "action", run_id: "run", kind: "model_turn", state: "dispatched", attempt: 1, max_attempts: 1, fence: 1, revision: 1, replay_policy: "safe", metadata_json: "{}", created_at: 1, updated_at: 1 });
        await db.records.insert("run_events", { run_id: "run", seq: 1, type: "action.dispatched", payload_json: "{}", created_at: 1 });
      });
      await db.transaction(async () => {
        await db.records.update("runs", { id: "run", status: "running" }, () => ({ status: "completed", output: "answer", finished_at: 2 }));
        await db.records.insert("run_outcomes", { run_id: "run", plan_id: "plan", status: "completed", output: "answer", reason_code: "complete", committed_at: 2 });
      });
      await db.close(); db = await open(backend, id);
      assert.equal((await db.records.find("runs", { id: "run" }))[0].output, "answer");
      assert.equal((await db.records.find("runtime_actions", { run_id: "run" })).length, 1);
      assert.equal((await db.records.find("run_events", { run_id: "run" })).length, 1);
      assert.equal((await db.records.find("run_outcomes", { run_id: "run" }))[0].output, "answer");
    } finally { await db.close(); }
  });
  test(`${backend}: rollback includes budget, event and unique request`, async () => {
    const db = await open(backend); try {
      await run(db); const budgets = new PlanningBudgetRepository(db); await budgets.initialize("run", 2, 1);
      await assert.rejects(db.transaction(async () => {
        await budgets.consume("run", 2);
        await db.records.insert("run_events", { run_id: "run", seq: 1, type: "test", payload_json: "{}", created_at: 2 });
        await db.records.insert("run_input_messages", { id: "input", run_id: "run", owner_user_id: "owner", request_id: "request", seq: 1, text: "text", status: "accepted", created_at: 2, updated_at: 2 });
        throw new Error("abort");
      }), /abort/);
      assert.equal((await db.records.find("run_planning_budgets", { run_id: "run" }))[0].used_turns, 0);
      assert.equal((await db.records.find("run_events", { run_id: "run" })).length, 0);
      assert.equal((await db.records.find("run_input_messages", { run_id: "run" })).length, 0);
      await budgets.consume("run", 2); await budgets.consume("run", 3);
      await assert.rejects(budgets.consume("run", 4), /budget exhausted/);
    } finally { await db.close(); }
  });
  test(`${backend}: stale condition, request uniqueness and referential constraints`, async () => {
    const db = await open(backend); try {
      await run(db);
      assert.equal(await db.records.update("runs", { id: "run", status: "completed" }, () => ({ output: "stale" })), 0);
      const input = { run_id: "run", owner_user_id: "owner", request_id: "request", seq: 1, text: "text", status: "accepted", created_at: 1, updated_at: 1 };
      await db.records.insert("run_input_messages", { ...input, id: "input" });
      await assert.rejects(db.records.insert("run_input_messages", { ...input, id: "other" }));
      await db.records.insert("run_input_messages", { ...input, id: "ignored" }, "ignore");
      assert.equal((await db.records.find("run_input_messages", { run_id: "run" })).length, 1);
      await assert.rejects(db.records.insert("run_events", { run_id: "missing", seq: 1, type: "test", payload_json: "{}", created_at: 1 }));
    } finally { await db.close(); }
  });
  test(`${backend}: deletion cascades and releases uniqueness`, async () => {
    const db = await open(backend); try {
      await run(db);
      await db.records.insert("run_input_messages", { id: "input", run_id: "run", owner_user_id: "owner", request_id: "request", seq: 1, text: "text", status: "accepted", created_at: 1, updated_at: 1 });
      await db.records.remove("runs", { id: "run" });
      assert.equal((await db.records.find("run_input_messages", { run_id: "run" })).length, 0);
      await run(db);
      await db.records.insert("run_input_messages", { id: "other", run_id: "run", owner_user_id: "owner", request_id: "request", seq: 1, text: "text", status: "accepted", created_at: 1, updated_at: 1 });
      assert.equal((await db.records.find("run_input_messages", { run_id: "run" })).length, 1);
    } finally { await db.close(); }
  });
  test(`${backend}: a caught failed delete cannot commit an orphan`, async () => {
    const db = await open(backend); try {
      await run(db);
      await db.records.insert("sources", { id: "source", owner_user_id: "owner", original_name: "input.txt", mime_type: "text/plain", extension: ".txt",
        byte_size: 1, sha256: "hash", storage_path: "/temporary/input.txt", status: "ready", created_at: 1, updated_at: 1 });
      await db.records.insert("source_chunks", { source_id: "source", chunk_index: 0, kind: "text", locator: "0", content: "x", token_estimate: 1, sha256: "hash", created_at: 1 });
      await db.records.insert("run_sources", { run_id: "run", source_id: "source", position: 0, role: "user_supplied", created_at: 1 });
      await db.transaction(async () => {
        await assert.rejects(db.records.remove("sources", { id: "source" }));
        await db.records.update("runs", { id: "run" }, () => ({ output: "other update" }));
      });
      assert.equal((await db.records.find("sources", { id: "source" })).length, 1);
      assert.equal((await db.records.find("source_chunks", { source_id: "source" })).length, 1);
    } finally { await db.close(); }
  });
  test(`${backend}: external reads cannot observe a transaction which later rolls back`, async () => {
    const db = await open(backend); try {
      await run(db);
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const writing = db.transaction(async () => {
        await db.records.update("runs", { id: "run" }, () => ({ output: "provisional" })); entered(); await gate;
        throw new Error("rollback isolated write");
      });
      await ready;
      let observed: string | null | undefined;
      const reading = db.records.find("runs", { id: "run" }).then(rows => { observed = rows[0].output; });
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.notEqual(observed, "provisional");
      release(); await assert.rejects(writing, /rollback isolated write/); await reading;
      assert.equal(observed, null);
    } finally { await db.close(); }
  });
}

for (const stage of ["dispatch", "commit", "failure"] as const) test(`Redis: ${stage} reconciles a stream commit between counter read and event insertion`, async () => {
  const prefix = `contract:{${randomUUID()}}`, wire = new RuntimeRedisClient(url);
  let armed = stage === "dispatch", fired = false, blocked!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { blocked = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const db = await RedisRuntimeRecords.open({ close: () => wire.close(), sendCommand: async args => {
    const result = await wire.sendCommand(args);
    if (armed && !fired && args[0] === "EVAL" && args[3]?.includes(":r:run_event_sequences:")) {
      fired = true; blocked(); await gate;
    }
    return result;
  } }, { prefix });
  const observer = await RedisRuntimeRecords.open(new RuntimeRedisClient(url), { prefix });
  try {
    await run(db); await appendRunEvent(observer, "run", { type: "seed", data: {}, createdAt: 1 });
    let effects = 0;
    const actions = new RuntimeActionRepository(db);
    const executing = actions.execute({ runId: "run", kind: "tool_call", replayPolicy: "unsafe", deadlineMs: 10000 }, async () => {
      effects++; if (stage !== "dispatch") armed = true;
      if (stage === "failure") throw new Error("fixture operation failed");
      return "committed receipt";
    });
    const outcome = executing.then(value => ({ value }), error => ({ error }));
    await Promise.race([ready, outcome.then(() => { throw new Error("Expected counter-read barrier"); })]);
    await appendRunEvent(observer, "run", { type: "assistant.streaming", data: {}, createdAt: 2 });
    release();
    const result = await outcome;
    if (stage === "failure") assert.match("error" in result ? String(result.error) : "", /fixture operation failed/);
    else assert.deepEqual(result, { value: "committed receipt" });
    assert.equal(effects, 1, "tool side effect must not be repeated when the state transaction retries");
    const stored = await actions.list("run"); assert.equal(stored.length, 1);
    assert.equal(stored[0].state, stage === "failure" ? "failed" : "succeeded");
    const events = (await db.records.find("run_events", { run_id: "run" })).sort((a, b) => a.seq - b.seq);
    assert.equal(events.length, 6);
    assert.deepEqual(events.map(event => event.seq), [1, 2, 3, 4, 5, 6]);
  } finally { release(); await db.close(); await observer.close(); }
});

test("record factory: sqlite -> redis -> sqlite isolates history and SQLite never opens Redis", async () => {
  const filename = join(directory, "switch.sqlite"), namespace = `contract:{${randomUUID()}}`;
  const forbidden: RuntimeRedisPort = { sendCommand: async () => { throw new Error("SQLite contacted Redis"); }, close: async () => {} };
  let db = await openRuntimeRecordBackend({ backend: "sqlite", filename }, { redis: forbidden });
  try { await run(db, "sqlite-only"); } finally { await db.close(); }
  db = await openRuntimeRecordBackend({ backend: "redis", url, namespace });
  try { assert.equal((await db.records.find("runs", { id: "sqlite-only" })).length, 0); await run(db, "redis-only"); } finally { await db.close(); }
  db = await openRuntimeRecordBackend({ backend: "sqlite", filename }, { redis: forbidden });
  try {
    assert.equal((await db.records.find("runs", { id: "sqlite-only" })).length, 1);
    assert.equal((await db.records.find("runs", { id: "redis-only" })).length, 0);
  } finally { await db.close(); }
});

test("Redis: two instances reject a stale writer without stopping unrelated Runs", async () => {
  const id = randomUUID(), one = await open("redis", id), two = await open("redis", id);
  try {
    await run(one, "a"); await run(one, "b");
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const stale = one.transaction(async () => {
      await one.records.find("runs", { id: "a" }); entered(); await gate;
      await one.records.update("runs", { id: "a" }, () => ({ output: "stale" }));
    });
    await ready;
    await two.records.update("runs", { id: "a" }, () => ({ output: "new" }));
    await one.records.update("runs", { id: "b" }, () => ({ output: "independent" }));
    release(); await assert.rejects(stale, /concurrent changes/);
    assert.equal((await one.records.find("runs", { id: "a" }))[0].output, "new");
    assert.equal((await two.records.find("runs", { id: "b" }))[0].output, "independent");
  } finally { await one.close(); await two.close(); }
});

test("Redis: lost commit response resolves receipt without reexecuting domain callback", async () => {
  const client = new RuntimeRedisClient(url); let armed = false, callbacks = 0;
  const port: RuntimeRedisPort = {
    async sendCommand(args) { const result = await client.sendCommand(args); if (armed && args[0] === "EVAL" && args[1].includes("local command=")) { armed = false; throw new Error("response lost"); } return result; },
    close: () => client.close(),
  };
  const db = await RedisRuntimeRecords.open(port, { prefix: `contract:{${randomUUID()}}` });
  try { armed = true; await db.transaction(async () => { callbacks++; await run(db); });
    assert.equal(callbacks, 1); assert.equal((await db.records.find("runs", { id: "run" })).length, 1);
  } finally { await db.close(); }
});

test("Redis: persistence failure never publishes provisional records and does not invoke SQL", async () => {
  const client = new RuntimeRedisClient(url); let armed = false;
  const db = await RedisRuntimeRecords.open({
    async sendCommand(args) { if (armed && args[0] === "EVAL" && args[1].includes("local command=")) throw new Error("storage unavailable"); return await client.sendCommand(args); },
    close: () => client.close(),
  }, { prefix: `contract:{${randomUUID()}}` });
  try { armed = true; await assert.rejects(run(db), /storage unavailable/); armed = false;
    assert.equal((await db.records.find("runs", { id: "run" })).length, 0); await run(db);
  } finally { await db.close(); }
});

test("Redis: legacy namespace is preserved and requires explicit migration", async () => {
  const prefix = `contract:{${randomUUID()}}`, client = new RuntimeRedisClient(url);
  await client.sendCommand(["SET", `${prefix}:version`, "1"]);
  await assert.rejects(RedisRuntimeRecords.open(client, { prefix }), /explicit offline migration/);
  const reader = new RuntimeRedisClient(url); try { assert.equal(await reader.sendCommand(["GET", `${prefix}:version`]), "1"); } finally { await reader.close(); }
});

test("Redis: a slow commit confirmation does not hold a lock across unrelated Runs", async () => {
  const client = new RuntimeRedisClient(url); let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const db = await RedisRuntimeRecords.open({
    async sendCommand(args) {
      const result = await client.sendCommand(args);
      if (args[0] === "EVAL" && args[1].includes("local command=") && args.at(-2)!.includes("slow-confirmation")) { entered(); await gate; }
      return result;
    }, close: () => client.close(),
  }, { prefix: `contract:{${randomUUID()}}` });
  try {
    await run(db, "a"); await run(db, "b");
    const slow = db.records.update("runs", { id: "a" }, () => ({ output: "slow-confirmation" }));
    await ready;
    await db.records.update("runs", { id: "b" }, () => ({ output: "independent" }));
    assert.equal((await db.records.find("runs", { id: "b" }))[0].output, "independent");
    release(); await slow;
  } finally { release(); await db.close(); }
});

test("Redis: concurrent HIL creation detects predicate changes and commits only one request/event", async () => {
  const id = randomUUID(), one = await open("redis", id), two = await open("redis", id);
  try {
    await run(one);
    const input = { runId: "run", origin: "planner" as const, kind: "confirmation" as const,
      title: "Continue", prompt: "Continue?", rationale: "decision", evidenceRefs: [],
      responseSchema: { type: "confirm" as const, acceptLabel: "Yes", rejectLabel: "No" }, resume: { mode: "run_input" as const } };
    const results = await Promise.allSettled([new HumanLoopRepository(one).create(input), new HumanLoopRepository(two).create(input)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await new HumanLoopRepository(one).list("run")).length, 1);
    assert.equal((await new RunRepository(two).eventsByRun("run")).length, 1);
  } finally { await one.close(); await two.close(); }
});

test("Redis: another Node process reads and writes the same native record partition", async () => {
  const id = randomUUID(), db = await open("redis", id);
  try {
    await run(db);
    const source = `import {openRuntimeRecordBackend} from ${JSON.stringify(new URL("../src/storage/runtime-record-backend.ts", import.meta.url).href)};
      const db=await openRuntimeRecordBackend(${JSON.stringify({ backend: "redis", url, namespace: `contract:{${id}}` })});
      const run=(await db.records.find('runs',{id:'run'}))[0]; if(run.owner_user_id!=='owner') throw new Error('owner lost');
      await db.records.update('runs',{id:'run'},()=>({output:'another-process'})); await db.close();`;
    const child = spawn(globalThis.process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr!.on("data", data => { stderr += data; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0, stderr);
    assert.equal((await db.records.find("runs", { id: "run" }))[0].output, "another-process");
  } finally { await db.close(); }
});

test("Redis: AOF process restart restores current state without replaying changesets", async () => {
  const id = randomUUID(); let db = await open("redis", id);
  await run(db); await new RunRepository(db).appendEvent("run", { type: "before-restart", data: {}, createdAt: 1 }); await db.close();
  process.kill("SIGTERM"); await new Promise(resolve => process.once("exit", resolve));
  process = spawn("redis-server", ["--bind", "127.0.0.1", "--port", new URL(url).port, "--dir", directory,
    "--appendonly", "yes", "--appendfsync", "always", "--maxmemory-policy", "noeviction", "--save", ""], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Temporary Redis restart timeout")), 10000);
    process.once("error", error => { clearTimeout(timer); reject(error); });
    process.once("exit", code => { clearTimeout(timer); reject(new Error(`Temporary Redis restart exited ${code}`)); });
    process.stdout!.on("data", data => { if (String(data).includes("Ready to accept connections")) { clearTimeout(timer); resolve(); } });
  });
  const client = new RuntimeRedisClient(url), commands: string[] = [];
  db = await RedisRuntimeRecords.open({ sendCommand: async args => { commands.push(args[0]); return await client.sendCommand(args); }, close: () => client.close() }, { prefix: `contract:{${id}}` });
  try {
    assert.deepEqual(commands, ["INFO", "CONFIG", "GET", "GET", "GET", "SET"]);
    assert.equal((await db.records.find("runs", { id: "run" }))[0].status, "running");
    assert.equal(await new RunRepository(db).appendEvent("run", { type: "after-restart", data: {}, createdAt: 2 }), 2);
    assert.deepEqual((await new RunRepository(db).eventsByRunAfter("run", 1)).map(event => event.type), ["after-restart"]);
  } finally { await db.close(); }
});


test("Redis: malformed index version fails before any write, including sequence allocation", async () => {
  const id = randomUUID(), prefix = `contract:{${id}}`, client = new RuntimeRedisClient(url);
  const state = await RedisRuntimeRecords.open(new RuntimeRedisClient(url), { prefix });
  try {
    await run(state);
    await client.sendCommand(["HSET", `${prefix}:native-v2:i:run_events:all:dHJ1ZQ`, "v", "invalid"]);
    await assert.rejects(new RunRepository(state).appendEvent("run", { type: "never", data: {}, createdAt: 1 }), /INVALID_VERSION/);
    assert.deepEqual(await state.records.find("run_event_sequences", { run_id: "run" }), []);
    assert.deepEqual(await state.eventPage("run", 0, 10), []);
  } finally { await state.close(); await client.close(); }
});

test("Redis: offline import blocks startup until verification and preserves legacy namespace", async () => {
  const id = randomUUID(), prefix = `contract:{${id}}`, client = new RuntimeRedisClient(url);
  const source = await open("sqlite"); let target: RedisRuntimeRecords | undefined;
  try {
    await run(source); const manifest = await exportRuntimeRecords(source, "legacy");
    await client.sendCommand(["SET", `${prefix}:version`, "7"]);
    await assert.rejects(RedisRuntimeRecords.open(new RuntimeRedisClient(url), { prefix }), /offline migration/);
    target = await RedisRuntimeRecords.open(new RuntimeRedisClient(url), { prefix, offlineImport: { checksum: manifest.sha256, legacyVersion: 7 } });
    await assert.rejects(RedisRuntimeRecords.open(new RuntimeRedisClient(url), { prefix }), /incomplete/);
    await importRuntimeRecords(target, manifest); await target.completeOfflineImport(manifest.sha256, 7); await target.close();
    target = await RedisRuntimeRecords.open(new RuntimeRedisClient(url), { prefix });
    assert.equal((await target.records.find("runs", { id: "run" }))[0].input, "test");
    assert.equal(await client.sendCommand(["GET", `${prefix}:version`]), "7");
    await client.sendCommand(["SET", `${prefix}:version`, "8"]);
    await assert.rejects(RedisRuntimeRecords.open(new RuntimeRedisClient(url), { prefix }), /offline migration/);
  } finally { await target?.close(); await source.close(); await client.close(); }
});


test("Redis: HTTP reconnect on another service instance fills Last-Event-ID without duplicate or regressing terminal state", async () => {
  const id = randomUUID(), writer = await open("redis", id), reader = await open("redis", id);
  const catalogue = new AppDatabase(join(directory, `${id}-catalogue.sqlite`));
  const services = [writer, reader].map(database => new RunService({ database, skills: new SkillService(catalogue), workspaceRoot: directory, modelFactory: () => { throw new Error("read only"); } }));
  const servers = services.map(service => createHttpServer((request, response) => {
    void streamRuntimeRun({ runs: service, actorUserId: "owner", runId: "run", after: Number(request.headers["last-event-id"] ?? 0), request, response, project: event => event })
      .catch(() => { response.destroy(); });
  }));
  try {
    await run(writer); const repository = new RunRepository(writer);
    for (let index = 1; index <= 3; index++) await repository.appendEvent("run", { type: `event-${index}`, data: {}, createdAt: index });
    await writer.transaction(async () => {
      await writer.records.update("runs", { id: "run" }, () => ({ status: "completed" as const, output: "committed", finished_at: 4 }));
      await repository.appendEvent("run", { type: "run.completed", data: {}, createdAt: 4 });
    });
    for (const server of servers) {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}`, { headers: { "Last-Event-ID": "2" }, signal: AbortSignal.timeout(3000) });
      const body = await response.text();
      const snapshots = body.split("\n\n").filter(frame => frame.includes("event: snapshot")).map(frame => JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6)));
      assert.equal(snapshots[0].run.status, "completed"); assert.equal(snapshots[0].run.output, "committed");
      assert.deepEqual(snapshots[0].events.map((event: { seq: number }) => event.seq), [3, 4]); assert.match(body, /event: end/);
    }
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    for (const service of services) await service.closeRunEvents(); await writer.close(); await reader.close(); await catalogue.close();
  }
});


test("Redis: offline CLI exports legacy changesets read-only, maps host receipts and verifies native import", async () => {
  const prefix = `contract:{${randomUUID()}}`, client = new RuntimeRedisClient(url);
  const legacy = await RuntimeStateConnection.open(new RedisRuntimeStateStore(new RuntimeRedisClient(url), { prefix }));
  try {
    await legacy.exec("CREATE TABLE runs(id TEXT PRIMARY KEY,owner_user_id TEXT,depth INTEGER,allow_dangerous_tools INTEGER,status TEXT,input TEXT,created_at INTEGER); CREATE TABLE data_agent_requests(request_id TEXT PRIMARY KEY,fingerprint TEXT,run_id TEXT UNIQUE)");
    await legacy.prepare("INSERT INTO runs VALUES ('legacy-run','owner',0,0,'running','legacy',1)").run();
    await legacy.prepare("INSERT INTO data_agent_requests VALUES ('legacy-request','hash','legacy-run')").run();
  } finally { await legacy.close(); }
  const version = Number(await client.sendCommand(["GET", `${prefix}:version`]));
  const config = join(directory, `${randomUUID()}.json`), backup = join(directory, `${randomUUID()}-backup.json`);
  const cli = new URL("../scripts/transfer-runtime-state.mjs", import.meta.url).pathname;
  const execute = promisify(execFile);
  try {
    await writeFile(config, JSON.stringify({ backend: "legacy-redis", url, namespace: prefix, legacyEventOutbox: null }), { mode: 0o600 });
    const outboxPrefix = `${prefix}:outbox`;
    await client.sendCommand(["XADD", `${outboxPrefix}:pending`, "*", "event", "pending"]);
    await writeFile(config, JSON.stringify({ backend: "legacy-redis", url, namespace: prefix, legacyEventOutbox: { url, prefix: outboxPrefix } }), { mode: 0o600 });
    await assert.rejects(execute(globalThis.process.execPath, [cli, "export", config, backup, "--writers-stopped"]), /outbox is not drained/);
    await writeFile(config, JSON.stringify({ backend: "legacy-redis", url, namespace: prefix, legacyEventOutbox: null }), { mode: 0o600 });
    const exported = await execute(globalThis.process.execPath, [cli, "export", config, backup, "--writers-stopped"]);
    const manifest = JSON.parse(await readFile(backup, "utf8")); assert.equal(manifest.counts.runs, 1); assert.equal(manifest.counts.runtime_requests, 1);
    assert.match(exported.stdout, /sha256/); assert.equal(Number(await client.sendCommand(["GET", `${prefix}:version`])), version);
    await writeFile(config, JSON.stringify({ backend: "redis", url, namespace: prefix, legacyVersion: version }), { mode: 0o600 });
    const imported = await execute(globalThis.process.execPath, [cli, "import", config, backup, "--writers-stopped"]); assert.match(imported.stdout, /sha256/);
    const native = await RedisRuntimeRecords.open(new RuntimeRedisClient(url), { prefix });
    try { assert.equal((await native.records.find("runtime_requests", { scope: "data-agent", request_id: "legacy-request" }))[0].run_id, "legacy-run"); }
    finally { await native.close(); }
    assert.equal(Number(await client.sendCommand(["GET", `${prefix}:version`])), version);
  } finally { await client.close(); }
});

test("Redis: explicit empty initialization starts without legacy history and preserves source commits", async () => {
  const prefix = `contract:{${randomUUID()}}`, client = new RuntimeRedisClient(url);
  const legacy = await RuntimeStateConnection.open(new RedisRuntimeStateStore(new RuntimeRedisClient(url), { prefix }));
  await legacy.exec("CREATE TABLE runs(id TEXT PRIMARY KEY); INSERT INTO runs VALUES ('old-run')");
  await legacy.close();
  const version = Number(await client.sendCommand(["GET", `${prefix}:version`]));
  const config = join(directory, `${randomUUID()}-empty-config.json`), audit = join(directory, `${randomUUID()}-empty-audit.json`);
  await writeFile(config, JSON.stringify({ backend: "redis", url, namespace: prefix, legacyVersion: version }), { mode: 0o600 });
  const execute = promisify(execFile), cli = new URL("../scripts/transfer-runtime-state.mjs", import.meta.url).pathname;
  try {
    await execute(globalThis.process.execPath, [cli, "initialize-empty", config, audit, "--writers-stopped"]);
    const manifest = JSON.parse(await readFile(audit, "utf8"));
    assert.equal(manifest.source, "explicit-empty-start/legacy-history-discarded");
    assert.ok(Object.values(manifest.counts).every(count => count === 0));
    const native = await RedisRuntimeRecords.open(new RuntimeRedisClient(url), { prefix });
    try { assert.equal((await native.records.find("runs")).length, 0); }
    finally { await native.close(); }
    assert.equal(Number(await client.sendCommand(["GET", `${prefix}:version`])), version);
    assert.equal(Number(await client.sendCommand(["XLEN", `${prefix}:commits`])), version);
    await assert.rejects(execute(globalThis.process.execPath, [cli, "initialize-empty", config, audit, "--writers-stopped"]), /EEXIST/);
  } finally { await client.close(); }
});
