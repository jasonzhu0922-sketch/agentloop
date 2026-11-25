import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStateConnection } from "../src/storage/runtime-state-connection.ts";
import type { RuntimeStateCommit, RuntimeStateStore } from "../src/storage/runtime-state-store.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

class MemoryStore implements RuntimeStateStore {
  records: RuntimeStateCommit[] = [];
  failure?: "before" | "after";
  gate?: Promise<void>;
  async open() {}
  async read(after: number, limit: number) { return structuredClone(this.records.filter(record => record.version > after).slice(0, limit)); }
  async append(commit: RuntimeStateCommit) {
    await this.gate;
    if (this.failure === "before") throw new Error("unavailable");
    if (this.records.at(-1)?.version !== undefined && commit.version !== this.records.at(-1)!.version + 1) throw new Error("conflict");
    this.records.push(structuredClone(commit));
    if (this.failure === "after") throw new Error("response lost");
  }
  async receipt(id: string) { return this.records.find(record => record.id === id)?.version; }
  async close() {}
}
async function fixture(t: any) {
  const store = new MemoryStore(), connection = await RuntimeStateConnection.open(store);
  const database = await AppDatabase.open({ connection });
  t.after(() => database.close());
  return { store, connection, database };
}

test("offline replay consumes short pages until the journal is exhausted", async () => {
  const store = new MemoryStore();
  const source = await RuntimeStateConnection.open(store);
  await source.exec("CREATE TABLE bounded_history(id TEXT PRIMARY KEY)");
  for (let i = 0; i < 3; i++) await source.prepare("INSERT INTO bounded_history VALUES (?)").run(String(i));
  await source.close();
  const replay = await RuntimeStateConnection.open({ ...store,
    open: () => store.open(), read: after => store.read(after, 1),
    append: commit => store.append(commit), receipt: id => store.receipt(id), close: () => store.close(),
  });
  try { assert.equal((await replay.prepare("SELECT * FROM bounded_history").all()).length, 3); }
  finally { await replay.close(); }
});

test("entire domain transaction survives replay; rollback does not consume budget or publish rows", async t => {
  const { store, database } = await fixture(t);
  await database.exec("CREATE TABLE budget(id TEXT PRIMARY KEY, used INTEGER NOT NULL CHECK(used>=0)); INSERT INTO budget VALUES ('run',0)");
  const prior = store.records.length;
  await assert.rejects(database.transaction(async () => {
    await database.prepare("UPDATE budget SET used=used+1 WHERE id='run'").run();
    throw new Error("cancel transaction");
  }), /cancel transaction/);
  assert.equal(store.records.length, prior);
  await database.transaction(async () => {
    await database.prepare("UPDATE budget SET used=used+1 WHERE id='run'").run();
    await database.prepare("UPDATE budget SET used=used+1 WHERE id='run'").run();
  });
  assert.equal(store.records.length, prior + 1);
  const replay = await RuntimeStateConnection.open(store);
  assert.deepEqual({ ...await replay.prepare("SELECT * FROM budget").get() as object }, { id: "run", used: 2 });
  await replay.close();
});

test("queries outside a transaction wait for Redis confirmation and cannot see provisional state", async t => {
  const { store, database } = await fixture(t);
  await database.exec("CREATE TABLE isolation(id TEXT PRIMARY KEY)");
  let release!: () => void;
  store.gate = new Promise<void>(resolve => { release = resolve; });
  const write = database.prepare("INSERT INTO isolation VALUES ('accepted')").run();
  let visible = false;
  const query = database.prepare("SELECT * FROM isolation").all().then(rows => { visible = true; return rows; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(visible, false);
  release(); await write;
  assert.equal((await query).length, 1);
});

test("lost commit response is resolved by receipt without executing the callback twice", async t => {
  const { store, database } = await fixture(t);
  await database.exec("CREATE TABLE receipts(id TEXT PRIMARY KEY, v INTEGER)");
  store.failure = "after";
  let callbacks = 0;
  await database.transaction(async () => { callbacks++; await database.prepare("INSERT INTO receipts VALUES ('x',1)").run(); });
  assert.equal(callbacks, 1);
  assert.equal((await database.prepare("SELECT * FROM receipts").all()).length, 1);
  store.failure = undefined;
});

test("persistence failure rolls back and stops new execution until recovery", async t => {
  const { store, database } = await fixture(t);
  await database.exec("CREATE TABLE failure(id TEXT PRIMARY KEY)");
  const before = store.records.length;
  store.failure = "before";
  await assert.rejects(database.prepare("INSERT INTO failure VALUES ('x')").run(), /persistence failed/);
  await assert.rejects(database.prepare("SELECT * FROM failure").all(), /persistence failed/);
  assert.equal(store.records.length, before);
  // The failed connection intentionally rejects close through the normal lock.
  store.failure = undefined;
});

test("schema migration snapshots preserve rows and binary values on restart", async t => {
  const { store, database } = await fixture(t);
  await database.exec("CREATE TABLE migration(id TEXT PRIMARY KEY, bytes BLOB)");
  await database.prepare("INSERT INTO migration VALUES (?,?)").run("row", new Uint8Array([1,2,3]));
  await database.exec("ALTER TABLE migration ADD COLUMN revision INTEGER DEFAULT 1");
  const replay = await RuntimeStateConnection.open(store);
  const row = await replay.prepare("SELECT * FROM migration").get() as any;
  assert.equal(row.revision, 1); assert.deepEqual(Buffer.from(row.bytes), Buffer.from([1,2,3]));
  await replay.close();
});

test("journal corruption is rejected instead of falling back to stale SQL", async t => {
  const { store } = await fixture(t);
  store.records[0] = { ...store.records[0], changeset: "corrupt" };
  await assert.rejects(RuntimeStateConnection.open(store), /corrupt/);
});

test("complete Run, Action results, events, Plan and terminal answer restore without any remote SQL", async t => {
  const { store, database } = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "runtime-state-run-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let modelCalls = 0;
  const runs = new RunService({ database, skills: new SkillService(database), workspaceRoot: directory,
    plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
    modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async () => { modelCalls++; return { content: "Confirmed answer.", finishReason: "stop", toolCalls: [] }; } }),
  });
  const run = await runs.start("owner", "Answer the question");
  await runs.whenRunIdle(run.id);
  const result = await runs.get("owner", run.id);
  assert.equal(result.status, "completed"); assert.ok(modelCalls > 0);
  const events = await runs.eventsAfter("owner", run.id, 0);
  assert.ok(events.some(event => event.type === "run.completed"));
  const recoveredConnection = await RuntimeStateConnection.open(store);
  const recovered = await AppDatabase.open({ connection: recoveredConnection });
  const restored = new RunService({ database: recovered, skills: new SkillService(recovered), workspaceRoot: directory });
  assert.equal((await restored.get("owner", run.id)).status, "completed");
  assert.deepEqual(await restored.eventsAfter("owner", run.id, 0), events);
  assert.equal((await recovered.prepare("SELECT status FROM run_outcomes WHERE run_id=?").get(run.id) as any).status, "completed");
  assert.ok((await recovered.prepare("SELECT id FROM runtime_actions WHERE run_id=?").all(run.id)).length > 0);
  await recovered.close();
});

test("deferred constraint failure is rejected before the durable append", async t => {
  const { store, database } = await fixture(t);
  await database.exec("CREATE TABLE parent(id TEXT PRIMARY KEY); CREATE TABLE child(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES parent(id))");
  const count = store.records.length;
  await assert.rejects(database.transaction(async()=>{
    await database.exec("PRAGMA defer_foreign_keys=ON");
    await database.prepare("INSERT INTO child VALUES ('child','missing')").run();
  }), /invalid deferred references/);
  assert.equal(store.records.length,count);
  const recovered = await RuntimeStateConnection.open(store);
  assert.equal((await recovered.prepare("SELECT * FROM child").all()).length,0);
  await recovered.close();
});
