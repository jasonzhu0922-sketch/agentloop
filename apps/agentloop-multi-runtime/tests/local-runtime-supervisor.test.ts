import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase, parseMcpServersConfig } from "@zhujun/agentloop";
import { LocalDirectoryScopeStore } from "../local-agent-runtime/src/persistence/directory-scope-store.ts";
import { LocalRuntimeConfigurationStore, type ResolvedLocalRuntimeConfiguration } from "../local-agent-runtime/src/persistence/local-runtime-configuration-store.ts";
import { EncryptedLocalRuntimeSecretStore } from "../local-agent-runtime/src/persistence/encrypted-local-runtime-secret-store.ts";
import { RESTORED_RUN_ACTIVITY_WINDOW_MS, shouldRetainRestoredRunActivity } from "../local-agent-runtime/src/service/local-runtime-factory.ts";
import { DEFAULT_LOCAL_RUNTIME_MAX_CONCURRENT_RUNS, LocalRuntimeSupervisor, type LocalRuntimeControl, type LocalRuntimeDefinition } from "../local-agent-runtime/src/service/runtime-supervisor.ts";
import { persistSessions } from "../web/client/state/session-persistence.js";
import { loadLocalRuntimePreference, localRuntimePreferenceKey, saveLocalRuntimePreference } from "../web/client/local-runtime/local-runtime-preference.js";
import { submissionFailureMessage } from "../web/client/presentation/submission-failure-message.js";

test("local-execution preference is explicit, user-device scoped, and best-effort", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };
  const firstKey = localRuntimePreferenceKey("user/a", "device.a");
  const secondKey = localRuntimePreferenceKey("user/b", "device.a");
  const thirdKey = localRuntimePreferenceKey("user/a", "device.b");
  assert.ok(firstKey);
  assert.notEqual(firstKey, secondKey);
  assert.notEqual(firstKey, thirdKey);
  assert.equal(loadLocalRuntimePreference(storage, "user/a", "device.a"), undefined);

  assert.equal(saveLocalRuntimePreference(storage, "user/a", "device.a", true), true);
  assert.equal(loadLocalRuntimePreference(storage, "user/a", "device.a"), true);
  assert.equal(saveLocalRuntimePreference(storage, "user/a", "device.a", false), true);
  assert.equal(loadLocalRuntimePreference(storage, "user/a", "device.a"), false);
  assert.equal(loadLocalRuntimePreference(storage, "user/b", "device.a"), undefined);
  assert.equal(loadLocalRuntimePreference(storage, "user/a", "device.b"), undefined);

  values.set(firstKey, JSON.stringify({ enabled: true }));
  assert.equal(loadLocalRuntimePreference(storage, "user/a", "device.a"), undefined);
  assert.equal(localRuntimePreferenceKey("", "device.a"), undefined);
  assert.equal(saveLocalRuntimePreference({ setItem() { throw new Error("quota"); } }, "user/a", "device.a", true), false);
});

test("Supervisor persists multiple isolated Runtime definitions and removes stopped instances from advertisements", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-supervisor-"));
  const path = join(root, "supervisor.db");
  const created: LocalRuntimeDefinition[] = [];
  let supervisor = new LocalRuntimeSupervisor(new AppDatabase(path), fakeFactory(created));
  try {
    await supervisor.ready("local-default");
    const second = await supervisor.create("研究助理");
    assert.notEqual(second.id, "local-default");
    assert.deepEqual((await supervisor.list()).filter((runtime) => runtime.isDefault).map((runtime) => runtime.id), ["local-default"]);
    assert.deepEqual(created.map((runtime) => runtime.storageKey), ["default", second.id]);
    assert.equal(new Set(supervisor.advertisements().map((runtime) => runtime.runtimeId)).size, 2);
    assert.equal(supervisor.advertisements().find((runtime) => runtime.runtimeId === second.id)?.displayName, "研究助理");

    const stopping = supervisor.stop(second.id);
    await assert.rejects(supervisor.restart(second.id), /runtime_operation_in_progress/);
    await stopping;
    assert.equal((await supervisor.list()).find((runtime) => runtime.id === second.id)?.status, "stopped");
    assert.equal(supervisor.advertisements().some((runtime) => runtime.runtimeId === second.id), false);
    await supervisor.start(second.id);
    assert.equal((await supervisor.list()).find((runtime) => runtime.id === second.id)?.status, "ready");
    assert.equal(supervisor.advertisements().some((runtime) => runtime.runtimeId === second.id), true);

    await supervisor.close();
    const legacyDatabase = new AppDatabase(path);
    await legacyDatabase.exec("DROP INDEX local_runtime_instances_one_default_idx");
    await legacyDatabase.prepare("UPDATE local_runtime_instances SET is_default = 1").run();
    await legacyDatabase.close();
    const restoredDefinitions: LocalRuntimeDefinition[] = [];
    supervisor = new LocalRuntimeSupervisor(new AppDatabase(path), fakeFactory(restoredDefinitions));
    await supervisor.ready("ignored-new-default");
    assert.deepEqual((await supervisor.list()).map((runtime) => runtime.id), ["local-default", second.id]);
    assert.deepEqual((await supervisor.list()).filter((runtime) => runtime.isDefault).map((runtime) => runtime.id), ["local-default"]);
    assert.deepEqual(restoredDefinitions.map((runtime) => runtime.id), ["local-default", second.id]);
  } finally {
    await supervisor.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("drain closes admission before restart and restart waits for both in-flight admission and active Run", async () => {
  const definitions: LocalRuntimeDefinition[] = [];
  const supervisor = new LocalRuntimeSupervisor(new AppDatabase(":memory:"), fakeFactory(definitions));
  await supervisor.ready("local-default");
  let releaseStart!: (value: { readonly runId: string; readonly value: string }) => void;
  const starting = supervisor.admitRun<string>("local-default", async () => await new Promise<{ readonly runId: string; readonly value: string }>((resolve) => { releaseStart = resolve; }));
  try {
    assert.equal((await supervisor.list())[0]?.activeRunCount, 1, "an in-flight admission is lifecycle-active work");
    const draining = await supervisor.restart("local-default");
    assert.equal(draining.status, "draining");
    assert.equal(draining.pendingAction, "restart");
    assert.equal(definitions.length, 1, "restart must not close the instance while admission is in flight");
    await assert.rejects(supervisor.admitRun("local-default", async () => ({ runId: "forbidden", value: undefined })), /runtime_draining/);

    releaseStart({ runId: "run-1", value: "accepted" });
    assert.equal(await starting, "accepted");
    assert.equal((await supervisor.list())[0]?.activeRunCount, 1);
    assert.equal(definitions.length, 1, "accepted Run keeps restart waiting after admission completes");

    await supervisor.runSettled("local-default", "run-1");
    assert.equal((await supervisor.list())[0]?.status, "ready");
    assert.equal((await supervisor.list())[0]?.activeRunCount, 0);
    assert.equal(definitions.length, 2, "the Runtime is recreated exactly after the active Run settles");
  } finally {
    await supervisor.close();
  }
});

test("restored Run activity expires after ten minutes without changing persisted Run status", () => {
  const now = 1_800_000;
  assert.equal(shouldRetainRestoredRunActivity({ status: "running", createdAt: now - RESTORED_RUN_ACTIVITY_WINDOW_MS }, now), true);
  assert.equal(shouldRetainRestoredRunActivity({ status: "running", createdAt: now - RESTORED_RUN_ACTIVITY_WINDOW_MS - 1 }, now), false);
  assert.equal(shouldRetainRestoredRunActivity({ status: "completed", createdAt: now - 1 }, now), false);
});

test("Supervisor completes a persisted stop after restart when no recent Run still occupies it", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-pending-stop-"));
  const path = join(root, "supervisor.db");
  let supervisor = new LocalRuntimeSupervisor(new AppDatabase(path), fakeFactory([]));
  try {
    await supervisor.ready("local-default");
    await supervisor.admitRun("local-default", async () => ({ runId: "old-run", value: undefined }));
    const draining = await supervisor.stop("local-default");
    assert.equal(draining.pendingAction, "stop");
    await supervisor.close();

    supervisor = new LocalRuntimeSupervisor(new AppDatabase(path), fakeFactory([]));
    await supervisor.ready("unused-default");
    const stopped = (await supervisor.list())[0]!;
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.pendingAction, undefined);
    assert.equal(supervisor.advertisements().length, 0);
  } finally {
    await supervisor.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Supervisor preserves a persisted stop while a recent restored Run is still active", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-recent-stop-"));
  const path = join(root, "supervisor.db");
  let supervisor = new LocalRuntimeSupervisor(new AppDatabase(path), fakeFactory([]));
  try {
    await supervisor.ready("local-default");
    await supervisor.admitRun("local-default", async () => ({ runId: "recent-run", value: undefined }));
    await supervisor.stop("local-default");
    await supervisor.close();

    supervisor = new LocalRuntimeSupervisor(new AppDatabase(path), async (definition) => ({
      ...fakeRuntime(definition),
      activeRunIds: new Set(["recent-run"]),
    }));
    await supervisor.ready("unused-default");
    const draining = (await supervisor.list())[0]!;
    assert.equal(draining.status, "draining");
    assert.equal(draining.pendingAction, "stop");
    assert.equal(draining.activeRunCount, 1);

    await supervisor.runSettled("local-default", "recent-run");
    assert.equal((await supervisor.list())[0]?.status, "stopped");
  } finally {
    await supervisor.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a Local Runtime accepts ten concurrent Runs and reports a stable capacity limit", async () => {
  const supervisor = new LocalRuntimeSupervisor(new AppDatabase(":memory:"), fakeFactory([]));
  await supervisor.ready("local-default");
  try {
    assert.equal(supervisor.advertisements()[0]?.maxConcurrentRuns, DEFAULT_LOCAL_RUNTIME_MAX_CONCURRENT_RUNS);
    await Promise.all([...Array(DEFAULT_LOCAL_RUNTIME_MAX_CONCURRENT_RUNS)].map((_, index) =>
      supervisor.admitRun("local-default", async () => ({ runId: `run-${index}`, value: undefined })),
    ));
    assert.equal((await supervisor.list())[0]?.activeRunCount, DEFAULT_LOCAL_RUNTIME_MAX_CONCURRENT_RUNS);
    await assert.rejects(
      supervisor.admitRun("local-default", async () => ({ runId: "run-over-capacity", value: undefined })),
      /runtime_capacity_exhausted/,
    );
  } finally {
    await supervisor.close();
  }
});

test("a failed Runtime can be stopped and returned to the configurable lifecycle", async () => {
  const supervisor = new LocalRuntimeSupervisor(new AppDatabase(":memory:"), async (definition) => {
    if (!definition.isDefault) throw new Error("startup failed");
    return fakeRuntime(definition);
  });
  try {
    await supervisor.ready("local-default");
    await assert.rejects(supervisor.create("Failed Runtime"), /startup failed/);
    const failed = (await supervisor.list()).find((runtime) => !runtime.isDefault)!;
    assert.equal(failed.status, "failed");
    assert.equal((await supervisor.stop(failed.id)).status, "stopped");
    await supervisor.updateConfiguration(failed.id, { skillPackageIds: [], mcpServers: [] }, "Recoverable Runtime");
    assert.equal((await supervisor.list()).find((runtime) => runtime.id === failed.id)?.displayName, "Recoverable Runtime");
  } finally {
    await supervisor.close();
  }
});

test("Runtime extensions are optional, isolated, and mutable only while stopped", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-runtime-configuration-"));
  const customRoot = join(root, "custom-skills");
  const packageRoot = join(customRoot, "contract-review");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "SKILL.md"), [
    "---",
    "name: contract-review",
    "description: Reviews contract clauses.",
    "---",
    "",
    "Review the supplied contract.",
  ].join("\n"));
  const database = new AppDatabase(join(root, "supervisor.db"));
  const configurations = new LocalRuntimeConfigurationStore(database, undefined, [customRoot]);
  const starts: Array<{ definition: LocalRuntimeDefinition; configuration: ResolvedLocalRuntimeConfiguration }> = [];
  const supervisor = new LocalRuntimeSupervisor(
    database,
    async (definition, configuration) => {
      starts.push({ definition, configuration });
      return fakeRuntime(definition);
    },
    undefined,
    DEFAULT_LOCAL_RUNTIME_MAX_CONCURRENT_RUNS,
    configurations,
  );
  try {
    await supervisor.ready("local-default");
    const packages = await configurations.listSkillPackages();
    assert.equal(packages.length, 1);

    const general = await supervisor.create("通用 Runtime");
    assert.deepEqual(await supervisor.configuration(general.id), {
      runtimeId: general.id,
      skills: [],
      mcpServers: [],
      updatedAt: (await supervisor.configuration(general.id)).updatedAt,
    });
    assert.deepEqual(starts.find((entry) => entry.definition.id === general.id)?.configuration.customSkillDirectories, []);

    await assert.rejects(
      supervisor.updateConfiguration(general.id, { skillPackageIds: [packages[0]!.packageId] }),
      /runtime_must_be_stopped_for_configuration/,
    );
    await supervisor.stop(general.id);
    const configured = await supervisor.updateConfiguration(general.id, {
      skillPackageIds: [packages[0]!.packageId],
      mcpServers: [{
        displayName: "Contract knowledge",
        key: "contract-knowledge",
        transport: "http",
        url: "http://127.0.0.1:9321/mcp",
        auth: { kind: "none" },
        toolAllowlist: [],
        toolBlocklist: [],
      }],
    });
    assert.deepEqual(configured.skills.map((skill) => skill.skillName), ["contract-review"]);
    assert.deepEqual(configured.mcpServers.map((server) => server.key), ["contract-knowledge"]);
    assert.equal("toolAllowlist" in configured.mcpServers[0]!, false, "a blank UI allowlist means no filtering");
    assert.equal("toolBlocklist" in configured.mcpServers[0]!, false, "a blank UI blocklist means no filtering");
    assert.deepEqual((await supervisor.configuration("local-default")).skills, []);

    await database.prepare(`
      UPDATE local_runtime_mcp_servers
      SET tool_policy_json = ?
      WHERE runtime_id = ?
    `).run(JSON.stringify({ toolAllowlist: [], toolBlocklist: [] }), general.id);
    const legacyBlankFilters = await supervisor.configuration(general.id);
    assert.equal("toolAllowlist" in legacyBlankFilters.mcpServers[0]!, false, "existing blank allowlists are normalized on read");

    await supervisor.start(general.id);
    const restarted = starts.filter((entry) => entry.definition.id === general.id).at(-1)!;
    assert.deepEqual(restarted.configuration.customSkillDirectories, [await realpath(packageRoot)]);
    assert.deepEqual(restarted.configuration.mcpServers.map((server) => server.key), ["contract-knowledge"]);
    assert.equal("toolAllowlist" in restarted.configuration.mcpServers[0]!, false, "blank persisted allowlists do not suppress all MCP tools");
    assert.deepEqual(starts.find((entry) => entry.definition.id === "local-default")?.configuration.customSkillDirectories, []);
  } finally {
    await supervisor.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime MCP credentials stay encrypted and are retained without being returned", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-runtime-secrets-"));
  const database = new AppDatabase(join(root, "supervisor.db"));
  const secretStore = new EncryptedLocalRuntimeSecretStore(join(root, "runtime-secrets"));
  const configurations = new LocalRuntimeConfigurationStore(database, secretStore);
  const starts: ResolvedLocalRuntimeConfiguration[] = [];
  const supervisor = new LocalRuntimeSupervisor(
    database,
    async (definition, configuration) => {
      starts.push(configuration);
      return fakeRuntime(definition);
    },
    undefined,
    DEFAULT_LOCAL_RUNTIME_MAX_CONCURRENT_RUNS,
    configurations,
  );
  const token = "runtime-only-token-value";
  try {
    const orphanedKey = await secretStore.write({ token: "uncommitted-secret" });
    await supervisor.ready("local-default");
    assert.equal(await secretStore.read(orphanedKey), undefined, "startup removes secrets left unreferenced by an interrupted transaction");
    const runtime = await supervisor.create("MCP Runtime", {
      mcpServers: [{
        displayName: "Private service",
        key: "private-service",
        transport: "http",
        url: "http://127.0.0.1:9322/mcp",
        auth: { kind: "bearer", token },
      }],
    });
    const publicConfiguration = await supervisor.configuration(runtime.id);
    assert.equal(JSON.stringify(publicConfiguration).includes(token), false);
    assert.deepEqual(publicConfiguration.mcpServers[0]?.auth, { kind: "bearer", credentialConfigured: true });
    const persisted = await database.prepare(`
      SELECT auth_config_json, secret_storage_key FROM local_runtime_mcp_servers WHERE runtime_id = ?
    `).get(runtime.id) as { auth_config_json: string; secret_storage_key: string };
    const encryptedSecretPath = join(root, "runtime-secrets", `${persisted.secret_storage_key}.json`);
    assert.equal(persisted.auth_config_json.includes(token), false);
    assert.equal((await readFile(encryptedSecretPath, "utf8")).includes(token), false);
    assert.ok(Object.values(starts.at(-1)!.integrationEnvironment).includes(token));

    await supervisor.stop(runtime.id);
    await supervisor.updateConfiguration(runtime.id, {
      mcpServers: [{
        id: publicConfiguration.mcpServers[0]!.id,
        displayName: "Private service renamed",
        key: "private-service",
        transport: "http",
        url: "http://127.0.0.1:9322/mcp",
        auth: { kind: "bearer" },
      }],
    });
    await supervisor.start(runtime.id);
    assert.ok(Object.values(starts.at(-1)!.integrationEnvironment).includes(token));
    await supervisor.stop(runtime.id);
    await supervisor.remove(runtime.id);
    await assert.rejects(readFile(encryptedSecretPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    await supervisor.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a Runtime stays stopped when its referenced MCP secret file disappears between restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-runtime-secret-recovery-"));
  const databasePath = join(root, "supervisor.db");
  const secretRoot = join(root, "runtime-secrets");
  const starts: ResolvedLocalRuntimeConfiguration[] = [];
  let supervisor = legacySupervisor(databasePath, secretRoot, starts);
  try {
    await supervisor.ready("local-default");
    const runtime = await supervisor.create("Recoverable MCP Runtime", {
      mcpServers: [{
        displayName: "Private service",
        key: "private-service",
        transport: "http",
        url: "https://mcp.example.test/mcp",
        auth: { kind: "bearer", token: "initial-token" },
      }],
    });
    const database = new AppDatabase(databasePath);
    const persisted = await database.prepare(`
      SELECT secret_storage_key FROM local_runtime_mcp_servers WHERE runtime_id = ?
    `).get(runtime.id) as { secret_storage_key: string };
    await database.close();
    await supervisor.close();
    await rm(join(secretRoot, `${persisted.secret_storage_key}.json`));

    const restarted: ResolvedLocalRuntimeConfiguration[] = [];
    supervisor = legacySupervisor(databasePath, secretRoot, restarted);
    await supervisor.ready("unused-default");
    assert.equal((await supervisor.list()).find((entry) => entry.id === runtime.id)?.status, "stopped");
    assert.equal(restarted.some((configuration) => configuration.mcpServers.some((server) => server.key === "private-service")), false);
    const configuration = await supervisor.configuration(runtime.id);
    assert.deepEqual(configuration.mcpServers[0]?.auth, { kind: "bearer", credentialConfigured: false });

    await supervisor.updateConfiguration(runtime.id, {
      mcpServers: [{
        id: configuration.mcpServers[0]!.id,
        displayName: "Private service",
        key: "private-service",
        transport: "http",
        url: "https://mcp.example.test/mcp",
        auth: { kind: "bearer", token: "replacement-token" },
      }],
    });
    await supervisor.start(runtime.id);
    assert.equal((await supervisor.list()).find((entry) => entry.id === runtime.id)?.status, "ready");
    assert.ok(Object.values(restarted.at(-1)!.integrationEnvironment).includes("replacement-token"));
  } finally {
    await supervisor.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy device MCP configuration is materialized once with query auth and ToolSource metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-runtime-legacy-mcp-"));
  const databasePath = join(root, "supervisor.db");
  const secretRoot = join(root, "runtime-secrets");
  await seedLegacySupervisorDatabase(databasePath, "legacy-runtime");
  const legacy = parseMcpServersConfig({
    defaultTrust: "untrusted",
    servers: [{
      key: "legacy-query",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      protocolVersion: "2024-11-05",
      timeoutMs: 4321,
      auth: { kind: "query", name: "key", secretEnv: "LEGACY_QUERY_KEY" },
      trust: "trusted",
      toolAllowlist: ["search"],
      aliases: ["旧数据源"],
      capabilities: [{
        id: "legacy.search",
        category: "data_asset",
        label: "Legacy search",
        description: "Search the legacy source.",
      }],
    }],
  });
  const starts: ResolvedLocalRuntimeConfiguration[] = [];
  let supervisor = legacySupervisor(databasePath, secretRoot, starts);
  try {
    await supervisor.ready("unused-default", {
      mcpConfiguration: legacy,
      integrationEnvironment: { LEGACY_QUERY_KEY: "legacy-query-secret" },
    });
    const publicConfiguration = await supervisor.configuration("legacy-runtime");
    assert.deepEqual(publicConfiguration.mcpServers[0], {
      id: publicConfiguration.mcpServers[0]!.id,
      displayName: "legacy-query",
      key: "legacy-query",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      protocolVersion: "2024-11-05",
      timeoutMs: 4321,
      auth: { kind: "query_parameter", parameterName: "key", credentialConfigured: true },
      toolAllowlist: ["search"],
      trust: "trusted",
      aliases: ["旧数据源"],
      capabilities: [{
        id: "legacy.search",
        category: "data_asset",
        label: "Legacy search",
        description: "Search the legacy source.",
      }],
    });
    assert.equal(starts.length, 1);
    const resolvedServer = starts[0]!.mcpServers[0]!;
    assert.equal(resolvedServer.auth?.kind, "query");
    assert.equal(
      resolvedServer.auth?.kind === "query" ? starts[0]!.integrationEnvironment[resolvedServer.auth.secretEnv] : undefined,
      "legacy-query-secret",
    );

    await supervisor.close();
    const restarted: ResolvedLocalRuntimeConfiguration[] = [];
    supervisor = legacySupervisor(databasePath, secretRoot, restarted);
    await supervisor.ready("unused-default", {
      mcpConfiguration: parseMcpServersConfig({ servers: [{
        key: "later-file-edit",
        transport: "http",
        url: "https://changed.example.test/mcp",
        auth: { kind: "none" },
      }] }),
    });
    assert.deepEqual((await supervisor.configuration("legacy-runtime")).mcpServers.map((server) => server.key), ["legacy-query"]);
    assert.deepEqual(restarted[0]!.mcpServers.map((server) => server.key), ["legacy-query"]);
  } finally {
    await supervisor.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy MCP credentials that cannot be resolved stop the Runtime until the user re-enters them", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-runtime-legacy-mcp-missing-"));
  const databasePath = join(root, "supervisor.db");
  const secretRoot = join(root, "runtime-secrets");
  await seedLegacySupervisorDatabase(databasePath, "legacy-runtime");
  const starts: ResolvedLocalRuntimeConfiguration[] = [];
  const supervisor = legacySupervisor(databasePath, secretRoot, starts);
  try {
    await supervisor.ready("unused-default", {
      mcpConfiguration: parseMcpServersConfig({ servers: [{
        key: "legacy-private",
        transport: "http",
        url: "https://mcp.example.test/mcp",
        auth: { kind: "bearer", tokenEnv: "MISSING_LEGACY_TOKEN" },
      }] }),
      integrationEnvironment: {},
    });
    assert.equal((await supervisor.list())[0]?.status, "stopped");
    assert.equal(starts.length, 0, "an incomplete migrated Runtime must not be advertised as ready");
    const configuration = await supervisor.configuration("legacy-runtime");
    assert.deepEqual(configuration.mcpServers[0]?.auth, { kind: "bearer", credentialConfigured: false });

    await supervisor.updateConfiguration("legacy-runtime", {
      mcpServers: [{
        id: configuration.mcpServers[0]!.id,
        displayName: "legacy-private",
        key: "legacy-private",
        transport: "http",
        url: "https://mcp.example.test/mcp",
        auth: { kind: "bearer", token: "re-entered-token" },
      }],
    });
    await supervisor.start("legacy-runtime");
    assert.equal((await supervisor.list())[0]?.status, "ready");
    assert.ok(Object.values(starts[0]!.integrationEnvironment).includes("re-entered-token"));
  } finally {
    await supervisor.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("browser translates a capacity failure without exposing Router internals", () => {
  assert.equal(
    submissionFailureMessage(Object.assign(new Error("runtime_capacity_exhausted"), { code: "runtime_capacity_exhausted" })),
    "当前本机 Runtime 任务过多，请稍候再试",
  );
});

test("deleting an idle child Runtime closes it and invokes its state reclaimer", async () => {
  const created: LocalRuntimeDefinition[] = [];
  const reclaimed: LocalRuntimeDefinition[] = [];
  const supervisor = new LocalRuntimeSupervisor(new AppDatabase(":memory:"), fakeFactory(created), async (definition) => { reclaimed.push(definition); });
  try {
    await supervisor.ready("local-default");
    const second = await supervisor.create("可删除 Runtime");
    await assert.rejects(supervisor.remove("local-default"), /default_runtime_cannot_be_deleted/);
    assert.deepEqual(await supervisor.remove(second.id), { runtimeId: second.id, reclaimedData: true });
    assert.equal((await supervisor.list()).some((runtime) => runtime.id === second.id), false);
    assert.deepEqual(reclaimed.map((definition) => definition.id), [second.id]);

    const activeChild = await supervisor.create("活动 Runtime");
    await supervisor.admitRun(activeChild.id, async () => ({ runId: "active-child-run", value: undefined }));
    await assert.rejects(supervisor.remove(activeChild.id), /runtime_active_runs_prevent_delete/);
    await supervisor.runSettled(activeChild.id, "active-child-run");
    await supervisor.remove(activeChild.id);

    const beforeReload = created.length;
    await supervisor.reloadRunningInstances();
    assert.equal(created.length, beforeReload + 1, "an idle, ready Runtime is recreated when device-level storage changes");

    const inFlight = supervisor.admitRun("local-default", async () => ({ runId: "active-run", value: undefined }));
    await inFlight;
    await assert.rejects(supervisor.reloadRunningInstances(), /runtime_active_runs_prevent_reconfiguration/);
    await assert.rejects(supervisor.remove("local-default"), /default_runtime_cannot_be_deleted/);
    await supervisor.runSettled("local-default", "active-run");
  } finally {
    await supervisor.close();
  }
});

test("directory grants belong to exactly one Runtime database", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-scope-isolation-"));
  const firstDatabase = new AppDatabase(":memory:");
  const secondDatabase = new AppDatabase(":memory:");
  try {
    const first = new LocalDirectoryScopeStore(firstDatabase);
    const second = new LocalDirectoryScopeStore(secondDatabase);
    await Promise.all([first.ready(), second.ready()]);
    const scope = await first.create(root, "only first");
    assert.equal("path" in scope, false, "Browser-facing scope metadata must not expose the absolute path");
    assert.deepEqual(await first.paths([scope.id]), [await realpath(root)]);
    await assert.rejects(second.paths([scope.id]), /directory scope is unavailable/);
    assert.deepEqual(await second.list(), []);
  } finally {
    await Promise.all([firstDatabase.close(), secondDatabase.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("revoking a directory removes it from the local authorization catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-scope-revoke-"));
  const database = new AppDatabase(":memory:");
  try {
    const scopes = new LocalDirectoryScopeStore(database);
    const scope = await scopes.create(root, "revocable");
    assert.deepEqual((await scopes.list()).map((item) => item.id), [scope.id]);
    await scopes.revoke(scope.id);
    assert.deepEqual(await scopes.list(), []);
    await assert.rejects(scopes.paths([scope.id]), /directory scope is unavailable/);
    // Existing device databases may contain tombstones written by earlier
    // releases; those must never reappear in the composer either.
    await database.prepare("INSERT INTO local_directory_scopes(id, display_name, path, status, created_at, updated_at) VALUES (?, ?, ?, 'revoked', ?, ?)")
      .run("lds_legacyrevoked", "legacy", root, 1, 1);
    assert.deepEqual(await scopes.list(), []);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("web keeps strict_local recovery support while normal placement uses the Local Runtime toggle", async () => {
  const [app, index, agent, service, factory, localAgentClient] = await Promise.all([
    readFile(new URL("../web/client/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/pages/app.html", import.meta.url), "utf8"),
    readFile(new URL("../local-agent-runtime/src/api/local-agent-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../local-agent-runtime/src/service/local-agent-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../local-agent-runtime/src/service/local-runtime-factory.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/client/local-runtime/local-agent-client.js", import.meta.url), "utf8"),
  ]);
  assert.match(app, /\/v1\/strict-local-runs/);
  assert.match(app, /async function localUploadSource\(file, conversationId, runtimeId\)/);
  assert.match(app, /function defaultUploadStoragePath\(sharedStoragePath\)/);
  assert.match(app, /localUploadedSourceIds: localSourceIds/);
  assert.match(app, /dataPlane: "local_runtime"/);
  assert.match(app, /\/v1\/directory-scopes\/pick/);
  assert.match(app, /function renderLocalScopes\(\)/);
  assert.match(app, /saveLocalRuntimePreference\(localStorage, sessionState\.user\?\.id, localDevice\?\.id, isLocalExecution\(\)\)/);
  assert.match(app, /const preference = loadLocalRuntimePreference\(localStorage, sessionState\.user\?\.id, localDevice\?\.id\)/);
  assert.match(app, /localToggle\.checked = preference === true/, "an uncached device must not inherit another device's checked state");
  assert.match(app, /Losing the live pairing only suspends the UI/);
  assert.match(app, /data-revoke-local-scope/);
  assert.match(app, /const activeScopes = localRuntimeState\.scopes\.filter\(\(scope\) => scope\.status === "active"\)/);
  assert.match(app, /\/v1\/local-runtimes\/\$\{encodeURIComponent\(runtimeId\)\}\/runs/);
  assert.doesNotMatch(app, /输入要授权给本机 Runtime 的目录绝对路径/);
  assert.doesNotMatch(app, /window\.prompt/);
  assert.match(index, /id="use-local-runtime" type="checkbox"/);
  assert.match(index, /id="local-runtime-picker"/);
  assert.match(index, /<dd class="settings-detail-value"><span id="agent-settings-storage">-<\/span><button id="agent-storage-pick"/);
  assert.match(index, /<dd class="settings-detail-value"><span id="agent-settings-upload-storage">-<\/span><button id="agent-upload-storage-pick"/);
  assert.doesNotMatch(index, /settings-action-row/, "each storage action must stay with its corresponding path value");
  assert.doesNotMatch(index, /id="execution-target"/);
  assert.match(index, /class="local-capability-title"[\s\S]*?id="local-agent-version"[\s\S]*?id="enable-local-runtime"/, "the compact readiness tag belongs beside the local-capability version");
  assert.match(index, /id="local-runtime-picker"[\s\S]*?id="use-local-runtime"[\s\S]*?id="runtime"/, "the local-execution checkbox must sit before the Runtime selector");
  assert.match(app, /const executionTarget = binding === undefined[\s\S]*?\? isLocalExecution\(\) \? "local" : "cloud"/);
  assert.match(app, /dataPolicy: \{ mode: executionTarget \}/);
  assert.match(app, /localAgentRouterPath/);
  assert.match(app, /async function localAgentFetch\(path, init = \{\}\)/);
  assert.match(localAgentClient, /body\.error !== "local_session_invalid" && body\.error !== "local_session_required"/);
  assert.match(app, /await refreshLocalSessionOnce\(\)/);
  assert.match(app, /localRuntimeState\.runtimes\.find\(\(runtime\) => runtime\.status === "ready" && runtime\.isDefault\)/, "the initial picker choice must prefer the persistent default Runtime");
  assert.match(app, /\$\("local-runtime-picker"\)\.hidden = !paired/, "a paired ready device exposes its Runtime selector even before local execution is enabled");
  assert.match(app, /localAgentFetch\("\/v1\/directory-scopes\/pick"/);
  assert.match(app, /const response = await agentAwareFetch\(endpoint\(\), \{ headers: headers\(\) \}\)/);
  assert.match(app, /if \(assistant\.assignmentId\) \{[\s\S]*?\/v1\/assignments\/\$\{encodeURIComponent\(assistant\.assignmentId\)\}\/artifacts/);
  assert.match(app, /`strict_local` has no Assignment and is the sole loopback-only path/);
  assert.match(service, /agent\.runtimes\.lifecycle/);
  assert.match(agent, /url\.pathname === "\/v1\/uploads"/);
  assert.match(service, /runtime\.runs\.uploadSource/);
  assert.match(agent, /localUploadedSourceIds: stringArray\(value\.localUploadedSourceIds/);
  assert.match(service, /sharedStorageRoot/);
  assert.match(service, /uploadStorageRoot/);
  assert.match(service, /agent\.config\.uploadStorage\.pick/);
  assert.match(factory, /runEventLogSink: \(line\) => this\.input\.runEventLogSink!\(definition, line\)/, "every Local Runtime must forward RunService events to the device Agent sink");
  assert.match(service, /join\(dirname\(input\.databasePath\), "uploads"\)/);
  assert.match(agent, /json\(response, 200, await service\.health\(\)\)/, "health must serialize the resolved application status, not a Promise as {}");
  assert.match(factory, /skillDirectories: packaged\?\.length \? packaged : bundledSkillDirectories\(\)/);
  assert.match(factory, /skillPackageRoots: configuration\.customSkillDirectories/);
  assert.match(factory, /servers: configuration\.mcpServers/);
  assert.doesNotMatch(factory, /loadSkillDirectoriesConfig|loadOptionalMcpToolsFromConfigFile/, "Factory must not load device-wide Runtime extensions");
  assert.doesNotMatch(agent, /import\s+\{[^}]*\}\s+from "@zhujun\/agentloop"|readFile\(|writeFile\(|new\s+LocalRuntimeSupervisor/, "HTTP transport must not own Runtime construction or device state persistence");
  assert.doesNotMatch(agent, /skills\/(install|update|rollback)/);
});

test("child Runtime dialogs render above settings with tabbed Skill and MCP configuration", async () => {
  const [index, styles, app] = await Promise.all([
    readFile(new URL("../web/pages/app.html", import.meta.url), "utf8"),
    readFile(new URL("../web/styles/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../web/client/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(index, /id="runtime-create-modal" class="runtime-modal runtime-modal-child"/);
  assert.match(index, /id="runtime-detail-modal" class="runtime-modal runtime-modal-child"/);
  assert.match(index, /id="runtime-config-modal" class="runtime-modal runtime-modal-child"/);
  assert.match(index, /role="tab" aria-selected="true"[^>]*data-runtime-capability-tab="skills"/);
  assert.match(index, /role="tabpanel"[^>]*data-runtime-capability-panel="mcp" hidden/);
  assert.match(index, /id="runtime-create-mcp-json"[^>]*>JSON 导入<\/button>/);
  assert.match(index, /id="runtime-config-mcp-json"[^>]*>JSON 导入<\/button>/);
  assert.match(index, /id="mcp-json-modal" class="runtime-modal runtime-modal-child runtime-json-modal"/);
  assert.match(index, /id="agent-settings-modal"[^>]*role="dialog"[^>]*aria-labelledby="agent-settings-title"/);
  assert.match(index, /id="agent-settings-close-icon"[^>]*aria-label="关闭 Local Runtime Agent 设置"/);
  assert.match(styles, /\.runtime-modal\{[^}]*z-index:var\(--runtime-modal-layer,1200\)/);
  assert.match(styles, /\.runtime-modal-child\{--runtime-modal-layer:1210\}/);
  assert.match(styles, /\.agent-settings-card\{width:min\(820px,100%\)/);
  assert.match(styles, /\.runtime-modal-close\{[^}]*width:34px[^}]*height:34px/);
  assert.match(styles, /\.agent-settings-card \.local-runtime-item:last-child \.local-runtime-action-menu-panel\{top:auto;bottom:36px\}/);
  assert.match(styles, /\.runtime-capability-tabs button\[aria-selected="true"\]/);
  assert.match(styles, /\.runtime-detail-card\{width:min\(640px,100%\)/);
  assert.match(app, /activateRuntimeCapabilityTab/);
  assert.match(app, /openLocalRuntimeDetails/);
  assert.match(app, /\$\("agent-settings-close-icon"\)\.addEventListener\("click", closeLocalAgentSettings\)/);
  assert.match(app, /renderLocalRuntimeDetails/);
  assert.match(app, /class="runtime-mcp-toolbar"/);
  assert.match(app, /class="runtime-mcp-remove" aria-label="移除 MCP Server" title="移除 MCP Server"/);
  assert.match(app, /服务标识<input data-mcp-field="key"/);
  assert.match(app, /用于工具命名空间，不是 \.env 凭据变量名/);
  assert.match(app, /parseMcpJsonImport/);
  assert.match(app, /toolAllowlist\.length === 0 \? \{\} : \{ toolAllowlist \}/);
});

test("strict_local recovery cache retains local Run and artifact transport identity", () => {
  let stored = "";
  const storage = {
    setItem(_key: string, value: string) { stored = value; },
    removeItem() { stored = ""; },
  };
  persistSessions(storage, [{
    id: "conversation-local", title: "local", createdAt: 1, updatedAt: 2, pendingAttachments: [],
    messages: [{
      id: "assistant-local", role: "assistant", text: "done", status: "completed", createdAt: 1,
      localRunId: "run-local", localRuntimeId: "runtime-local", runtimeId: "runtime-local", remoteRunId: "run-local",
      events: [], plan: [], artifacts: [{
        id: "artifact-local", runId: "run-local", name: "result.md", path: "local-artifact:artifact-local",
        mimeType: "text/markdown", bytes: 4, role: "final", sourceTool: "computer_write_file",
        sha256: "artifact-sha", location: "local", previewable: false,
      }],
    }],
  }]);
  const assistant = JSON.parse(stored)[0].messages[0];
  assert.equal(assistant.localRunId, "run-local");
  assert.equal(assistant.localRuntimeId, "runtime-local");
  assert.equal(assistant.artifacts[0].location, "local");
  assert.equal(assistant.artifacts[0].previewable, false);
  assert.equal(assistant.artifacts[0].role, "final");
  assert.equal(assistant.artifacts[0].sourceTool, "computer_write_file");
  assert.equal(assistant.artifacts[0].runId, "run-local");
  assert.equal(assistant.artifacts[0].sha256, "artifact-sha");
});

function legacySupervisor(databasePath: string, secretRoot: string, starts: ResolvedLocalRuntimeConfiguration[]): LocalRuntimeSupervisor {
  const database = new AppDatabase(databasePath);
  const configurations = new LocalRuntimeConfigurationStore(database, new EncryptedLocalRuntimeSecretStore(secretRoot));
  return new LocalRuntimeSupervisor(
    database,
    async (definition, configuration) => {
      starts.push(configuration);
      return fakeRuntime(definition);
    },
    undefined,
    DEFAULT_LOCAL_RUNTIME_MAX_CONCURRENT_RUNS,
    configurations,
  );
}

async function seedLegacySupervisorDatabase(databasePath: string, runtimeId: string): Promise<void> {
  const database = new AppDatabase(databasePath);
  const now = Date.now();
  try {
    await database.exec(`
      CREATE TABLE local_runtime_instances (
        runtime_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        storage_key TEXT NOT NULL UNIQUE,
        is_default INTEGER NOT NULL CHECK(is_default IN (0, 1)),
        status TEXT NOT NULL CHECK(status IN ('ready', 'draining', 'restarting', 'stopped', 'failed')),
        pending_action TEXT CHECK(pending_action IN ('restart', 'stop')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE local_runtime_mcp_servers (
        mcp_server_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL REFERENCES local_runtime_instances(runtime_id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        source_key TEXT NOT NULL,
        transport TEXT NOT NULL CHECK(transport = 'http'),
        url TEXT NOT NULL,
        protocol_version TEXT,
        timeout_ms INTEGER,
        auth_kind TEXT NOT NULL CHECK(auth_kind IN ('none', 'bearer', 'api_key_header', 'basic', 'custom_headers')),
        auth_config_json TEXT NOT NULL,
        secret_storage_key TEXT,
        tool_policy_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(runtime_id, source_key)
      );
    `);
    await database.prepare(`
      INSERT INTO local_runtime_instances(runtime_id, display_name, storage_key, is_default, status, pending_action, created_at, updated_at)
      VALUES (?, 'Legacy Runtime', 'default', 1, 'ready', NULL, ?, ?)
    `).run(runtimeId, now, now);
  } finally {
    await database.close();
  }
}

function fakeFactory(created: LocalRuntimeDefinition[]): (definition: LocalRuntimeDefinition) => Promise<LocalRuntimeControl> {
  return async (definition) => {
    created.push(definition);
    return fakeRuntime(definition);
  };
}

function fakeRuntime(definition: LocalRuntimeDefinition): LocalRuntimeControl {
  return {
    ...definition,
    database: new AppDatabase(":memory:"),
    runs: {} as LocalRuntimeControl["runs"],
    scopes: {} as LocalRuntimeControl["scopes"],
    modelKeys: ["shared-model"],
    activeRunIds: new Set<string>(),
  };
}
