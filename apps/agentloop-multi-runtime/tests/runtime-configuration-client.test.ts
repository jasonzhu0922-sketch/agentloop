import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import type { RuntimeConfigurationSnapshot, RuntimeTarget } from "../control-plane/contracts/index.ts";
import { RuntimeConfigurationClient, RuntimeConfigurationClientError } from "../src/runtime-host/application/configuration/runtime-configuration-client.ts";
import { compareRuntimeConfigurationShadow } from "../src/runtime-host/application/configuration/runtime-configuration-shadow.ts";
import { createRuntimeConfigurationShadowOrchestrator, type RuntimeConfigurationShadowLogEntry } from "../src/runtime-host/application/configuration/runtime-configuration-shadow-orchestrator.ts";
import { ControlPlaneAdmissionRunResolver, RunEnvironmentResolver, RunEnvironmentUnavailableError, type LoadedRuntimeConfigurationSnapshotCache } from "../src/runtime-host/application/configuration/run-environment-resolver.ts";
import { AgentLoopRuntimeHost } from "../src/runtime-host/application/runtime-host.ts";
import { SqlRuntimeConfigurationSnapshotCache, installRuntimeConfigurationSnapshotCache, installRuntimeConfigurationSnapshotHistory } from "../src/runtime-host/persistence/runtime-configuration-snapshot-cache.ts";
import { HostDispatchStore } from "../src/runtime-host/persistence/host-dispatch-store.ts";

const target: RuntimeTarget = { plane: "cloud", tenantId: "tenant-a", runtimeId: "runtime-a" };
const hash = "a".repeat(64);

function snapshot(overrides: Partial<RuntimeConfigurationSnapshot> = {}): RuntimeConfigurationSnapshot {
  return {
    contractVersion: "control-plane/v1", snapshotId: "snapshot-a", configurationRevision: 7, target, resolvedAt: 100, validUntil: 200,
    modelRoute: { releaseId: "model-r1", contentHash: hash, providerConfiguration: {} }, integrations: [{ bindingId: "integration-a", releaseId: "integration-r1", contentHash: hash }], skills: [], policies: [], ...overrides,
  };
}

test("RuntimeConfigurationClient verifies target and expiry before caching a delivery snapshot", async () => {
  const client = new RuntimeConfigurationClient({
    deliveryUrl: "https://admin.example.test", workloadToken: "not-logged", target, now: () => 150,
    request: (async () => new Response(JSON.stringify(snapshot()), { status: 200 })) as typeof fetch,
  });
  assert.equal((await client.desiredSnapshot()).snapshotId, "snapshot-a");
  assert.equal(client.cachedSnapshot()?.snapshotId, "snapshot-a");
  const mismatched = new RuntimeConfigurationClient({
    deliveryUrl: "https://admin.example.test", workloadToken: "not-logged", target, now: () => 150,
    request: (async () => new Response(JSON.stringify(snapshot({ target: { ...target, runtimeId: "other" } })), { status: 200 })) as typeof fetch,
  });
  await assert.rejects(() => mismatched.desiredSnapshot(), RuntimeConfigurationClientError);
  const expired = new RuntimeConfigurationClient({
    deliveryUrl: "https://admin.example.test", workloadToken: "not-logged", target, now: () => 200,
    request: (async () => new Response(JSON.stringify(snapshot()), { status: 200 })) as typeof fetch,
  });
  await assert.rejects(() => expired.desiredSnapshot(), RuntimeConfigurationClientError);
});

test("validation receipts retain release content hashes and never claim loaded", async () => {
  const bodies: unknown[] = [];
  const client = new RuntimeConfigurationClient({
    deliveryUrl: "https://admin.example.test", workloadToken: "not-logged", target, now: () => 150,
    request: (async (input, init) => {
      if (String(input).includes("desired-configuration")) return new Response(JSON.stringify(snapshot()), { status: 200 });
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: "recorded" }), { status: 201 });
    }) as typeof fetch,
  });
  const desired = await client.desiredSnapshot();
  await client.reportValidated(desired, (releaseId) => `receipt-${releaseId}`);
  assert.deepEqual(bodies, [
    { receipt: { contractVersion: "control-plane/v1", receiptId: "receipt-model-r1", target, releaseId: "model-r1", contentHash: hash, status: "validated", observedAt: 150 } },
    { receipt: { contractVersion: "control-plane/v1", receiptId: "receipt-integration-r1", target, releaseId: "integration-r1", contentHash: hash, status: "validated", observedAt: 150 } },
  ]);
});

test("shadow comparison refuses a superficial count match as equivalence", () => {
  const baseline = { modelKeys: ["model-a"], skillDirectoryCount: 1, practiceProfileCount: 1, stepExecutionStrategyProfile: "action-aware" };
  const completeComponents = snapshot({ skills: [{ releaseId: "skill-r1", packageHash: hash, contentHash: hash }], policies: [{ releaseId: "policy-r1", contentHash: hash }] });
  assert.deepEqual(compareRuntimeConfigurationShadow({ baseline, snapshot: completeComponents }), {
    status: "incomplete", snapshot: completeComponents, differences: ["release_content_to_file_baseline_mapping_not_yet_declared", "step_execution_strategy_mapping_not_yet_declared"],
  });
  const empty = snapshot({ modelRoute: undefined, integrations: [], skills: [], policies: [] });
  assert.equal(compareRuntimeConfigurationShadow({ baseline, snapshot: empty }).status, "different");
  assert.equal(compareRuntimeConfigurationShadow({ baseline: { modelKeys: [], skillDirectoryCount: 0, practiceProfileCount: 0, stepExecutionStrategyProfile: "action-aware" }, snapshot: empty }).status, "incomplete");
});

test("shadow orchestration requires explicit delivery, workload, and tenant settings before making requests", async () => {
  let requests = 0;
  const baseline = { modelKeys: ["model-a"], skillDirectoryCount: 1, practiceProfileCount: 1, stepExecutionStrategyProfile: "action-aware" };
  assert.equal(createRuntimeConfigurationShadowOrchestrator({
    environment: { CONTROL_PLANE_DELIVERY_URL: "https://admin.example.test", CONTROL_PLANE_WORKLOAD_TOKEN: "not-logged" }, runtimeId: "runtime-a", baseline, log: () => {},
    request: (async () => { requests += 1; return new Response(null, { status: 500 }); }) as typeof fetch,
  }), undefined);
  assert.equal(requests, 0);
});

test("shadow orchestration records a sanitized failure and leaves file-mode callers non-blocking", async () => {
  const logs: RuntimeConfigurationShadowLogEntry[] = [];
  const baseline = { modelKeys: ["model-a"], skillDirectoryCount: 1, practiceProfileCount: 1, stepExecutionStrategyProfile: "action-aware" };
  const shadow = createRuntimeConfigurationShadowOrchestrator({
    environment: {
      CONTROL_PLANE_DELIVERY_URL: "https://admin.example.test", CONTROL_PLANE_WORKLOAD_TOKEN: "not-logged", CONTROL_PLANE_SHADOW_TENANT_ID: "tenant-a",
    },
    runtimeId: "runtime-a", baseline, log: (entry) => logs.push(entry),
    request: (async () => { throw new Error("contains a delivery URL and token-like data"); }) as typeof fetch,
  });
  assert.ok(shadow);
  shadow.start();
  await new Promise((resolve) => setImmediate(resolve));
  shadow.stop();
  assert.deepEqual(logs, [{ event: "runtime_configuration_shadow", status: "failed", target, code: "configuration_unavailable" }]);
});

test("RunEnvironmentResolver freezes independently loaded provider registries and does not fall back to file configuration", async () => {
  const snapshots = [
    snapshot({ snapshotId: "snapshot-old", modelRoute: { releaseId: "model-old", contentHash: hash, providerConfiguration: providerConfiguration("old-model") } }),
    snapshot({ snapshotId: "snapshot-new", modelRoute: { releaseId: "model-new", contentHash: hash, providerConfiguration: providerConfiguration("new-model") } }),
  ];
  const receipts: string[] = [];
  const cache = new MemorySnapshotCache();
  const resolver = new RunEnvironmentResolver({
    delivery: {
      desiredSnapshot: async () => snapshots.shift()!,
      reportLoaded: async (value, receiptIdFor) => { receipts.push(`${value.snapshotId}:${receiptIdFor(value.modelRoute!.releaseId)}`); },
    },
    cache, environment: { TEST_API_KEY: "not-a-real-secret" }, createReceiptId: () => "receipt",
  });
  const oldEnvironment = await resolver.resolveForAdmission(target);
  const newEnvironment = await resolver.resolveForAdmission(target);
  assert.deepEqual(oldEnvironment.providers.modelKeys(), ["old-model"]);
  assert.deepEqual(newEnvironment.providers.modelKeys(), ["new-model"]);
  assert.deepEqual(receipts, ["snapshot-old:loaded:snapshot-old:model-old:receipt", "snapshot-new:loaded:snapshot-new:model-new:receipt"]);
  const restoredOld = await resolver.restoreForRun(target, oldEnvironment.configurationSnapshot);
  assert.deepEqual(restoredOld.providers.modelKeys(), ["old-model"]);
  await assert.rejects(() => resolver.restoreForRun(target, {
    ...oldEnvironment.configurationSnapshot,
    releases: [{ kind: "model_route", releaseId: "model-old", contentHash: "b".repeat(64) }],
  }), RunEnvironmentUnavailableError);
  const unavailable = new RunEnvironmentResolver({
    delivery: { desiredSnapshot: async () => { throw new Error("offline"); }, reportLoaded: async () => {} },
    cache, environment: {}, createReceiptId: () => "receipt",
  });
  await assert.rejects(() => unavailable.resolveForAdmission(target), RunEnvironmentUnavailableError);
});

test("Host rebinds existing Run queries to the persisted snapshot port instead of its default port", async () => {
  const configurationSnapshot = {
    snapshotId: "snapshot-old", configurationRevision: 7,
    releases: [{ kind: "model_route" as const, releaseId: "model-old", contentHash: hash }],
  };
  let recovered = 0;
  const defaultPort = {
    async ensureConversation() {},
    async startConversation() { return { id: "run-old", status: "running" as const }; },
    async get() { return { id: "run-old", status: "running" as const, configurationSnapshot }; },
  };
  const oldSnapshotPort = {
    async ensureConversation() {},
    async startConversation() { return { id: "run-old", status: "running" as const }; },
    async get() { recovered += 1; return { id: "run-old", status: "running" as const, modelKey: "old-model", configurationSnapshot }; },
  };
  const host = new AgentLoopRuntimeHost(defaultPort, { async importForRun() { return []; } }, undefined, undefined, {
    async resolveForAdmission() { return defaultPort; },
    async resolveForRun(reference) { assert.deepEqual(reference, configurationSnapshot); return oldSnapshotPort; },
  });
  await host.dispatch({
    schema: "agentloop.runtimeDispatch/v1", assignmentId: "assignment-old", dispatchKey: "dispatch-old",
    subject: { tenantId: "tenant-a", userId: "user-a" }, conversationId: "conversation-a", input: "continue", allowDangerousTools: false, resourceRefs: [],
  });
  assert.deepEqual(await host.getRun("run-old"), { remoteRunId: "run-old", status: "running", modelKey: "old-model" });
  assert.equal(recovered, 1);
});

test("durable snapshot history preserves old and new Run bindings while the target pointer advances", async () => {
  const database = new AppDatabase(":memory:");
  await installRuntimeConfigurationSnapshotCache(database);
  await installRuntimeConfigurationSnapshotHistory(database);
  const cache = new SqlRuntimeConfigurationSnapshotCache(database);
  const oldSnapshot = snapshot({ snapshotId: "snapshot-old", modelRoute: { releaseId: "model-old", contentHash: hash, providerConfiguration: providerConfiguration("old-model") } });
  const newSnapshot = snapshot({ snapshotId: "snapshot-new", modelRoute: { releaseId: "model-new", contentHash: hash, providerConfiguration: providerConfiguration("new-model") } });
  await cache.put(oldSnapshot);
  await cache.put(newSnapshot);
  assert.equal((await cache.get(target))?.snapshotId, "snapshot-new");
  assert.equal((await cache.getBySnapshotId(target, "snapshot-old"))?.modelRoute?.releaseId, "model-old");
  await assert.rejects(() => cache.put({ ...oldSnapshot, validUntil: oldSnapshot.validUntil + 1 }), /immutable/);
  await database.close();
});

test("a restarted Host restores an owned Run through its exact historical snapshot and re-receipts it", async () => {
  const database = new AppDatabase(":memory:");
  const dispatches = new HostDispatchStore(database, "runtime-a");
  await dispatches.ready();
  await dispatches.claim({ dispatchKey: "dispatch-old", assignmentId: "assignment-old", ownerUserId: "user-a", now: 100, leaseMs: 1_000 });
  await dispatches.accept("dispatch-old", "run-old", 101);
  const oldSnapshot = snapshot({ snapshotId: "snapshot-old", modelRoute: { releaseId: "model-old", contentHash: hash, providerConfiguration: providerConfiguration("old-model") } });
  const newSnapshot = snapshot({ snapshotId: "snapshot-new", modelRoute: { releaseId: "model-new", contentHash: hash, providerConfiguration: providerConfiguration("new-model") } });
  let recoveryReceipts = 0;
  const environments = new RunEnvironmentResolver({
    delivery: {
      desiredSnapshot: async () => newSnapshot,
      reportLoaded: async (_value, receiptIdFor) => { if (receiptIdFor("model-old").startsWith("recovered:")) recoveryReceipts += 1; },
    },
    cache: new MemorySnapshotCache([oldSnapshot, newSnapshot]), environment: { TEST_API_KEY: "not-a-real-secret" }, createReceiptId: () => "receipt",
  });
  const admissions = new ControlPlaneAdmissionRunResolver(target, environments, (environment) => ({
    async ensureConversation() {},
    async startConversation() { return { id: "run-old", status: "running" as const }; },
    async get() { return { id: "run-old", status: "running" as const, modelKey: environment.providers.defaultModelKey, configurationSnapshot: configurationReference(oldSnapshot) }; },
  }));
  const defaultPort = {
    async ensureConversation() {},
    async startConversation() { return { id: "run-old", status: "running" as const }; },
    async get() { return { id: "run-old", status: "running" as const, configurationSnapshot: configurationReference(oldSnapshot) }; },
  };
  const restarted = new AgentLoopRuntimeHost(defaultPort, { async importForRun() { return []; } }, undefined, dispatches, admissions);
  assert.equal((await restarted.getRun("run-old")).modelKey, "old-model");
  assert.equal(recoveryReceipts, 1);
  await database.close();
});

test("RunEnvironmentResolver rebuilds and re-receipts an unexpired confirmed snapshot after restart", async () => {
  const cached = snapshot({ validUntil: 500, modelRoute: { releaseId: "model-r1", contentHash: hash, providerConfiguration: providerConfiguration("restored-model") } });
  const cache = new MemorySnapshotCache([cached]);
  let reported = 0;
  const resolver = new RunEnvironmentResolver({
    delivery: { desiredSnapshot: async () => cached, reportLoaded: async () => { reported += 1; } },
    cache, environment: { TEST_API_KEY: "not-a-real-secret" }, createReceiptId: () => "receipt",
  });
  assert.deepEqual((await resolver.restoreConfirmed(target, () => 400)).providers.modelKeys(), ["restored-model"]);
  assert.equal(reported, 1);
  await assert.rejects(() => resolver.restoreConfirmed(target, () => 500), RunEnvironmentUnavailableError);
});

test("control-plane admission rejects another tenant instead of selecting the file-mode port", async () => {
  const loaded = snapshot({ modelRoute: { releaseId: "model-r1", contentHash: hash, providerConfiguration: providerConfiguration("admission-model") } });
  const environments = new RunEnvironmentResolver({
    delivery: { desiredSnapshot: async () => loaded, reportLoaded: async () => {} }, cache: new MemorySnapshotCache(), environment: { TEST_API_KEY: "not-a-real-secret" }, createReceiptId: () => "receipt",
  });
  const port = { async ensureConversation() {}, async startConversation() { return { id: "run" as string, status: "running" as const }; }, async get() { return { id: "run", status: "running" as const }; } };
  const admissions = new ControlPlaneAdmissionRunResolver(target, environments, () => port);
  assert.equal(await admissions.resolveForAdmission({ tenantId: "tenant-a", userId: "user-a" }), port);
  await assert.rejects(() => admissions.resolveForAdmission({ tenantId: "tenant-other", userId: "user-a" }), RunEnvironmentUnavailableError);
});

function providerConfiguration(modelKey: string): Record<string, unknown> {
  return {
    defaultProvider: "test", defaultModelKey: modelKey,
    providers: {
      test: { kind: "openai-compatible", baseUrl: "https://models.example.test/v1", apiKeyEnv: "TEST_API_KEY", defaultModel: modelKey, protocol: "chat-completions" },
    },
    models: { [modelKey]: { providerKey: "test", providerModel: modelKey, displayName: modelKey } },
  };
}

function configurationReference(value: RuntimeConfigurationSnapshot) {
  return {
    snapshotId: value.snapshotId,
    configurationRevision: value.configurationRevision,
    releases: [
      ...(value.modelRoute === undefined ? [] : [{ kind: "model_route" as const, releaseId: value.modelRoute.releaseId, contentHash: value.modelRoute.contentHash }]),
      ...value.integrations.map((item) => ({ kind: "integration" as const, releaseId: item.releaseId, contentHash: item.contentHash })),
      ...value.skills.map((item) => ({ kind: "skill" as const, releaseId: item.releaseId, contentHash: item.contentHash, packageHash: item.packageHash })),
      ...value.policies.map((item) => ({ kind: "policy" as const, releaseId: item.releaseId, contentHash: item.contentHash })),
    ],
  };
}

class MemorySnapshotCache implements LoadedRuntimeConfigurationSnapshotCache {
  private readonly snapshots = new Map<string, RuntimeConfigurationSnapshot>();
  private readonly history = new Map<string, RuntimeConfigurationSnapshot>();
  public constructor(initial: readonly RuntimeConfigurationSnapshot[] = []) { for (const value of initial) this.putSync(value); }
  public async get(candidate: RuntimeTarget): Promise<RuntimeConfigurationSnapshot | undefined> { return this.snapshots.get(targetKey(candidate)); }
  public async getBySnapshotId(candidate: RuntimeTarget, snapshotId: string): Promise<RuntimeConfigurationSnapshot | undefined> {
    const value = this.history.get(snapshotId);
    return value !== undefined && targetKey(value.target) === targetKey(candidate) ? value : undefined;
  }
  public async put(value: RuntimeConfigurationSnapshot): Promise<void> { this.putSync(value); }
  private putSync(value: RuntimeConfigurationSnapshot): void {
    this.snapshots.set(targetKey(value.target), value);
    this.history.set(value.snapshotId, value);
  }
}

function targetKey(value: RuntimeTarget): string { return `${value.plane}:${value.tenantId}:${value.runtimeId}:${value.runtimeClass ?? ""}:${value.deviceId ?? ""}`; }
