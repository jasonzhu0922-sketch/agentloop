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
  state.agentReconnect = Promise.resolve();
  state.agentReprobe = setTimeout(() => assert.fail("state cleanup must cancel pending reprobes"), 50);
  state.hydratedPreferenceKey = "user-1:device-1";
  state.clear();
  assert.equal(state.device, undefined);
  assert.equal(state.runtimeId, "");
  assert.deepEqual(state.runtimes, []);
  assert.deepEqual(state.lifecycleOperations, {});
  assert.deepEqual(state.scopes, []);
  assert.equal(state.agentStatus, "checking");
  assert.equal(state.agentHealth, undefined);
  assert.equal(state.agentReconnect, undefined);
  assert.equal(state.agentReprobe, undefined);
  assert.equal(state.hydratedPreferenceKey, "");
});

test("browser does not report a failed Local Agent health probe as uninstalled", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  assert.match(app, /catch \{\s+localRuntimeState\.agentHealth = undefined;\s+localRuntimeState\.agentStatus = "unreachable";/);
  assert.match(app, /unreachable: \["等待 Agent"/);
  assert.doesNotMatch(app, /agentStatus = localStorage\.getItem\("agentloop\.local-agent-seen\.v1"\)/);
});

test("Local Agent status explains automatic startup recovery without asking the user to refresh", async () => {
  const [app, page] = await Promise.all([
    readFile(new URL("../web/client/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/pages/app.html", import.meta.url), "utf8"),
  ]);
  assert.match(app, /starting: \["正在启动"/);
  assert.match(app, /unreachable: \["等待 Agent"[\s\S]*?无需刷新页面/);
  assert.match(app, /router_disconnected: \["正在重连"[\s\S]*?无需刷新页面/);
  assert.match(app, /LOCAL_AGENT_HEALTH_INTERVAL_MS/);
  assert.match(app, /scheduleLocalAgentReprobe\(\);/);
  assert.match(page, /id="local-agent-hint"[^>]*role="status"[^>]*aria-live="polite"/);
});

test("Local Agent observation retries startup quickly and monitors a healthy connection without reconnect churn", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function scheduleLocalAgentReprobe()");
  const end = app.indexOf("async function connectRegisteredLocalAgent()", start);
  assert.ok(start >= 0 && end > start, "the Local Agent observer must remain independent from reconnect work");
  const state = { agentStatus: "unreachable", agentReprobe: undefined as unknown };
  let delay = 0;
  const schedule = runInNewContext(`${app.slice(start, end)}; scheduleLocalAgentReprobe`, {
    localRuntimeState: state,
    LOCAL_AGENT_RETRY_DELAY_MS: 1_500,
    LOCAL_AGENT_HEALTH_INTERVAL_MS: 10_000,
    setTimeout(_callback: () => void, value: number) { delay = value; return { value }; },
    probeLocalAgent: async () => undefined,
    loadDevices: async () => undefined,
  });
  schedule();
  assert.equal(delay, 1_500);
  state.agentReprobe = undefined;
  state.agentStatus = "online";
  schedule();
  assert.equal(delay, 10_000, "a steady connection receives passive health observation instead of forced reconnects");
});

test("browser keeps Agent reconnect and Runtime lifecycle on the loopback service", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  assert.match(app, /localAgentFetch\("\/v1\/agent\/reconnect", \{ method: "POST" \}\)/);
  assert.match(app, /reconnectBody\.routerConnected !== true/);
  assert.match(app, /agentStatus === "online" \|\| localRuntimeState\.agentStatus === "router_disconnected"/);
  assert.match(app, /agentStatus !== "online_unpaired" && localRuntimeState\.agentStatus !== "online" && localRuntimeState\.agentStatus !== "router_disconnected"/);
  assert.match(app, /localAgentFetch\("\/v1\/local-runtimes"\)/);
  assert.match(app, /localAgentFetch\(`\/v1\/local-runtimes\/\$\{encodeURIComponent\(runtimeId\)\}\/\$\{action\}`/);
  assert.doesNotMatch(app, /routerClient\.request\(localAgentRouterPath\("\/runtimes"\)\)/);
});

test("browser recovers the paired device before requesting a local model catalog", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  assert.match(app, /localDeviceRecovery = loadDevices\(\)/);
  assert.match(app, /if \(isLocalExecution\(\) && localDeviceRecovery !== undefined\) await localDeviceRecovery/);
  assert.match(app, /if \(!modelContext\.local \|\| \(localRuntimeState\.device\?\.id && sessionState\.localSessionToken\)\)/);
});

test("refresh recovery shares one Local Agent reconnect while Router health is disconnected", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  const start = app.indexOf("async function connectRegisteredLocalAgent()");
  const end = app.indexOf("async function probeLocalAgent()", start);
  assert.ok(start >= 0 && end > start, "reconnect workflow must remain a distinct browser boundary");
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reconnectRequests = 0;
  const loaded: string[] = [];
  // Re-evaluate with the asynchronous gate in scope so two recovery sources
  // overlap exactly as bootstrap and the status button can in a browser.
  const connect = runInNewContext(`${app.slice(start, end)}; connectRegisteredLocalAgent`, {
    localRuntimeState: { device: { id: "device-1" }, agentReconnect: undefined },
    localAgentFetch: async () => { reconnectRequests += 1; await gate; return { ok: true, json: async () => ({ routerConnected: true }) }; },
    loadLocalRuntimes: async () => { loaded.push("runtimes"); },
    loadLocalScopes: async () => { loaded.push("scopes"); },
    reconcileStrictLocalRuns: async () => { loaded.push("runs"); },
    loadLocalAgentConfig: async () => { loaded.push("config"); },
    updateLocalControls: () => { loaded.push("controls"); },
  });
  const first = connect();
  const second = connect();
  assert.equal(reconnectRequests, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(loaded, ["runtimes", "scopes", "runs", "config", "controls"]);
});

test("page bootstrap and the Local Runtime button both reconnect a registered disconnected Agent", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  const state = { agentStatus: "router_disconnected", agentHealth: { deviceId: "device-1", registered: true }, device: undefined as { id: string } | undefined };
  let reconnects = 0;
  let scheduled = 0;
  let routerAvailable = true;
  const router = { request: async () => routerAvailable ? { ok: true, json: async () => ({ devices: [{ id: "device-1", status: "active" }] }) } : { ok: false } };
  const loadStart = app.indexOf("async function loadDevices(");
  const loadEnd = app.indexOf("function scheduleLocalAgentReprobe()", loadStart);
  const loadDevices = runInNewContext(`${app.slice(loadStart, loadEnd)}; loadDevices`, {
    localRuntimeState: state,
    probeLocalAgent: async () => undefined,
    routerClient: router,
    connectRegisteredLocalAgent: async () => { reconnects += 1; },
    scheduleLocalAgentReprobe: () => { scheduled += 1; },
    updateLocalControls() {},
    localSkillPackages: [],
    localSkillPackagesLoaded: true,
  });
  await loadDevices();
  assert.equal(state.device?.id, "device-1");
  assert.equal(reconnects, 1, "refresh recovery must call the protected loopback reconnect");
  assert.equal(scheduled, 1, "health observation remains active until the Router confirms recovery");

  state.agentStatus = "unreachable";
  scheduled = 0;
  await loadDevices();
  assert.equal(scheduled, 1, "a startup-window miss remains under automatic observation");

  state.agentStatus = "router_disconnected";
  scheduled = 0;
  routerAvailable = false;
  await loadDevices();
  assert.equal(scheduled, 1, "a Router device-list failure does not stop local connection observation");
  routerAvailable = true;
  state.agentStatus = "router_disconnected";

  const enableStart = app.indexOf("async function enableLocalRuntime()");
  const enableEnd = app.indexOf("async function loadDevices(", enableStart);
  const button = { disabled: false };
  const enableLocalRuntime = runInNewContext(`${app.slice(enableStart, enableEnd)}; enableLocalRuntime`, {
    $: () => button,
    sessionState: { user: { id: "user-1" } },
    localRuntimeState: state,
    probeLocalAgent: async () => undefined,
    connectRegisteredLocalAgent: async () => { reconnects += 1; },
    redirectToLogin() {}, offerLocalAgentInstall() {}, startInstalledLocalAgent() {},
    call: async () => assert.fail("registered Agent must not be paired again"),
    setStatus() {},
  });
  await enableLocalRuntime();
  assert.equal(reconnects, 2, "the visible Local Runtime control must also request reconnect");
  assert.equal(button.disabled, false);
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
    loadLocalAgentConfig() {}, loadLocalRuntimes() {}, loadLocalModelConfiguration() {}, loadLocalMemoryConfiguration() {}, loadLocalSkillPackages() {},
    createLocalMemorySettings: () => ({ load() {}, canClose: () => true, refreshModels() {} }),
    localAgentFetch() {}, showToast() {},
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
