import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { LocalRuntimeConfigurationStore } from "../local-agent-runtime/src/persistence/local-runtime-configuration-store.ts";

async function fixture() {
  const database = new AppDatabase(":memory:");
  await database.exec(`CREATE TABLE local_runtime_instances (
    runtime_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, storage_key TEXT NOT NULL,
    is_default INTEGER NOT NULL, status TEXT NOT NULL, pending_action TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  await database.prepare(`INSERT INTO local_runtime_instances(runtime_id, display_name, storage_key, is_default, status, created_at, updated_at)
    VALUES ('runtime', 'Runtime', 'runtime', 1, 'stopped', 1, 1)`).run();
  const store = new LocalRuntimeConfigurationStore(database);
  await store.ready();
  await store.initialize("runtime");
  return { database, store };
}

test("Local Memory is disabled by default and does not expose a settlement model", async (t) => {
  const { database, store } = await fixture();
  t.after(() => database.close());
  assert.equal((await store.resolve("runtime")).memory?.enabled, false);
  assert.equal((await store.configuration("runtime")).memory, undefined);
});

test("Local Memory rejects cloud settlement models and accepts a local model key", async (t) => {
  const { database, store } = await fixture();
  t.after(() => database.close());
  await assert.rejects(
    store.applyDeviceMemory({ enabled: true, settlementModelKey: "cloud:shared" }),
    /memory_settlement_model_must_be_local/,
  );
  await store.applyDeviceMemory({ enabled: true, settlementModelKey: "local:compactor" });
  assert.deepEqual((await store.configuration("runtime")).memory, { enabled: true, settlementModelKey: "local:compactor" });
  assert.deepEqual((await store.resolve("runtime")).memory, { enabled: true, settlementModelKey: "local:compactor" });
});

test("Local Memory cannot be enabled without a dedicated settlement model", async (t) => {
  const { database, store } = await fixture();
  t.after(() => database.close());
  await assert.rejects(
    store.applyDeviceMemory({ enabled: true }),
    /memory_settlement_model_required/,
  );
  assert.equal((await store.resolve("runtime")).memory?.enabled, false);
});

test("Local Memory is device-scoped and resolves identically for every Runtime", async (t) => {
  const database = new AppDatabase(":memory:");
  await database.exec(`CREATE TABLE local_runtime_instances (
    runtime_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, storage_key TEXT NOT NULL,
    is_default INTEGER NOT NULL, status TEXT NOT NULL, pending_action TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  await database.prepare(`INSERT INTO local_runtime_instances(runtime_id, display_name, storage_key, is_default, status, created_at, updated_at)
    VALUES ('runtime-a', 'A', 'a', 1, 'stopped', 1, 1), ('runtime-b', 'B', 'b', 0, 'stopped', 1, 1)`).run();
  const store = new LocalRuntimeConfigurationStore(database);
  await store.ready();
  await store.initialize("runtime-a");
  await store.initialize("runtime-b");
  await store.applyDeviceMemory({ enabled: true, settlementModelKey: "local:compactor" });
  t.after(() => database.close());
  assert.deepEqual((await store.resolve("runtime-a")).memory, { enabled: true, settlementModelKey: "local:compactor" });
  assert.deepEqual((await store.resolve("runtime-b")).memory, { enabled: true, settlementModelKey: "local:compactor" });
  await database.prepare(`INSERT INTO local_runtime_instances(runtime_id, display_name, storage_key, is_default, status, created_at, updated_at)
    VALUES ('runtime-c', 'C', 'c', 0, 'stopped', 1, 1)`).run();
  await store.initialize("runtime-c");
  assert.deepEqual((await store.resolve("runtime-c")).memory, { enabled: true, settlementModelKey: "local:compactor" });
  await store.applyDeviceMemory({ enabled: false });
  assert.equal((await store.resolve("runtime-a")).memory?.enabled, false);
  assert.equal((await store.resolve("runtime-b")).memory?.enabled, false);
});

test("legacy Runtime Memory configuration migrates once to the device", async (t) => {
  const { database, store } = await fixture();
  t.after(() => database.close());
  await database.exec("DELETE FROM local_memory_configuration");
  await database.exec("UPDATE local_runtime_configurations SET memory_enabled = 1, settlement_model_key = 'local:compactor'");
  await store.ready();
  assert.deepEqual(await store.deviceMemoryConfiguration(), { enabled: true, settlementModelKey: "local:compactor" });
  await store.applyDeviceMemory({ enabled: false });
  await store.ready();
  assert.deepEqual(await store.deviceMemoryConfiguration(), { enabled: false });
});
