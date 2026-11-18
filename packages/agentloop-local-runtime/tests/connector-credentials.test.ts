import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createLocalRuntimeManager, EncryptedLocalRuntimeSecretStore } from "@zhujun/agentloop-local-runtime";
import { greetingModel, modelPort } from "./fixtures/models.ts";

test("a lost Connector credential is reported truthfully and its Run failure retains the actionable reason", async t => {
  const root = await mkdtemp(join(tmpdir(), "connector-credentials-"));
  const skills = join(root, "skills");
  await mkdir(skills);
  const secrets = new EncryptedLocalRuntimeSecretStore(join(root, "private", "connector-secrets"));
  let modelCalls = 0;
  const manager = await createLocalRuntimeManager({
    dataDirectory: root, defaultRuntimeId: "default", models: modelPort(greetingModel(() => { modelCalls++; })),
    bundledSkillDirectories: [skills], connectorSecrets: secrets,
    connectorModules: [{
      modulePath: join(dirname(fileURLToPath(import.meta.url)), "../../connector-126-mail/src/index.ts"),
      exportName: "createConfigured126MailConnector",
    }],
  });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected_network"); });
  const input = {
    connectorKey: "126-mail", displayName: "My mailbox", enabled: true,
    scopes: ["email:search", "email:read"], credentials: { username: "test@example.test", password: "synthetic-secret" },
  };
  const saved = await manager.configureConnector("alice", input);
  const id = saved.connector.id;
  assert.equal(saved.connector.credentialConfigured, true);
  const [reference] = await secrets.listKeys();
  assert.ok(reference);
  await secrets.remove(reference);

  assert.equal((await manager.connectors("alice"))[0]!.credentialConfigured, false,
    "a dangling secret reference does not mean credentials are configured");
  assert.deepEqual(await manager.connectors("bob"), []);
  await manager.restartRuntime("default");
  const runtime = manager.runtime("default");
  const started = await runtime.startRun({ ownerUserId: "alice" }, {
    requestId: "missing-credentials", input: "整理我这周收到的邮件", modelKey: "local:test",
    connectorConnectionIds: [id],
  });
  let run = started;
  for (let attempt = 0; attempt < 300 && run.status === "running"; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    run = await runtime.getRun({ ownerUserId: "alice" }, run.id);
  }
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "CAPABILITY_UNAVAILABLE");
  const events = await runtime.events({ ownerUserId: "alice" }, run.id);
  const failed = events.find(event => event.type === "run.failed");
  assert.equal(failed?.data.code, "CAPABILITY_UNAVAILABLE");
  assert.match(String(failed?.data.message), /重新填写/);
  assert.deepEqual(failed?.data.details, {
    reasonCode: "connector_credentials_missing", connectionId: id, connectorKey: "126-mail",
  });
  assert.equal(modelCalls, 0, "missing credentials must be diagnosed before any model request");
  assert.equal(JSON.stringify(events).includes("synthetic-secret"), false);
  assert.equal(JSON.stringify(events).includes(reference), false);

  const repaired = await manager.configureConnector("alice", { ...input, id });
  assert.equal(repaired.connector.id, id);
  assert.equal(repaired.connector.credentialConfigured, true);
  assert.equal((await manager.connectors("alice"))[0]!.credentialConfigured, true);
  const resumed = await runtime.startRun({ ownerUserId: "alice" }, {
    requestId: "credentials-restored", input: "你好", modelKey: "local:test", connectorConnectionIds: [id],
  });
  let completed = resumed;
  for (let attempt = 0; attempt < 300 && completed.status === "running"; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    completed = await runtime.getRun({ ownerUserId: "alice" }, resumed.id);
  }
  assert.equal(completed.status, "completed", "saving credentials restores tool materialization on the same Connection");
  assert.ok(modelCalls > 0);
});

for (const damage of ["missing-key", "invalid-key", "wrong-key", "invalid-document"] as const) {
  test(`Connector metadata and ordinary Runs survive ${damage}; selected Runs fail before the model`, async t => {
    const root = await mkdtemp(join(tmpdir(), "connector-vault-damage-"));
    const skills = join(root, "skills"); await mkdir(skills);
    const vault = join(root, "private", "connector-secrets");
    let modelCalls = 0;
    const options = {
      dataDirectory: root, defaultRuntimeId: "default", models: modelPort(greetingModel(() => { modelCalls++; })),
      bundledSkillDirectories: [skills],
      connectorModules: [{ modulePath: join(dirname(fileURLToPath(import.meta.url)), "../../connector-126-mail/src/index.ts"), exportName: "createConfigured126MailConnector" }],
    };
    let secrets = new EncryptedLocalRuntimeSecretStore(vault);
    let manager = await createLocalRuntimeManager({ ...options, connectorSecrets: secrets });
    t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
    t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected_network"); });
    const input = { connectorKey: "126-mail", displayName: "Mailbox", enabled: true, scopes: ["email:read"], credentials: { username: "test@example.test", password: "synthetic-secret" } };
    const { connector } = await manager.configureConnector("alice", input);
    const [reference] = await secrets.listKeys();
    const keyPath = join(vault, "master.key"), secretPath = join(vault, `${reference}.json`);
    const originalKey = await readFile(keyPath), originalSecret = await readFile(secretPath);
    await manager.close();
    if (damage === "missing-key") await rm(keyPath);
    else if (damage === "invalid-key") await writeFile(keyPath, Buffer.alloc(3));
    else if (damage === "wrong-key") await writeFile(keyPath, randomBytes(32));
    else await writeFile(secretPath, "{broken-json");
    secrets = new EncryptedLocalRuntimeSecretStore(vault);
    manager = await createLocalRuntimeManager({ ...options, connectorSecrets: secrets });
    const expected = damage === "missing-key" ? "connector_credential_key_missing" : "connector_credentials_unreadable";
    const [listed] = await manager.connectors("alice");
    assert.equal(listed!.id, connector.id);
    assert.equal(listed!.credentialConfigured, false);
    assert.equal(listed!.unavailableReason, expected);
    assert.equal(listed!.moduleAvailable, true);
    assert.ok((await manager.connectorCatalog()).length);
    assert.deepEqual(await manager.connectors("bob"), []);
    if (damage === "missing-key" || damage === "invalid-key") {
      const files = await readdir(vault);
      await assert.rejects(manager.configureConnector("alice", { ...input, id: connector.id, displayName: "must-not-save" }), error => (error as Error).message === expected);
      assert.deepEqual(await readdir(vault), files, "failed writes must preserve the vault and must not create a replacement key");
      assert.deepEqual(await readFile(secretPath), originalSecret);
      assert.equal((await manager.connectors("alice"))[0]!.displayName, "Mailbox");
    }
    await manager.restartRuntime("default");
    const runtime = manager.runtime("default");
    let run = await runtime.startRun({ ownerUserId: "alice" }, { requestId: damage, input: "读取邮件", modelKey: "local:test", connectorConnectionIds: [connector.id] });
    for (let count = 0; count < 300 && run.status === "running"; count++) {
      await new Promise(resolve => setTimeout(resolve, 10)); run = await runtime.getRun({ ownerUserId: "alice" }, run.id);
    }
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "CAPABILITY_UNAVAILABLE");
    const events = await runtime.events({ ownerUserId: "alice" }, run.id);
    assert.deepEqual(events.find(e => e.type === "run.failed")?.data.details, { reasonCode: expected, connectionId: connector.id, connectorKey: "126-mail" });
    assert.equal(modelCalls, 0);
    assert.doesNotMatch(JSON.stringify(events), /synthetic-secret|local_secret_/);
    let ordinary = await runtime.startRun({ ownerUserId: "alice" }, { requestId: `${damage}-ordinary`, input: "你好", modelKey: "local:test", connectorConnectionIds: [] });
    for (let count = 0; count < 300 && ordinary.status === "running"; count++) {
      await new Promise(resolve => setTimeout(resolve, 10)); ordinary = await runtime.getRun({ ownerUserId: "alice" }, ordinary.id);
    }
    assert.equal(ordinary.status, "completed");
    await manager.close();
    await writeFile(keyPath, originalKey); await writeFile(secretPath, originalSecret);
    secrets = new EncryptedLocalRuntimeSecretStore(vault);
    manager = await createLocalRuntimeManager({ ...options, connectorSecrets: secrets });
    const [restored] = await manager.connectors("alice");
    assert.equal(restored!.id, connector.id); assert.equal(restored!.credentialConfigured, true); assert.equal(restored!.unavailableReason, undefined);
    assert.equal((await secrets.read(reference!))?.username, input.credentials.username);
  });
}

test("unexpected credential storage I/O errors remain errors", async t => {
  const root = await mkdtemp(join(tmpdir(), "connector-io-"));
  const skills = join(root, "skills"); await mkdir(skills);
  const secrets = new EncryptedLocalRuntimeSecretStore(join(root, "vault"));
  const manager = await createLocalRuntimeManager({ dataDirectory: root, defaultRuntimeId: "default", models: modelPort(), bundledSkillDirectories: [skills], connectorSecrets: secrets,
    connectorModules: [{ modulePath: join(dirname(fileURLToPath(import.meta.url)), "../../connector-126-mail/src/index.ts"), exportName: "createConfigured126MailConnector" }] });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  await manager.configureConnector("alice", { connectorKey: "126-mail", displayName: "Mailbox", enabled: true, scopes: [], credentials: { password: "fixture" } });
  const ioError = Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
  t.mock.method(secrets, "read", async () => { throw ioError; });
  await assert.rejects(manager.connectors("alice"), error => error === ioError);
});
