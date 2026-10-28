import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createLocalRuntimeState } from "../web/client/local-runtime/local-runtime-state.js";

test("local runtime state keeps device, Runtime, scope, and Agent lifecycle together", () => {
  const state = createLocalRuntimeState();
  state.device = { id: "device-1" };
  state.runtimeId = "runtime-1";
  state.runtimes = [{ id: "runtime-1", status: "ready" }];
  state.lifecycleOperations = { "runtime-1": { message: "正在启动…", tone: "running", pending: true } };
  state.scopes = [{ id: "scope-1", status: "active" }];
  state.agentStatus = "online";
  state.agentHealth = { registered: true };
  state.hydratedPreferenceKey = "user-1:device-1";
  state.clear();
  assert.equal(state.device, undefined);
  assert.equal(state.runtimeId, "");
  assert.deepEqual(state.runtimes, []);
  assert.deepEqual(state.lifecycleOperations, {});
  assert.deepEqual(state.scopes, []);
  assert.equal(state.agentStatus, "checking");
  assert.equal(state.agentHealth, undefined);
  assert.equal(state.hydratedPreferenceKey, "");
});

test("browser does not report a failed Local Agent health probe as uninstalled", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  assert.match(app, /catch \{\s+localRuntimeState\.agentHealth = undefined;\s+localRuntimeState\.agentStatus = "unreachable";/);
  assert.match(app, /unreachable: \["无法访问 · 重试"/);
  assert.doesNotMatch(app, /agentStatus = localStorage\.getItem\("agentloop\.local-agent-seen\.v1"\)/);
});

test("browser keeps Agent reconnect and Runtime lifecycle on the loopback service", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  assert.match(app, /localAgentFetch\("\/v1\/agent\/reconnect", \{ method: "POST" \}\)/);
  assert.match(app, /localAgentFetch\("\/v1\/local-runtimes"\)/);
  assert.match(app, /localAgentFetch\(`\/v1\/local-runtimes\/\$\{encodeURIComponent\(runtimeId\)\}\/\$\{action\}`/);
  assert.doesNotMatch(app, /routerClient\.request\(localAgentRouterPath\("\/runtimes"\)\)/);
});

test("browser keeps Agent settings and Runtime deletion on the loopback service", async () => {
  const [app, api] = await Promise.all([
    readFile(new URL("../web/client/app.js", import.meta.url), "utf8"),
    readFile(new URL("../local-agent-runtime/src/api/local-agent-api.ts", import.meta.url), "utf8"),
  ]);
  assert.match(app, /localAgentFetch\(`\/v1\/local-runtimes\/\$\{encodeURIComponent\(runtime\.id\)\}`, \{ method: "DELETE" \}\)/);
  assert.match(app, /localAgentFetch\("\/v1\/agent\/config"\)/);
  assert.match(app, /localAgentFetch\("\/v1\/agent\/config\/shared-storage\/pick", \{ method: "POST" \}\)/);
  assert.match(app, /localAgentFetch\("\/v1\/agent\/config\/upload-storage\/pick", \{ method: "POST" \}\)/);
  assert.doesNotMatch(app, /routerClient\.(request|postJson)\(localAgentRouterPath\("\/(?:config|config\/shared-storage\/pick|config\/upload-storage\/pick)"\)/);
  assert.match(api, /url\.pathname === "\/v1\/agent\/config"/);
  assert.match(api, /url\.pathname === "\/v1\/agent\/config\/shared-storage\/pick"/);
  assert.match(api, /url\.pathname === "\/v1\/agent\/config\/upload-storage\/pick"/);
  assert.match(api, /request\.method === "DELETE" && runtimeDelete !== null/);
  assert.match(api, /\(start\|stop\|drain\|restart\)/);
});

test("settings preserve the active tab across Agent refreshes and reopen on models", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  const sourceBetween = (start: string, end: string) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
  const elements = new Map<string, { hidden: boolean; checked: boolean; toggleAttribute(): void }>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { hidden: true, checked: false, toggleAttribute() {} });
    return elements.get(id)!;
  };
  let selectedTab = "models";
  const buttons = ["models", "skills", "general", "runtimes"].map((view) => ({
    dataset: { agentSettingsView: view },
    classList: { toggle(_name: string, active: boolean) { if (active) selectedTab = view; } },
  }));
  const state = { agentStatus: "online", device: {}, runtimes: [] };
  const controls = runInNewContext(`
    let activeAgentSettingsView = "models";
    ${sourceBetween("function updateLocalControls()", "async function addDirectoryScope()")}
    ${sourceBetween("async function openLocalAgentSettings()", "const localModelSettings")}
    ${sourceBetween("function activateAgentSettingsView(view)", "function closeLocalAgentSettings()")}
    ({ activateAgentSettingsView, updateLocalControls, openLocalAgentSettings })
  `, {
    $: element, document: { querySelectorAll: () => buttons },
    localRuntimeState: state, sessionState: { localSessionToken: "session" },
    applyConversationRuntimeBinding: () => undefined, isLocalExecution: () => false,
    localRuntimeViewModel: () => ({ paired: state.agentStatus === "online", runtimeManagerHidden: state.agentStatus !== "online" }),
    localRuntimePreferenceKey: () => "", localStorage: {},
    modelCatalog: { load() {} }, modelCatalogContext: () => ({}),
    syncModelSelection() {},
    syncLocalRuntimeManager() {}, renderLocalScopes() {}, renderLocalAgentConfig() {},
    loadLocalAgentConfig() {}, loadLocalRuntimes() {}, loadLocalModelConfiguration() {}, loadLocalSkillPackages() {},
  });

  for (const view of ["models", "skills", "general", "runtimes"]) {
    controls.activateAgentSettingsView(view);
    controls.updateLocalControls();
    assert.equal(selectedTab, view);
    assert.equal(element("agent-model-settings").hidden, view !== "models");
    assert.equal(element("agent-skill-settings").hidden, view !== "skills");
    assert.equal(element("agent-general-settings").hidden, view !== "general");
    assert.equal(element("local-runtime-manager").hidden, view !== "runtimes");
  }
  state.agentStatus = "unreachable";
  controls.updateLocalControls();
  assert.equal(element("local-runtime-manager").hidden, true);
  state.agentStatus = "online";
  controls.updateLocalControls();
  assert.equal(element("local-runtime-manager").hidden, false);
  await controls.openLocalAgentSettings();
  controls.updateLocalControls();
  assert.equal(selectedTab, "models");
  assert.equal(element("agent-settings-modal").hidden, false);
  assert.equal(element("agent-model-settings").hidden, false);
  assert.equal(element("local-runtime-manager").hidden, true);
});
