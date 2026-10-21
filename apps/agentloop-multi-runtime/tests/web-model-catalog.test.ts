import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createModelCatalog } from "../web/client/state/model-catalog.js";

test("execution context changes invalidate selections immediately and discard late catalog responses", async () => {
  const cloud = { key: "user:cloud", local: false };
  const local = { key: "user:device", local: true };
  const requests: Array<(models: Array<{ key: string }>) => void> = [];
  let state: { models: readonly { key: string }[]; loading: boolean };
  const catalog = createModelCatalog({
    fetchModels: () => new Promise<Array<{ key: string }>>((resolve) => requests.push(resolve)),
    onChange: (value) => { state = value; },
  });
  const first = catalog.load(cloud);
  await Promise.resolve();
  requests[0]!([{ key: "deepseek-v4-flash-2" }]);
  await first;
  assert.equal(catalog.accepts(cloud, "deepseek-v4-flash-2"), true);

  const oldRefresh = catalog.load(cloud, { force: true });
  await Promise.resolve();
  const localLoad = catalog.load(local);
  assert.deepEqual(state!.models, []);
  assert.equal(catalog.accepts(local, "deepseek-v4-flash-2"), false);
  assert.equal(catalog.accepts(cloud, "deepseek-v4-flash-2"), false);
  await Promise.resolve();
  requests[2]!([{ key: "cloud:deepseek-v4-flash-2" }]);
  await localLoad;
  requests[1]!([{ key: "deepseek-v4-flash-2" }]);
  await oldRefresh;
  assert.deepEqual(state!.models, [{ key: "cloud:deepseek-v4-flash-2" }]);
  assert.equal(catalog.accepts(local, "cloud:deepseek-v4-flash-2"), true);
});

test("failed refresh removes the previously accepted catalog", async () => {
  let fail = false;
  const context = { key: "local", local: true };
  const catalog = createModelCatalog({
    async fetchModels() {
      if (fail) throw new Error("offline");
      return [{ key: "local:fast" }];
    },
    onChange() {},
  });
  await catalog.load(context);
  assert.equal(catalog.accepts(context, "local:fast"), true);
  fail = true;
  await catalog.load(context, { force: true });
  assert.equal(catalog.accepts(context, "local:fast"), false);
});

test("restoring a local preference synchronizes the catalog after resolving the effective execution location", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function updateLocalControls() {");
  const end = app.indexOf("\nasync function addDirectoryScope()", start);
  const toggle = { checked: false };
  let loadedLocal = false;
  const nodes = new Map<string, object>([["use-local-runtime", toggle]]);
  const sandbox = {
    $: (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { toggleAttribute() {} });
      return nodes.get(id);
    },
    applyConversationRuntimeBinding: () => undefined,
    localRuntimeViewModel: () => ({ paired: true }),
    localRuntimeState: { device: { id: "device" } },
    sessionState: { user: { id: "user" } },
    localRuntimePreferenceKey: () => "user:device",
    loadLocalRuntimePreference: () => true,
    localStorage: {},
    isLocalExecution: () => toggle.checked,
    modelCatalogContext: () => ({ local: toggle.checked }),
    modelCatalog: { load: (context: { local: boolean }) => { loadedLocal = context.local; } },
    syncAgentSettingsView() {}, syncLocalRuntimeManager() {}, renderLocalScopes() {},
  };
  vm.runInNewContext(`${app.slice(start, end)}\nupdateLocalControls();`, sandbox);
  assert.equal(toggle.checked, true);
  assert.equal(loadedLocal, true);
});
