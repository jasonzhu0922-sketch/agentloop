import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CredentialGrant, CredentialGrantRequest, IntegrationInvocationResponse, RuntimeConfigurationSnapshot, RuntimeTarget } from "../control-plane/contracts/index.ts";
import { CloudIntegrationSecretBroker, type IntegrationDeliveryPort } from "../src/runtime-host/application/integrations/integration-secret-broker.ts";

const target: RuntimeTarget = { plane: "cloud", scopeId: "tenant-a", runtimeId: "runtime-a" };
const hash = "b".repeat(64);
const snapshot: RuntimeConfigurationSnapshot = {
  contractVersion: "control-plane/v1", snapshotId: "snapshot-a", configurationRevision: 1, target, resolvedAt: 1_000, validUntil: 10_000,
  integrations: [{ bindingId: "binding-a", releaseId: "release-a", contentHash: hash, integration: "enterprise_info", allowedActions: ["search", "detail"] }], skills: [], policies: [],
};

function context() {
  return { runId: "run-a", planId: "plan-a", stepId: "step-a", skillNames: ["enterprise-info"], command: "python3", args: ["scripts/enterprise_info.py", "--action", "search"], cwd: "@skills/enterprise-info" } as const;
}

function call(socketPath: string, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    let response = "";
    client.setEncoding("utf8");
    client.once("connect", () => { client.end(JSON.stringify(request)); });
    client.on("data", (chunk: string) => { response += chunk; });
    client.once("error", reject);
    client.once("end", () => {
      try { resolve(JSON.parse(response) as Record<string, unknown>); } catch (error) { reject(error); }
    });
  });
}

test("Cloud integration broker grants only the declared enterprise Skill entrypoint and consumes permits once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentloop-integration-broker-"));
  const socketPath = join(directory, "broker.sock");
  const grants: CredentialGrantRequest[] = [];
  const delivery: IntegrationDeliveryPort = {
    requestGrant: async (request) => {
      grants.push(request);
      return { contractVersion: "control-plane/v1", grantId: "grant-a", invocationId: request.invocationId, bindingId: request.bindingId, releaseId: request.releaseId, contentHash: request.contentHash, secretReferenceVersion: "version-a", expiresAt: 2_000 } satisfies CredentialGrant;
    },
    invoke: async (_grant, request, args) => ({
      result: { queries: [{ name: (args.names as string[])[0], action: request.action, result: { items: [] } }] },
      receipt: { contractVersion: "control-plane/v1", receiptId: "receipt-a", invocationId: request.invocationId, bindingId: request.bindingId, releaseId: request.releaseId, contentHash: request.contentHash, secretReferenceVersion: "version-a", status: "completed", observedAt: 1_000 },
    }) satisfies IntegrationInvocationResponse,
  };
  const broker = new CloudIntegrationSecretBroker({ target, snapshot, delivery, socketPath, now: () => 1_000 });
  try {
    await broker.start();
    assert.deepEqual(broker.commandEnvironment({ ...context(), command: "env", args: [] }), {});
    const environment = broker.commandEnvironment(context());
    assert.deepEqual(Object.keys(environment).sort(), ["AGENTLOOP_INTEGRATION_BROKER_SOCKET", "AGENTLOOP_INTEGRATION_PERMIT"]);
    assert.equal(Object.keys(environment).some((name) => /SECRET|TOKEN|KEY/.test(name)), false);
    const response = await call(socketPath, { permit: environment.AGENTLOOP_INTEGRATION_PERMIT, action: "search", args: { names: ["Example Co"] } });
    assert.equal(response.ok, true);
    assert.deepEqual(grants, [{ contractVersion: "control-plane/v1", invocationId: grants[0]?.invocationId, runId: "run-a", planId: "plan-a", stepId: "step-a", integration: "enterprise_info", action: "search", bindingId: "binding-a", releaseId: "release-a", contentHash: hash, skillNames: ["enterprise-info"], requestedAt: 1_000 }]);
    assert.doesNotMatch(JSON.stringify(response), /client[_-]?secret|access[_-]?token/i);
    const reused = await call(socketPath, { permit: environment.AGENTLOOP_INTEGRATION_PERMIT, action: "search", args: {} });
    assert.deepEqual(reused, { ok: false, code: "integration_not_authorized" });
    const unauthorized = broker.commandEnvironment(context());
    const action = await call(socketPath, { permit: unauthorized.AGENTLOOP_INTEGRATION_PERMIT, action: "delete", args: {} });
    assert.deepEqual(action, { ok: false, code: "integration_not_authorized" });
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Cloud integration broker maps expired grants to their stable failure code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentloop-integration-broker-"));
  const socketPath = join(directory, "broker.sock");
  const delivery: IntegrationDeliveryPort = {
    requestGrant: async (request) => ({ contractVersion: "control-plane/v1", grantId: "grant-a", invocationId: request.invocationId, bindingId: request.bindingId, releaseId: request.releaseId, contentHash: request.contentHash, secretReferenceVersion: "version-a", expiresAt: 1_000 }),
    invoke: async () => { throw new Error("must not invoke an expired grant"); },
  };
  const broker = new CloudIntegrationSecretBroker({ target, snapshot, delivery, socketPath, now: () => 1_000 });
  try {
    await broker.start();
    const environment = broker.commandEnvironment(context());
    const response = await call(socketPath, { permit: environment.AGENTLOOP_INTEGRATION_PERMIT, action: "search", args: {} });
    assert.deepEqual(response, { ok: false, code: "credential_grant_expired" });
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
