import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
