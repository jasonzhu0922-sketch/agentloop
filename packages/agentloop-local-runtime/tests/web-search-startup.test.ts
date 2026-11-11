import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { createLocalRuntimeManager, EncryptedLocalRuntimeSecretStore } from "@zhujun/agentloop-local-runtime";
import { LocalRuntimeFactory } from "@zhujun/agentloop-local-runtime/host";
import { modelPort } from "./fixtures/models.ts";

for (const missing of ["file", "reference", "api-key"] as const) {
  test(`missing search credential ${missing} only disables search across Runtime reopen and repair`, async t => {
    const root = await mkdtemp(join(tmpdir(), "search-startup-"));
    const skills = join(root, "skills"); await mkdir(skills);
    const vault = join(root, "private", "web-search-secrets");
    const secrets = new EncryptedLocalRuntimeSecretStore(vault);
    const options = { dataDirectory: root, defaultRuntimeId: "default", models: modelPort(), bundledSkillDirectories: [skills] };
    let manager = await createLocalRuntimeManager(options);
    t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
    const child = await manager.createRuntime("Second Runtime");
    await manager.configureWebSearch({ enabled: true, searchProvider: "bocha", searchEndpoint: "https://search.example/v1", searchApiKey: "synthetic-search-key" });
    await manager.close();
    const [reference] = await secrets.listKeys(); assert.ok(reference);
    if (missing === "file") await secrets.remove(reference);
    else if (missing === "reference") {
      const database = new DatabaseSync(join(root, "supervisor.db"));
      try { database.exec("UPDATE local_web_search_configuration SET secret_storage_key = NULL"); }
      finally { database.close(); }
    }
    else await secrets.replace(reference, { unrelated: "not-a-search-key" });

    const original = LocalRuntimeFactory.prototype.create;
    const calls: Parameters<typeof original>[1][] = [];
    t.mock.method(LocalRuntimeFactory.prototype, "create", function (...args: Parameters<typeof original>) {
      calls.push(args[1]); return original.apply(this, args);
    });
    // A missing key must never trigger a request or select a public backend.
    t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected_network"); });
    manager = await createLocalRuntimeManager(options);
    assert.deepEqual((await manager.runtimes()).map(runtime => runtime.status), ["ready", "ready"]);
    const unavailable = await manager.webSearchConfiguration();
    assert.deepEqual(unavailable, { enabled: true, searchProvider: "bocha", searchEndpoint: "https://search.example/v1", credentialConfigured: false, unavailableReason: "web_search_credentials_missing" });
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.integrationEnvironment.WEB_SEARCH_DISABLED, "1");
      assert.equal(call.webSearch, undefined);
    }
    for (const id of ["default", child.id]) {
      const runtime = manager.runtime(id);
      assert.deepEqual(await runtime.models(), ["local:test"]);
      const context = { ownerUserId: "owner" };
      let run = await runtime.startRun(context, { input: "你好", modelKey: "local:test" });
      for (let count = 0; count < 200 && run.status === "running"; count++) {
        await setTimeout(10); run = await runtime.getRun(context, run.id);
      }
      assert.equal(run.status, "completed");
    }
    await manager.restartRuntime("default");
    assert.equal((await manager.runtimes())[0]?.status, "ready");
    await assert.rejects(manager.configureWebSearch({ enabled: true, searchProvider: "bocha", searchEndpoint: unavailable.searchEndpoint }), /web_search_api_key_required/);
    const repaired = await manager.configureWebSearch({ enabled: true, searchProvider: "bocha", searchEndpoint: unavailable.searchEndpoint, searchApiKey: "replacement-key" });
    assert.equal(repaired.credentialConfigured, true);
    assert.equal(repaired.unavailableReason, undefined);
    assert.deepEqual((await manager.runtimes()).map(runtime => runtime.status), ["ready", "ready"]);
    for (const call of calls.slice(-2)) {
      assert.equal(call.integrationEnvironment.WEB_SEARCH_DISABLED, "0");
      assert.equal(call.webSearch?.searchApiKey, "replacement-key");
    }
  });
}

test("public search backends remain available without a credential", async t => {
  const root = await mkdtemp(join(tmpdir(), "search-public-"));
  const skills = join(root, "skills"); await mkdir(skills);
  const manager = await createLocalRuntimeManager({ dataDirectory: root, defaultRuntimeId: "default", bundledSkillDirectories: [skills] });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const original = LocalRuntimeFactory.prototype.create;
  const calls: Parameters<typeof original>[1][] = [];
  t.mock.method(LocalRuntimeFactory.prototype, "create", function (...args: Parameters<typeof original>) {
    calls.push(args[1]); return original.apply(this, args);
  });
  for (const searchProvider of ["baidu", "bing"] as const) {
    const config = await manager.configureWebSearch({ enabled: true, searchProvider });
    assert.equal(config.credentialConfigured, false);
    assert.equal(config.unavailableReason, undefined);
    assert.equal(calls.at(-1)?.integrationEnvironment.WEB_SEARCH_DISABLED, "0");
    assert.equal(calls.at(-1)?.webSearch?.searchProvider, searchProvider);
  }
});
