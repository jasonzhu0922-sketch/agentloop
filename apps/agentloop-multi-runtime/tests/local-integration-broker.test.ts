import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CredentialGrantRequest, RuntimeConfigurationSnapshot, RuntimeTarget } from "../control-plane/contracts/index.ts";
import { LocalIntegrationBroker, type LocalIntegrationDeliveryPort } from "../local-agent-runtime/src/control-plane/local-integration-broker.ts";
import { LocalSecureEnvelopeStore } from "../local-agent-runtime/src/control-plane/local-secure-envelope-store.ts";

const target: RuntimeTarget = { plane: "local", scopeId: "tenant-a", runtimeId: "runtime-a", deviceId: "device-a" };
const hash = "c".repeat(64);
const snapshot: RuntimeConfigurationSnapshot = { contractVersion: "control-plane/v1", snapshotId: "snapshot-a", configurationRevision: 1, target, resolvedAt: 1_000, validUntil: 5_000, integrations: [{ bindingId: "binding-a", releaseId: "release-a", contentHash: hash, integration: "enterprise_info", allowedActions: ["search"] }], skills: [], policies: [] };
function call(path: string, payload: unknown): Promise<Record<string, unknown>> { return new Promise((resolve, reject) => { const client = createConnection(path); let result = ""; client.setEncoding("utf8"); client.once("connect", () => client.end(JSON.stringify(payload))); client.on("data", (part: string) => { result += part; }); client.once("error", reject); client.once("end", () => { try { resolve(JSON.parse(result) as Record<string, unknown>); } catch (error) { reject(error); } }); }); }

test("Local broker binds an envelope to its device secure store and never exposes it to the child protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-broker-"));
  const socketPath = join(root, "broker.sock");
  let invocation: CredentialGrantRequest | undefined;
  const delivery: LocalIntegrationDeliveryPort = {
    requestGrant: async (request) => { invocation = request; return { contractVersion: "control-plane/v1", grantId: "grant-a", invocationId: request.invocationId, bindingId: request.bindingId, releaseId: request.releaseId, contentHash: request.contentHash, secretReferenceVersion: "local-version-a", expiresAt: 2_000 }; },
    requestEnvelope: async (grant) => ({ contractVersion: "control-plane/v1", envelopeId: "envelope-a", grantId: grant.grantId, deviceId: "device-a", bindingId: "binding-a", releaseId: "release-a", contentHash: hash, secretReferenceVersion: "local-version-a", encryptedPayload: "device-only-opaque-envelope", expiresAt: 2_000 }),
    invoke: async () => ({ result: { queries: [{ name: "Example Co", action: "search", result: { items: [] } }] }, receipt: { contractVersion: "control-plane/v1", receiptId: "receipt-a", invocationId: invocation!.invocationId, bindingId: "binding-a", releaseId: "release-a", contentHash: hash, secretReferenceVersion: "local-version-a", status: "completed", observedAt: 1_000 } }),
  };
  const store = new LocalSecureEnvelopeStore(join(root, "envelope.json"), "device-private-key-material");
  const broker = new LocalIntegrationBroker({ target, snapshot, delivery, secureStore: store, socketPath, now: () => 1_000 });
  try {
    await broker.start();
    const environment = broker.commandEnvironment({ runId: "run-a", skillNames: ["enterprise-info"], command: "python3", args: ["scripts/enterprise_info.py"], cwd: "@skills/enterprise-info" });
    assert.deepEqual(Object.keys(environment).sort(), ["AGENTLOOP_INTEGRATION_BROKER_SOCKET", "AGENTLOOP_INTEGRATION_PERMIT"]);
    const response = await call(socketPath, { permit: environment.AGENTLOOP_INTEGRATION_PERMIT, action: "search", args: { names: ["Example Co"] } });
    assert.equal(response.ok, true);
    assert.doesNotMatch(JSON.stringify(response), /device-only-opaque-envelope/);
    assert.equal((await store.get("envelope-a", "device-a", () => 1_000))?.grantId, "grant-a");
    assert.equal(invocation?.integration, "enterprise_info");
    const reused = await call(socketPath, { permit: environment.AGENTLOOP_INTEGRATION_PERMIT, action: "search", args: {} });
    assert.deepEqual(reused, { ok: false, code: "integration_not_authorized" });
  } finally { await broker.close(); await rm(root, { recursive: true, force: true }); }
});
