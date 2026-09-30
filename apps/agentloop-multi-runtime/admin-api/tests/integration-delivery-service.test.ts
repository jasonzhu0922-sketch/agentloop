import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import type { CredentialGrantRequest, IntegrationInvocationRequest, RuntimeConfigurationSnapshot, RuntimeTarget } from "../../control-plane/contracts/index.ts";
import { ControlPlaneError } from "../../control-plane/domain/index.ts";
import { SqlIntegrationDeliveryService, type IntegrationSecretProviderPort } from "../src/application/integration-delivery-service.ts";
import { migrateControlPlane } from "../src/persistence/control-plane-migrations.ts";

const target: RuntimeTarget = { plane: "cloud", tenantId: "tenant-a", runtimeId: "runtime-a" };
const contentHash = "a".repeat(64);
const snapshot: RuntimeConfigurationSnapshot = {
  contractVersion: "control-plane/v1", snapshotId: "snapshot-a", configurationRevision: 1, target,
  resolvedAt: 1_000, validUntil: 5_000, modelRoute: undefined,
  integrations: [{ bindingId: "binding-a", releaseId: "integration-r1", contentHash, integration: "enterprise_info", allowedActions: ["search", "detail"] }],
  skills: [], policies: [],
};

function grantRequest(action = "search"): CredentialGrantRequest {
  return {
    contractVersion: "control-plane/v1", invocationId: "invocation-a", runId: "run-a", planId: "plan-a", stepId: "step-a",
    integration: "enterprise_info", action, bindingId: "binding-a", releaseId: "integration-r1", contentHash,
    skillNames: ["enterprise-info"], requestedAt: 1_000,
  };
}

async function createService(provider: IntegrationSecretProviderPort, rotationState = "active") {
  const database = new AppDatabase(":memory:");
  await migrateControlPlane(database);
  await database.prepare("INSERT INTO cp_secret_references(id, provider, secret_key, secret_version, rotation_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("secret-ref-a", "test-provider", "enterprise-info", "version-a", rotationState, 1, 1);
  await database.prepare("INSERT INTO cp_integration_bindings(id, release_id, credential_reference_id, scope_json, egress_policy_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("binding-a", "integration-r1", "secret-ref-a", "{}", "{}", 1);
  const service = new SqlIntegrationDeliveryService({ database, snapshots: { desiredSnapshot: async () => snapshot }, secretProvider: provider, now: () => 1_000, grantTtlMs: 500 });
  return { database, service };
}

test("integration delivery derives grants from the active target binding and persists only redacted invocation metadata", async () => {
  const calls: Parameters<IntegrationSecretProviderPort["invoke"]>[0][] = [];
  const { database, service } = await createService({
    invoke: async (input) => {
      calls.push(input);
      return { queries: [{ name: "Example Co", action: "search", result: { items: [] } }] };
    },
  });
  try {
    const grant = await service.requestGrant(target, grantRequest());
    assert.equal(grant.secretReferenceVersion, "version-a");
    assert.equal("secretReferenceId" in grant, false);
    const invocation: IntegrationInvocationRequest = { contractVersion: "control-plane/v1", grantId: grant.grantId, invocation: grantRequest(), args: { names: ["Example Co"] } };
    const response = await service.invoke(target, invocation);
    assert.deepEqual(response.result, { queries: [{ name: "Example Co", action: "search", result: { items: [] } }] });
    assert.equal(response.receipt.status, "completed");
    assert.deepEqual(calls, [{ target, integration: "enterprise_info", action: "search", secretReferenceId: "secret-ref-a", secretReferenceVersion: "version-a", args: { names: ["Example Co"] } }]);
    const stored = await database.prepare("SELECT action, args_hash, secret_reference_version, status, reason_code FROM cp_integration_invocations").get<{ action: string; args_hash: string; secret_reference_version: string; status: string; reason_code: string | null }>();
    assert.equal(stored?.action, "search");
    assert.match(stored?.args_hash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(stored?.secret_reference_version, "version-a");
    assert.equal(stored?.status, "completed");
    assert.equal(stored?.reason_code, null);
    await assert.rejects(() => service.invoke(target, invocation), (error: unknown) => error instanceof ControlPlaneError && error.code === "credential_grant_expired");
  } finally {
    await database.close();
  }
});

test("integration delivery fails closed for missing authorization, inactive credentials, unsafe output, and upstream failure", async () => {
  const authorized = await createService({ invoke: async () => ({ queries: [] }) });
  try {
    await assert.rejects(() => authorized.service.requestGrant(target, { ...grantRequest(), action: "delete" }), (error: unknown) => error instanceof ControlPlaneError && error.code === "integration_not_authorized");
  } finally { await authorized.database.close(); }

  const inactive = await createService({ invoke: async () => ({ queries: [] }) }, "rotating");
  try {
    await assert.rejects(() => inactive.service.requestGrant(target, grantRequest()), (error: unknown) => error instanceof ControlPlaneError && error.code === "credential_grant_expired");
  } finally { await inactive.database.close(); }

  const invalid = await createService({ invoke: async () => ({ access_token: "must-not-cross-the-broker" }) });
  try {
    const grant = await invalid.service.requestGrant(target, grantRequest());
    await assert.rejects(() => invalid.service.invoke(target, { contractVersion: "control-plane/v1", grantId: grant.grantId, invocation: grantRequest(), args: {} }), (error: unknown) => error instanceof ControlPlaneError && error.code === "integration_response_invalid");
    const receipt = await invalid.database.prepare("SELECT status, reason_code FROM cp_integration_invocations").get<{ status: string; reason_code: string }>();
    assert.equal(receipt?.status, "failed");
    assert.equal(receipt?.reason_code, "integration_response_invalid");
  } finally { await invalid.database.close(); }

  const failed = await createService({ invoke: async () => { throw new Error("provider unavailable"); } });
  try {
    const grant = await failed.service.requestGrant(target, grantRequest());
    await assert.rejects(() => failed.service.invoke(target, { contractVersion: "control-plane/v1", grantId: grant.grantId, invocation: grantRequest(), args: {} }), (error: unknown) => error instanceof ControlPlaneError && error.code === "integration_upstream_failed");
  } finally { await failed.database.close(); }
});

test("credential rotation can revoke an unconsumed binding grant before it reaches the secret provider", async () => {
  let invoked = false;
  const { database, service } = await createService({ invoke: async () => { invoked = true; return { queries: [] }; } });
  try {
    const grant = await service.requestGrant(target, grantRequest());
    assert.equal(await service.revokeBinding("binding-a"), 1);
    await assert.rejects(() => service.invoke(target, { contractVersion: "control-plane/v1", grantId: grant.grantId, invocation: grantRequest(), args: {} }), (error: unknown) => error instanceof ControlPlaneError && error.code === "credential_grant_expired");
    assert.equal(invoked, false);
  } finally { await database.close(); }
});
