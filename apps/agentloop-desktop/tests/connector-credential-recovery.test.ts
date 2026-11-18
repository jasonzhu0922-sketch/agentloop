import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { accountDataDirectory } from "../src/accounts/account-managers.ts";
import { startDesktop } from "../src/application.ts";
import { builtinConnectorModules } from "../src/connectors/builtin-connector-modules.ts";
import { fixtureAuth, TEST_OWNER } from "./fixtures/auth.ts";
import { modelPort } from "../../../packages/agentloop-local-runtime/tests/fixtures/models.ts";

test("Desktop retains built-in Connectors and readable account metadata after losing the credential master key", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-connector-key-"));
  const skills = join(root, "skills"); await mkdir(skills);
  const dataDirectory = join(root, "data");
  const options = { mode: "development" as const, port: 0, dataDirectory, models: modelPort(), cloudAuth: fixtureAuth(), bundledSkillDirectories: [skills], connectorModules: builtinConnectorModules(), openBrowser: false };
  let app = await startDesktop(options); assert.equal(app.existing, false);
  t.after(async () => { if (!app.existing) await app.close(); await rm(root, { recursive: true, force: true }); });
  async function login() {
    const result = await fetch(`${app.origin}/api/auth/login`, { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "test@example.test", password: "fixture-only" }) });
    assert.equal(result.status, 200);
    const cookie = result.headers.get("set-cookie")!.split(";")[0]!;
    const { csrfToken } = await result.json();
    return async (path: string, body?: unknown, status = 200) => {
      const response = await fetch(`${app.origin}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: app.origin, "X-Desktop-CSRF": csrfToken, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.equal(response.status, status, `${path}: ${await response.clone().text()}`);
      return response.json();
    };
  }
  let call = await login();
  const input = { connectorKey: "126-mail", displayName: "测试邮箱", enabled: true, scopes: ["email:read"], credentials: { username: "test@example.test", password: "synthetic-only-secret" } };
  const { connector } = await call("/api/connectors", { connector: input });
  await app.close();
  const vault = join(accountDataDirectory(dataDirectory, TEST_OWNER), "private", "connector-secrets");
  const keyPath = join(vault, "master.key");
  const originalKey = await readFile(keyPath);
  await rm(keyPath);
  const files = await readdir(vault);
  app = await startDesktop(options); assert.equal(app.existing, false);
  call = await login();
  const catalog = await call("/api/connectors/catalog");
  assert.deepEqual(catalog.connectors.map((c: { key: string }) => c.key).sort(), ["126-mail", "feishu", "kingsoft-wps"]);
  const { connections } = await call("/api/connectors");
  assert.equal(connections.length, 1); assert.equal(connections[0].id, connector.id);
  assert.equal(connections[0].moduleAvailable, true); assert.equal(connections[0].credentialConfigured, false);
  assert.equal(connections[0].unavailableReason, "connector_credential_key_missing");
  assert.doesNotMatch(JSON.stringify(connections), /synthetic-only-secret|local_secret_/);
  const rejected = await call("/api/connectors", { connector: { ...input, id: connector.id } }, 409);
  assert.equal(rejected.error, "connector_credential_key_missing");
  assert.deepEqual(await readdir(vault), files);
  assert.equal((await call("/api/runtimes")).runtimes[0].status, "ready");
  assert.deepEqual(await call("/api/models"), { models: ["local:test"] });
  let { run } = await call("/api/runs", { requestId: "unaffected-chat", input: "你好", modelKey: "local:test", connectorConnectionIds: [] });
  for (let count = 0; count < 300 && run.status === "running"; count++) {
    await new Promise(resolve => setTimeout(resolve, 10)); ({ run } = await call(`/api/runs/${run.id}`));
  }
  assert.equal(run.status, "completed");
  const asset = await fetch(`${app.origin}/connector-status.js`);
  assert.equal(asset.status, 200); assert.match(await asset.text(), /connector_credential_key_missing/);
  await app.close();
  await writeFile(keyPath, originalKey);
  app = await startDesktop(options); assert.equal(app.existing, false);
  call = await login();
  const repaired = (await call("/api/connectors")).connections[0];
  assert.equal(repaired.id, connector.id); assert.equal(repaired.credentialConfigured, true); assert.equal(repaired.unavailableReason, undefined);
});
