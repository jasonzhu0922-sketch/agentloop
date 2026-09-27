import assert from "node:assert/strict";
import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { LocalDirectoryScopeStore } from "../local-agent-runtime/src/local-directory-scope-store.ts";
import { DEFAULT_LOCAL_RUNTIME_MAX_CONCURRENT_RUNS, LocalRuntimeSupervisor, type LocalRuntimeControl, type LocalRuntimeDefinition } from "../local-agent-runtime/src/local-runtime-supervisor.ts";
import { persistSessions } from "../web/session-persistence.js";
import { loadLocalRuntimePreference, localRuntimePreferenceKey, saveLocalRuntimePreference } from "../web/local-runtime-preference.js";
import { submissionFailureMessage } from "../web/submission-failure-message.js";

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

    await supervisor.stop(second.id);
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
  const [app, index] = await Promise.all([
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
  ]);
  const agent = await readFile(new URL("../local-agent-runtime/src/local-agent-server.ts", import.meta.url), "utf8");
  assert.match(app, /\/v1\/strict-local-runs/);
  assert.match(app, /async function localUploadSource\(file, conversationId, runtimeId\)/);
  assert.match(app, /function defaultUploadStoragePath\(sharedStoragePath\)/);
  assert.match(app, /localUploadedSourceIds: localSourceIds/);
  assert.match(app, /dataPlane: "local_runtime"/);
  assert.match(app, /\/v1\/directory-scopes\/pick/);
  assert.match(app, /function renderLocalScopes\(\)/);
  assert.match(app, /saveLocalRuntimePreference\(localStorage, authenticatedUser\?\.id, localDevice\?\.id, isLocalExecution\(\)\)/);
  assert.match(app, /const preference = loadLocalRuntimePreference\(localStorage, authenticatedUser\?\.id, localDevice\?\.id\)/);
  assert.match(app, /localToggle\.checked = preference === true/, "an uncached device must not inherit another device's checked state");
  assert.match(app, /Losing the live pairing only suspends the UI/);
  assert.match(app, /data-revoke-local-scope/);
  assert.match(app, /const activeScopes = localScopes\.filter\(\(scope\) => scope\.status === "active"\)/);
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
  assert.match(app, /const executionTarget = isLocalExecution\(\) \? "local" : "cloud"/);
  assert.match(app, /dataPolicy: \{ mode: executionTarget \}/);
  assert.match(app, /localAgentRouterPath/);
  assert.match(app, /async function localAgentFetch\(path, init = \{\}\)/);
  assert.match(app, /body\.error !== "local_session_invalid" && body\.error !== "local_session_required"/);
  assert.match(app, /await refreshLocalSessionOnce\(\)/);
  assert.match(app, /localRuntimes\.find\(\(runtime\) => runtime\.status === "ready" && runtime\.isDefault\)/, "the initial picker choice must prefer the persistent default Runtime");
  assert.match(app, /\$\("local-runtime-picker"\)\.hidden = !paired/, "a paired ready device exposes its Runtime selector even before local execution is enabled");
  assert.match(app, /localAgentFetch\("\/v1\/directory-scopes\/pick"/);
  assert.match(app, /const response = await agentAwareFetch\(endpoint\(\), \{ headers: headers\(\) \}\)/);
  assert.match(app, /if \(assistant\.assignmentId\) \{[\s\S]*?\/v1\/assignments\/\$\{encodeURIComponent\(assistant\.assignmentId\)\}\/artifacts/);
  assert.match(app, /`strict_local` has no Assignment and is the sole loopback-only path/);
  assert.match(agent, /agent\.runtimes\.lifecycle/);
  assert.match(agent, /url\.pathname === "\/v1\/uploads"/);
  assert.match(agent, /runtime\.runs\.uploadSource/);
  assert.match(agent, /sourceIds: stringArray\(value\.localUploadedSourceIds/);
  assert.match(agent, /sharedStorageRoot/);
  assert.match(agent, /uploadStorageRoot/);
  assert.match(agent, /agent\.config\.uploadStorage\.pick/);
  assert.match(agent, /runEventLogSink: \(line\) => input\.runEventLogSink!\(definition, line\)/, "every Local Runtime must forward RunService events to the device Agent sink");
  assert.match(agent, /join\(dirname\(input\.databasePath\), "uploads"\)/);
  assert.match(agent, /json\(response, 200, await agentStatus\(/, "health must serialize the resolved control-plane status, not a Promise as {}");
  assert.match(agent, /mergeSkillDirectories\(packagedSkillDirectories\?\.length \? packagedSkillDirectories : bundledSkillDirectories\(\), custom\)/);
  assert.doesNotMatch(agent, /skills\/(install|update|rollback)/);
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

function fakeFactory(created: LocalRuntimeDefinition[]): (definition: LocalRuntimeDefinition) => Promise<LocalRuntimeControl> {
  return async (definition) => {
    created.push(definition);
    return {
      ...definition,
      database: new AppDatabase(":memory:"),
      runs: {} as LocalRuntimeControl["runs"],
      scopes: {} as LocalRuntimeControl["scopes"],
      modelKeys: ["shared-model"],
      activeRunIds: new Set<string>(),
    };
  };
}
