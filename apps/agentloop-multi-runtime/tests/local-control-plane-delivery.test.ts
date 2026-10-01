import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DeviceCredentialEnvelope, RuntimeConfigurationSnapshot, RuntimeTarget } from "../control-plane/contracts/index.ts";
import { LocalDeliveryClient, LocalDeliveryError } from "../local-agent-runtime/src/control-plane/local-delivery-client.ts";
import { LocalSecureEnvelopeStore } from "../local-agent-runtime/src/control-plane/local-secure-envelope-store.ts";
import { LocalSnapshotCache } from "../local-agent-runtime/src/control-plane/local-snapshot-cache.ts";

const target: RuntimeTarget = { plane: "local", scopeId: "tenant-a", runtimeId: "runtime-a", deviceId: "device-a" };
const snapshot: RuntimeConfigurationSnapshot = { contractVersion: "control-plane/v1", snapshotId: "snapshot-a", configurationRevision: 1, target, resolvedAt: 1_000, validUntil: 2_000, integrations: [], skills: [], policies: [] };

test("Local delivery derives device target from client identity and records no caller target", async () => {
  const requests: Request[] = [];
  const client = new LocalDeliveryClient({ deliveryUrl: "https://delivery.example.test", deviceToken: "device-session", target, now: () => 1_100, request: async (input, init) => { requests.push(new Request(input, init)); return new Response(JSON.stringify(snapshot), { status: 200 }); } });
  assert.deepEqual(await client.desiredSnapshot(), snapshot);
  assert.equal(new URL(requests[0]!.url).search, "");
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer device-session");
  const rejected = new LocalDeliveryClient({ deliveryUrl: "https://delivery.example.test", deviceToken: "device-session", target, request: async () => new Response("", { status: 403 }) });
  await assert.rejects(() => rejected.desiredSnapshot(), (error: unknown) => error instanceof LocalDeliveryError && error.code === "target_not_authorized");
  await assert.rejects(() => rejected.reportLoaded({ ...snapshot, integrations: [{ bindingId: "binding-a", releaseId: "release-a", contentHash: "a".repeat(64) }] }, () => "receipt-a"), (error: unknown) => error instanceof LocalDeliveryError && error.code === "target_not_authorized");
});

test("Local cache obeys validUntil and secure envelope storage never writes its opaque payload in plaintext", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-control-plane-"));
  try {
    const cache = new LocalSnapshotCache(join(root, "cache.json"));
    await cache.put(snapshot);
    assert.equal((await cache.get(target, () => 1_999))?.snapshotId, "snapshot-a");
    assert.equal(await cache.get(target, () => 2_000), undefined);
    const envelope: DeviceCredentialEnvelope = { contractVersion: "control-plane/v1", envelopeId: "envelope-a", grantId: "grant-a", deviceId: "device-a", bindingId: "binding-a", releaseId: "release-a", contentHash: "a".repeat(64), secretReferenceVersion: "version-a", encryptedPayload: "opaque-device-only-envelope", expiresAt: 2_000 };
    const store = new LocalSecureEnvelopeStore(join(root, "secure-envelope.json"), "device-private-key-material");
    await store.put(envelope);
    assert.doesNotMatch(await readFile(join(root, "secure-envelope.json"), "utf8"), /opaque-device-only-envelope/);
    assert.deepEqual(await store.get("envelope-a", "device-a", () => 1_999), envelope);
    assert.equal(await store.get("envelope-a", "device-a", () => 2_000), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
