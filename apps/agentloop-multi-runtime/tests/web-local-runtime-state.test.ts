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
  state.deviceAccessChecked = true;
  state.hydratedPreferenceKey = "user-1:device-1";
  state.clear();
  assert.equal(state.device, undefined);
  assert.equal(state.runtimeId, "");
  assert.deepEqual(state.runtimes, []);
  assert.deepEqual(state.lifecycleOperations, {});
  assert.deepEqual(state.scopes, []);
  assert.equal(state.agentStatus, "checking");
  assert.equal(state.agentHealth, undefined);
  assert.equal(state.deviceAccessChecked, false);
  assert.equal(state.hydratedPreferenceKey, "");
});

test("browser does not report a failed Local Agent health probe as uninstalled", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  assert.match(app, /catch \{\s+localRuntimeState\.agentHealth = undefined;\s+localRuntimeState\.agentStatus = "unreachable";/);
  assert.match(app, /unreachable: \["无法访问 · 重试"/);
  assert.doesNotMatch(app, /agentStatus = localStorage\.getItem\("agentloop\.local-agent-seen\.v1"\)/);
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
  const state = { agentStatus: "online", device: { id: "device-1" }, runtimes: [] };
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

test("a device registered to another account does not appear ready, and settings explain why", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  const loadDevicesSource = app.slice(app.indexOf("async function loadDevices()"), app.indexOf("function scheduleLocalAgentReprobe()"));
  const settingsSource = app.slice(app.indexOf("async function openLocalAgentSettings()"), app.indexOf("const localModelSettings"));
  const state = {
    agentStatus: "online", agentHealth: { registered: true, deviceId: "someone-elses-device" },
    device: undefined, deviceAccessChecked: false,
  };
  let renderedStatus = "";
  let message = "";
  let toast = "";
  const controls = runInNewContext(`${loadDevicesSource}\n${settingsSource}\n({ loadDevices, openLocalAgentSettings })`, {
    localRuntimeState: state,
    localSkillPackages: [], localSkillPackagesLoaded: false,
    probeLocalAgent: async () => undefined,
    routerClient: { request: async () => Response.json({ devices: [] }) },
    renderLocalAgentState: () => { renderedStatus = state.agentStatus; },
    updateLocalControls: () => undefined,
    setStatus: (value: string) => { message = value; },
    showToast: (value: string) => { toast = value; },
  });
  await controls.loadDevices();
  assert.equal(state.deviceAccessChecked, true);
  assert.equal(renderedStatus, "paired_elsewhere");
  await controls.openLocalAgentSettings();
  assert.match(message, /已绑定其他账号/);
  assert.equal(toast, message);
});

test("settings renew a missing local session for the paired account", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  const settingsSource = app.slice(app.indexOf("async function openLocalAgentSettings()"), app.indexOf("const localModelSettings"));
  const modal = { hidden: true };
  const sessionState = { localSessionToken: "" };
  let refreshed = 0;
  const { openLocalAgentSettings } = runInNewContext(`${settingsSource}\n({ openLocalAgentSettings })`, {
    localRuntimeState: { device: { id: "device-1" }, agentStatus: "online" },
    sessionState,
    refreshLocalSessionOnce: async () => { refreshed++; sessionState.localSessionToken = "new-session"; },
    loadLocalAgentConfig: async () => undefined,
    loadLocalRuntimes: async () => undefined,
    loadLocalModelConfiguration: async () => undefined,
    loadLocalSkillPackages: async () => undefined,
    renderLocalAgentConfig: () => undefined,
    syncLocalRuntimeManager: () => undefined,
    activateAgentSettingsView: () => undefined,
    $: () => modal,
  });
  await openLocalAgentSettings();
  assert.equal(refreshed, 1);
  assert.equal(modal.hidden, false);
});
