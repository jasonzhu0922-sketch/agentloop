import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { EncryptedLocalRuntimeSecretStore } from "../local-agent-runtime/src/persistence/encrypted-local-runtime-secret-store.ts";
import { LocalConnectorConfigurationStore } from "../local-agent-runtime/src/persistence/local-connector-configuration-store.ts";
import { LocalRuntimeConfigurationStore } from "../local-agent-runtime/src/persistence/local-runtime-configuration-store.ts";

test("repeated startup preserves Connector secrets across all Runtimes while pruning actual orphans", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-shared-secret-restart-"));
  const database = new AppDatabase(join(root, "supervisor.db"));
  try {
    const vault = new EncryptedLocalRuntimeSecretStore(join(root, "secrets"));
    const connectors = new LocalConnectorConfigurationStore(database, vault);
    await connectors.ready();
    for (const [runtimeId, enabled] of [["runtime-a", true], ["runtime-b", false]] as const) {
      await connectors.upsert(runtimeId, { connectorKey: "arbitrary-provider", displayName: "Fixture", modulePath: "/fixture.ts", enabled, credentials: { token: `${runtimeId}-fixture` } });
    }
    const references = await connectors.secretStorageKeys();
    const orphan = await vault.write({ token: "uncommitted-fixture" });
    for (let restart = 0; restart < 2; restart++) {
      const reopenedVault = new EncryptedLocalRuntimeSecretStore(join(root, "secrets"));
      const runtimeStore = new LocalRuntimeConfigurationStore(database, reopenedVault, [], undefined, undefined,
        () => connectors.secretStorageKeys());
      await runtimeStore.ready();
      for (const key of references) assert.ok(await reopenedVault.read(key));
      assert.equal(await reopenedVault.read(orphan), undefined);
      assert.equal((await connectors.list("runtime-a"))[0]?.credentialConfigured, true);
      assert.equal((await connectors.list("runtime-b"))[0]?.credentialConfigured, true);
    }
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("failed reference enumeration aborts shared-vault pruning", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-shared-secret-fail-closed-"));
  const database = new AppDatabase(":memory:");
  try {
    const vault = new EncryptedLocalRuntimeSecretStore(join(root, "secrets"));
    const retained = await vault.write({ token: "fixture" });
    const store = new LocalRuntimeConfigurationStore(database, vault, [], undefined, undefined,
      async () => { throw new Error("reference lookup failed"); });
    await assert.rejects(store.ready(), /reference lookup failed/);
    assert.deepEqual(await vault.read(retained), { token: "fixture" });
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("Connector settings report a missing secret as unconfigured instead of trusting its stale database reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-missing-connector-secret-"));
  const database = new AppDatabase(":memory:");
  try {
    const vault = new EncryptedLocalRuntimeSecretStore(join(root, "secrets"));
    const store = new LocalConnectorConfigurationStore(database, vault);
    await store.ready();
    const saved = await store.upsert("runtime", { connectorKey: "fixture", displayName: "Fixture", modulePath: "/fixture.ts", credentials: { token: "fixture" } });
    assert.equal(saved.credentialConfigured, true);
    for (const key of await store.secretStorageKeys()) await vault.remove(key);
    assert.equal((await store.get("runtime", saved.id)).credentialConfigured, false);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("deleting a Connector instance removes only its configuration and encrypted credential within its Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-delete-connector-"));
  const database = new AppDatabase(join(root, "supervisor.db"));
  try {
    const vault = new EncryptedLocalRuntimeSecretStore(join(root, "secrets"));
    const store = new LocalConnectorConfigurationStore(database, vault);
    await store.ready();
    const input = { connectorKey: "unseen-provider", displayName: "Fixture", modulePath: "/fixture.ts", credentials: { token: "fixture" } };
    const target = await store.upsert("runtime-a", input);
    const [targetKey] = await store.secretStorageKeys();
    const otherRuntime = await store.upsert("runtime-b", input);
    const otherProvider = await store.upsert("runtime-a", { ...input, connectorKey: "other-provider" });
    await assert.rejects(store.remove("runtime-b", target.id), /local_connector_not_found/);
    assert.ok(await vault.read(targetKey!));
    await store.remove("runtime-a", target.id);
    assert.equal(await vault.read(targetKey!), undefined);
    assert.deepEqual((await store.list("runtime-a")).map((item) => item.id), [otherProvider.id]);
    assert.equal((await store.get("runtime-b", otherRuntime.id)).credentialConfigured, true);
    assert.equal((await store.get("runtime-a", otherProvider.id)).credentialConfigured, true);
    const reopened = new LocalConnectorConfigurationStore(database, new EncryptedLocalRuntimeSecretStore(join(root, "secrets")));
    await reopened.ready();
    await assert.rejects(reopened.get("runtime-a", target.id), /local_connector_not_found/);
    assert.equal((await reopened.resolve("runtime-a")).connections.length, 1);
    assert.equal((await reopened.secretStorageKeys()).length, 2);
    const rebound = await reopened.upsert("runtime-a", input);
    assert.notEqual(rebound.id, target.id);
    assert.equal(rebound.credentialConfigured, true);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
