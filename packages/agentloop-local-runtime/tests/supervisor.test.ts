import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import {
  EncryptedLocalRuntimeSecretStore, LocalDirectoryScopeStore,
  LocalModelConfigurationStore, LocalRuntimeConfigurationStore,
  LocalRuntimeSupervisor, LocalRuntimeSupervisorError,
  type LocalRuntimeControl, type LocalRuntimeDefinition,
  type ResolvedLocalRuntimeConfiguration,
} from "@zhujun/agentloop-local-runtime/host";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

// Isolates Supervisor lifecycle tests from model execution. SQLite is real;
// these tests never invoke the stub RunService or claim provider acceptance.
function control(definition: LocalRuntimeDefinition): LocalRuntimeControl {
  const database = new AppDatabase(":memory:");
  return { ...definition, database, scopes: new LocalDirectoryScopeStore(database),
    runs: {} as LocalRuntimeControl["runs"], modelKeys: [],
    connectorConnectionIds: [], activeRunIds: new Set() };
}

async function fixture(t: test.TestContext, options: {
  factory?: (definition: LocalRuntimeDefinition, configuration: ResolvedLocalRuntimeConfiguration) => Promise<LocalRuntimeControl>;
  capacity?: number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "shared-supervisor-"));
  const path = join(root, "supervisor.db");
  const starts: ResolvedLocalRuntimeConfiguration[] = [];
  const open = async () => {
    const database = new AppDatabase(path);
    const secrets = new EncryptedLocalRuntimeSecretStore(join(root, "secrets"));
    // Match the existing host's separate vaults. MCP orphan cleanup must not
    // own model credentials; shared vaults need explicit reference enumeration.
    const modelSecrets = new EncryptedLocalRuntimeSecretStore(join(root, "model-secrets"));
    const models = new LocalModelConfigurationStore(database, modelSecrets);
    await models.ready();
    const configurations = new LocalRuntimeConfigurationStore(database, secrets, [], undefined, models);
    const supervisor = new LocalRuntimeSupervisor(database, async (definition, configuration) => {
      starts.push(configuration);
      return options.factory ? options.factory(definition, configuration) : control(definition);
    }, undefined, options.capacity, configurations);
    await supervisor.ready("stable-default");
    return { database, secrets, modelSecrets, models, configurations, supervisor };
  };
  let current = await open();
  t.after(async () => {
    await current.supervisor.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, path, starts, ...current, reopen: async () => {
    await current.supervisor.close();
    current = await open();
    return current;
  } };
}

test("shared Supervisor rejects new work synchronously when lifecycle mutations own a Runtime", async (t) => {
  const { supervisor } = await fixture(t);
  for (const action of ["drain", "restart", "stop", "remove"] as const) {
    const runtime = await supervisor.create(action);
    const mutation = supervisor[action](runtime.id);
    let invoked = false;
    await assert.rejects(supervisor.admitRun(runtime.id, async () => {
      invoked = true;
      return { runId: "must-not-start", value: undefined };
    }), error => error instanceof LocalRuntimeSupervisorError && error.status === 409 && error.message === "runtime_operation_in_progress");
    assert.equal(invoked, false, `${action} must fence admission before its first database await`);
    await mutation;
  }
});

test("stop waits for an asynchronous business lease without counting reads as active Runs", async (t) => {
  let closed = false;
  const { supervisor } = await fixture(t, { factory: async definition => ({ ...control(definition), close: async () => { closed = true; } }) });
  const entered = deferred<void>(); const release = deferred<void>();
  const reading = supervisor.withRuntimeUse("stable-default", async runtime => {
    entered.resolve(); await release.promise;
    assert.equal(closed, false);
    await runtime.database.prepare("SELECT 1 AS value").get();
  });
  await entered.promise;
  assert.equal((await supervisor.list())[0]?.activeRunCount, 0);
  assert.equal((await supervisor.stop("stable-default")).status, "draining");
  assert.equal(closed, false, "the pending stop must not close the leased database");
  release.resolve(); await reading;
  assert.equal(closed, true);
  assert.equal((await supervisor.list())[0]?.status, "stopped");
});

test("device reload owns admission, create, rename and external reload until all instances are replaced", async (t) => {
  const entered = deferred<void>(); const release = deferred<void>();
  let first = true;
  const { supervisor } = await fixture(t, { factory: async definition => {
    const result = control(definition);
    if (first) {
      first = false;
      return { ...result, close: async () => { entered.resolve(); await release.promise; } };
    }
    return result;
  } });
  const previous = supervisor.runtime("stable-default");
  const reloading = supervisor.reloadRunningInstances();
  await entered.promise;
  try {
    await assert.rejects(supervisor.admitRun("stable-default", async () => ({ runId: "forbidden", value: undefined })), /runtime_reconfiguration_in_progress/);
    await assert.rejects(supervisor.create("must not persist"), /runtime_reconfiguration_in_progress/);
    await assert.rejects(supervisor.rename("stable-default", "must not rename"), /runtime_reconfiguration_in_progress/);
    await assert.rejects(supervisor.reloadRunningInstances(), /runtime_operation_in_progress/);
  } finally { release.resolve(); await reloading; }
  assert.notEqual(supervisor.runtime("stable-default"), previous);
  assert.equal((await supervisor.list()).length, 1);
  assert.equal((await supervisor.list())[0]?.displayName, "本机 Runtime");
});

test("creation participates in device lifecycle exclusion before the factory finishes", async (t) => {
  const entered = deferred<void>(); const release = deferred<void>();
  const { supervisor } = await fixture(t, { factory: async definition => {
    if (!definition.isDefault) { entered.resolve(); await release.promise; }
    return control(definition);
  } });
  const creating = supervisor.create("new runtime");
  await entered.promise;
  try {
    await assert.rejects(supervisor.reloadRunningInstances(), /runtime_operation_in_progress/);
    await assert.rejects(supervisor.withDeviceReconfiguration(async () => undefined), /runtime_operation_in_progress/);
  } finally { release.resolve(); await creating; }
  assert.equal((await supervisor.list()).length, 2);
});

test("the owning configuration transaction may reload and roll back without releasing its admission gate", async (t) => {
  let failNext = false;
  const { supervisor, configurations } = await fixture(t, { factory: async definition => {
    if (failNext) { failNext = false; throw new Error("configuration_boot_failed"); }
    return control(definition);
  } });
  const entered = deferred<void>(); const release = deferred<void>();
  const reconfiguring = supervisor.withDeviceReconfiguration(async () => {
    const previous = await configurations.deviceMemoryConfiguration();
    failNext = true;
    await assert.rejects(supervisor.reloadRunningInstances(), /configuration_boot_failed/);
    assert.equal((await supervisor.list())[0]?.status, "failed");
    assert.deepEqual(supervisor.advertisements(), []);
    await configurations.restoreDeviceMemory(previous);
    await supervisor.reloadRunningInstances();
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    // This call originates outside the transaction's async context.
    await assert.rejects(supervisor.reloadRunningInstances(), /runtime_operation_in_progress/);
    await assert.rejects(supervisor.admitRun("stable-default", async () => ({ runId: "forbidden", value: undefined })), /runtime_reconfiguration_in_progress/);
  } finally { release.resolve(); await reconfiguring; }
  assert.equal(supervisor.advertisements()[0]?.status, "ready");
  assert.equal((await supervisor.list())[0]?.status, "ready", "successful rollback must repair the persisted failed state as well as the cache");
  assert.equal(await supervisor.admitRun("stable-default", async () => ({ runId: "after-rollback", value: "accepted" })), "accepted");
  await supervisor.runSettled("stable-default", "after-rollback");
});

test("pending admissions consume capacity and a failed admission releases its slot", async (t) => {
  const { supervisor } = await fixture(t, { capacity: 1 });
  const release = deferred<void>();
  const pending = supervisor.admitRun("stable-default", async () => {
    await release.promise;
    throw new Error("admission_failed");
  });
  const failed = assert.rejects(pending, /admission_failed/);
  try {
    assert.equal((await supervisor.list())[0]?.activeRunCount, 1);
    await assert.rejects(supervisor.admitRun("stable-default", async () => ({ runId: "over-capacity", value: undefined })),
      error => error instanceof LocalRuntimeSupervisorError && error.status === 429);
    await assert.rejects(supervisor.reloadRunningInstances(), /runtime_active_runs_prevent_reconfiguration/);
  } finally { release.resolve(); await failed; }
  assert.equal((await supervisor.list())[0]?.activeRunCount, 0);
  await supervisor.admitRun("stable-default", async () => ({ runId: "accepted", value: undefined }));
  assert.equal((await supervisor.list())[0]?.activeRunCount, 1);
  await supervisor.runSettled("stable-default", "accepted");
  await supervisor.reloadRunningInstances();
});

test("shared configurations retain runtime identity, stopped state and encrypted credentials across reopen", async (t) => {
  const { root, path, supervisor, models, configurations, secrets, modelSecrets, reopen } = await fixture(t);
  const credential = "test-only-local-credential";
  const snapshot = await models.snapshot();
  await models.write({ reuseCloudModels: false, providers: [{
    key: "local-provider", displayName: "Local provider", baseUrl: "https://models.example.test/v1", apiKey: credential,
    models: [{ key: "reasoner", displayName: "Reasoner", providerModel: "reasoner", protocol: "chat-completions" }],
  }] });
  await models.commit(snapshot);
  const child = await supervisor.create("Research", { mcpServers: [{ key: "files", displayName: "Files",
    transport: "http", url: "https://mcp.example.test/tools", auth: { kind: "bearer", token: credential } }] });
  await supervisor.stop(child.id);
  await configurations.applyDeviceMemory({ enabled: true, settlementModelKey: "local:reasoner" });
  assert.equal(JSON.stringify(await models.read()).includes(credential), false);
  assert.equal(JSON.stringify(await supervisor.configuration(child.id)).includes(credential), false);
  await assert.rejects(models.write({ reuseCloudModels: false, providers: [{
    key: "local-provider", displayName: "Changed endpoint", baseUrl: "https://other.example.test/v1",
    models: [],
  }] }), /local_model_api_key_required/);
  assert.equal((await readFile(path)).includes(Buffer.from(credential)), false);
  for (const [vault, directory] of [[secrets, "secrets"], [modelSecrets, "model-secrets"]] as const) {
    for (const key of await vault.listKeys()) {
      assert.equal((await readFile(join(root, directory, `${key}.json`), "utf8")).includes(credential), false);
    }
  }
  const restored = await reopen();
  assert.deepEqual((await restored.supervisor.list()).map(runtime => runtime.id), ["stable-default", child.id]);
  assert.equal((await restored.supervisor.list())[1]?.status, "stopped");
  assert.deepEqual(await restored.models.orderedModelKeys(), ["local:reasoner"]);
  const resolved = await restored.configurations.resolve(child.id);
  assert.equal(resolved.mcpServers[0]?.displayName, "Files", "safe service labels survive shared configuration and reopen");
  assert.equal(Object.values(resolved.integrationEnvironment).includes(credential), true);
  assert.equal(Object.values(resolved.modelConfiguration!.environment).includes(credential), true);
  assert.deepEqual(resolved.memory, { enabled: true, settlementModelKey: "local:reasoner" });
  await restored.configurations.applyDeviceMemory({ enabled: false });
  await restored.supervisor.start(child.id);
  assert.equal((await restored.supervisor.list())[1]?.status, "ready");
});

test("device MCP catalog binds independently per Runtime and refuses deletion while referenced", async (t) => {
  const { supervisor, configurations, secrets } = await fixture(t);
  const first = await supervisor.create("First", { skillPackageIds: [], mcpServers: [{
    key: "shared-files", displayName: "Shared files", transport: "http", url: "https://mcp.example.test/files",
    auth: { kind: "bearer", token: "test-only-catalog-credential" },
  }] });
  const second = await supervisor.create("Second");
  const catalog = await configurations.deviceMcpServers();
  assert.equal(catalog.length, 1);
  const id = catalog[0]!.id;
  assert.deepEqual((await configurations.configuration(first.id)).mcpServerIds, [id]);
  assert.deepEqual((await configurations.configuration(second.id)).mcpServerIds, [], "selection must not leak to another Runtime");
  await configurations.apply(second.id, { skillPackageIds: [], mcpServerIds: [id] });
  assert.deepEqual((await configurations.configuration(second.id)).mcpServerIds, [id]);
  assert.equal((await configurations.resolve(second.id)).mcpServers[0]?.key, "shared-files", "Runtime resolves the selected device item");
  await assert.rejects(configurations.removeDeviceMcpServer(id), /mcp_server_referenced_by_runtime/);
  await configurations.apply(first.id, { skillPackageIds: [], mcpServerIds: [] });
  await configurations.apply(second.id, { skillPackageIds: [], mcpServerIds: [] });
  await configurations.removeDeviceMcpServer(id);
  assert.deepEqual(await configurations.deviceMcpServers(), []);
  assert.deepEqual(await secrets.listKeys(), [], "unreferenced catalog credential is reclaimed only after deletion");
});

test("legacy Runtime MCP rows migrate to device catalog items without losing their binding", async (t) => {
  const { database, root, supervisor } = await fixture(t);
  const runtime = await supervisor.create("Migrated Runtime");
  await supervisor.stop(runtime.id);
  await database.exec(`CREATE TABLE local_runtime_mcp_servers (
    mcp_server_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, display_name TEXT NOT NULL, source_key TEXT NOT NULL,
    transport TEXT NOT NULL, url TEXT NOT NULL, protocol_version TEXT, timeout_ms INTEGER, auth_kind TEXT NOT NULL,
    auth_config_json TEXT NOT NULL, secret_storage_key TEXT, tool_policy_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, UNIQUE(runtime_id, source_key)
  )`);
  await database.prepare(`INSERT INTO local_runtime_mcp_servers VALUES (?, ?, ?, ?, 'http', ?, NULL, NULL, 'none', '{}', NULL, '{}', ?, ?)`)
    .run("legacy-device-mcp", runtime.id, "Legacy MCP", "legacy", "https://mcp.example.test/legacy", Date.now(), Date.now());
  const restored = new LocalRuntimeConfigurationStore(database, new EncryptedLocalRuntimeSecretStore(join(root, "secrets")));
  await restored.ready();
  assert.deepEqual((await restored.deviceMcpServers()).map(server => server.id), ["legacy-device-mcp"]);
  assert.deepEqual((await restored.configuration(runtime.id)).mcpServerIds, ["legacy-device-mcp"]);
  assert.equal(await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_runtime_mcp_servers'").get(), undefined);
});

test("persisted draining state waits for restored work before completing a stop", async (t) => {
  let restoreActive = false;
  const { database, supervisor, reopen } = await fixture(t, { factory: async definition => ({
    ...control(definition), activeRunIds: new Set(restoreActive ? ["restored-run"] : []),
  }) });
  // Persist the state that would survive a process interruption; no Run result
  // is fabricated, and recovery does not replay an external action.
  await database.prepare("UPDATE local_runtime_instances SET status = 'draining', pending_action = 'stop' WHERE runtime_id = ?").run("stable-default");
  restoreActive = true;
  const restored = await reopen();
  assert.equal((await restored.supervisor.list())[0]?.pendingAction, "stop");
  assert.equal((await restored.supervisor.list())[0]?.activeRunCount, 1);
  await assert.rejects(restored.supervisor.admitRun("stable-default", async () => ({ runId: "forbidden", value: undefined })), /runtime_draining/);
  await restored.supervisor.runSettled("stable-default", "restored-run");
  assert.equal((await restored.supervisor.list())[0]?.status, "stopped");
  assert.equal((await restored.supervisor.list())[0]?.pendingAction, undefined);
  assert.deepEqual(restored.supervisor.advertisements(), []);
  assert.equal(supervisor.controls().length, 0);
});

test("shared package implementation imports no application internals", async () => {
  const sourceRoot = new URL("../src/", import.meta.url);
  const files = await readdir(sourceRoot, { recursive: true });
  for (const file of files.filter(file => file.endsWith(".ts"))) {
    const source = await readFile(new URL(file, sourceRoot), "utf8");
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()\s*["'][^"']*\bapps\//, file);
    assert.doesNotMatch(source, /["']agentloop-multi-runtime(?:\/|["'])/, file);
  }
});
