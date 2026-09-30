import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeConfigurationSnapshot, RuntimeTarget } from "../control-plane/contracts/index.ts";
import { RuntimeConfigurationClient, RuntimeConfigurationClientError } from "../src/runtime-host/application/configuration/runtime-configuration-client.ts";
import { compareRuntimeConfigurationShadow } from "../src/runtime-host/application/configuration/runtime-configuration-shadow.ts";
import { createRuntimeConfigurationShadowOrchestrator, type RuntimeConfigurationShadowLogEntry } from "../src/runtime-host/application/configuration/runtime-configuration-shadow-orchestrator.ts";

const target: RuntimeTarget = { plane: "cloud", tenantId: "tenant-a", runtimeId: "runtime-a" };
const hash = "a".repeat(64);

function snapshot(overrides: Partial<RuntimeConfigurationSnapshot> = {}): RuntimeConfigurationSnapshot {
  return {
    contractVersion: "control-plane/v1", snapshotId: "snapshot-a", configurationRevision: 7, target, resolvedAt: 100, validUntil: 200,
    modelRoute: { releaseId: "model-r1", contentHash: hash }, integrations: [{ bindingId: "integration-a", releaseId: "integration-r1", contentHash: hash }], skills: [], policies: [], ...overrides,
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
