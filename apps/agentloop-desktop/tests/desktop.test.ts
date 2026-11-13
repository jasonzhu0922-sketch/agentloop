import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, access, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { AppError, RuntimeWorkspaceService } from "@zhujun/agentloop";
import type { LocalModelProviderPort } from "@zhujun/agentloop-local-runtime";
import { loadConnectorModules } from "@zhujun/agentloop-local-runtime/connectors";
import { startDesktop, type DesktopApplication } from "../src/application.ts";
import { DEFAULT_RUNTIME_ID } from "../src/api/desktop-api.ts";
import { accountDataDirectory } from "../src/accounts/account-managers.ts";
import { DESKTOP_DEVELOPMENT_PORT, desktopLaunchOptions } from "../src/main.ts";
import { builtinConnectorModules } from "../src/connectors/builtin-connector-modules.ts";
import { fixtureAuth, TEST_OWNER } from "./fixtures/auth.ts";
import { modelEndpoint } from "../src/security/model-endpoint.ts";
import { greetingModel, modelPort } from "../../../packages/agentloop-local-runtime/tests/fixtures/models.ts";
import { humanLoopModel, selectionRequirement } from "./fixtures/human-loop-model.ts";
import { fixtureProvider } from "../../../packages/agentloop-local-runtime/tests/fixtures/http-model.ts";

type OwnedApplication = Extract<DesktopApplication, { existing: false }>;

test("Desktop command uses one documented fixed port and rejects malformed launch arguments", () => {
  assert.equal(DESKTOP_DEVELOPMENT_PORT, 8796);
  assert.deepEqual(desktopLaunchOptions(["--development"]), { openBrowser: true });
  assert.deepEqual(desktopLaunchOptions(["--development", "--no-open", "--data-dir", "/tmp/desktop"]), { openBrowser: false, dataDirectory: "/tmp/desktop" });
  for (const args of [[], ["--development", "--data-dir"], ["--development", "--port", "0"]]) assert.throws(() => desktopLaunchOptions(args), /desktop_/);
});

test("root development scripts pin the Account Service and Desktop topology", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  assert.equal(manifest.scripts["start:accounts"], "node apps/agentloop-account-service/scripts/local-service-manager.mjs --foreground");
  assert.equal(manifest.scripts["restart:accounts"], "node apps/agentloop-account-service/scripts/local-service-manager.mjs --background");
  assert.equal(manifest.scripts["start:desktop"], "npm run restart:accounts && AGENTLOOP_DESKTOP_AUTH_BASE_URL=http://127.0.0.1:8795 npm run start --workspace agentloop-desktop -- --development");
  const desktop = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  assert.equal(desktop.scripts.prestart, "npm run build --workspace @zhujun/agentloop && npm run build --workspace @zhujun/agentloop-local-runtime");
});

test("Desktop host approves the built-in Connector modules", () => {
  assert.deepEqual(builtinConnectorModules().map(({ exportName }) => exportName), [
    "feishuConnector", "createConfigured126MailConnector", "createConfiguredWpsConnector",
  ]);
  for (const registration of builtinConnectorModules()) assert.match(registration.modulePath, /^\//);
});

test("Desktop built-in Connector registrations load their real modules", async () => {
  const modules = await loadConnectorModules({ registrations: builtinConnectorModules() });
  assert.deepEqual(modules.map(module => module.definition.manifest.key), ["feishu", "126-mail", "kingsoft-wps"]);
});

test("Desktop Connector API exposes its host-approved built-ins", async t => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-desktop-connectors-")); const skills = join(root, "skills"); await mkdir(skills);
  const app = await startDesktop({ mode: "development", dataDirectory: join(root, "desktop-data"), models: modelPort(), cloudAuth: fixtureAuth(), bundledSkillDirectories: [skills], connectorModules: builtinConnectorModules(), openBrowser: false });
  assert.equal(app.existing, false); t.after(async () => { if (!app.existing) await app.close(); await rm(root, { recursive: true, force: true }); });
  const call = client(app.origin, await session(app.origin));
  const { connectors } = await jsonCall(call, "/api/connectors/catalog");
  assert.deepEqual(connectors.map((connector: { key: string }) => connector.key), ["feishu", "126-mail", "kingsoft-wps"]);
  const { connector } = await jsonCall(call, "/api/connectors", { connector: { connectorKey: "126-mail", displayName: "我的 126 邮箱", enabled: false, scopes: [] } });
  assert.equal(connector.connectorKey, "126-mail");
  const { connections } = await jsonCall(call, "/api/connectors");
  assert.deepEqual(connections.map((connection: { id: string }) => connection.id), [connector.id]);
  assert.equal((await call(`/api/runtimes/${DEFAULT_RUNTIME_ID}/connectors`)).status, 404, "Connector accounts are not Runtime settings");
});

test("Desktop MCP catalog applies to every account Runtime and survives restart", async t => {
  const mcp = createServer((req, res) => {
    let data = ""; req.on("data", chunk => { data += chunk; }); req.on("end", () => {
      const message = JSON.parse(data);
      if (message.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "tools/list" ? { tools: [] } : { protocolVersion: "2025-06-18" } }));
    });
  });
  await new Promise<void>(resolve => mcp.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => mcp.close(() => resolve())));
  const address = mcp.address(); assert.ok(address && typeof address !== "string");
  const { app, reopen } = await fixture(t);
  const call = client(app.origin, await session(app.origin));
  const { runtime } = await jsonCall(call, "/api/runtimes", { displayName: "Second Runtime" });
  const { server } = await jsonCall(call, "/api/mcp", { server: {
    displayName: "Shared MCP", key: "shared-mcp", transport: "http", url: `http://127.0.0.1:${address.port}/mcp`, auth: { kind: "query_parameter", parameterName: "key", value: "synthetic-mcp-secret" },
  } });
  assert.equal(server.auth.credentialConfigured, true);
  assert.equal(JSON.stringify(server).includes("synthetic-mcp-secret"), false);
  const { credentialConfigured, ...auth } = server.auth;
  const { server: updated } = await jsonCall(call, "/api/mcp", { server: { ...server, displayName: "Updated MCP", auth } });
  assert.equal(updated.id, server.id); assert.equal(updated.auth.credentialConfigured, true);
  assert.equal((await call("/api/mcp", { server: { ...server, url: `http://127.0.0.1:${address.port}/other`, auth } })).status, 400);
  for (const id of [DEFAULT_RUNTIME_ID, runtime.id]) {
    const settings = await jsonCall(call, `/api/runtimes/${id}/configuration`);
    assert.deepEqual(settings.configuration.mcpServerIds, [server.id]);
  }
  const { runtime: later } = await jsonCall(call, "/api/runtimes", { displayName: "Later Runtime" });
  assert.deepEqual((await jsonCall(call, `/api/runtimes/${later.id}/configuration`)).configuration.mcpServerIds, [server.id]);
  const restored = await reopen(); const after = client(restored.origin, await session(restored.origin));
  assert.deepEqual((await jsonCall(after, `/api/runtimes/${runtime.id}/configuration`)).configuration.mcpServerIds, [server.id]);
  assert.deepEqual(await jsonCall(after, `/api/mcp/${server.id}/remove`, {}), { removed: true });
  assert.deepEqual((await jsonCall(after, `/api/runtimes/${later.id}/configuration`)).configuration.mcpServerIds, []);
});

test("legacy Runtime-scoped Connector accounts migrate to the device-wide catalog", async t => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-desktop-connector-migration-")); const skills = join(root, "skills"); await mkdir(skills);
  const database = new DatabaseSync(join(root, "supervisor.db"));
  database.exec(`CREATE TABLE desktop_connector_settings (
    id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, owner_id TEXT NOT NULL, connector_key TEXT NOT NULL, display_name TEXT NOT NULL,
    enabled INTEGER NOT NULL, scopes TEXT NOT NULL, secret_ref TEXT, updated_at INTEGER NOT NULL
  )`);
  database.prepare("INSERT INTO desktop_connector_settings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("connection_legacy", "old-runtime", TEST_OWNER, "126-mail", "已有 126 邮箱", 0, "[]", null, Date.now()); database.close();
  await writeFile(join(root, ".desktop-data.json"), JSON.stringify({ schema: "agentloop.desktop.data/v1", mode: "development", installationId: "00000000-0000-4000-8000-000000000001" }));
  const app = await startDesktop({ mode: "development", dataDirectory: root, models: modelPort(), cloudAuth: fixtureAuth(), bundledSkillDirectories: [skills], connectorModules: builtinConnectorModules(), openBrowser: false });
  assert.equal(app.existing, false); t.after(async () => { if (!app.existing) await app.close(); await rm(root, { recursive: true, force: true }); });
  const { connections } = await jsonCall(client(app.origin, await session(app.origin)), "/api/connectors");
  assert.deepEqual(connections.map((connection: { id: string }) => connection.id), ["connection_legacy"]);
  const verified = new DatabaseSync(join(accountDataDirectory(root, TEST_OWNER), "supervisor.db"), { readOnly: true });
  const columns = verified.prepare("PRAGMA table_info(desktop_connector_settings)").all() as Array<{ name: string }>;
  verified.close();
  assert.equal(columns.some(column => column.name === "runtime_id"), false);
});

test("Desktop terminal logging summarizes operations without exposing submitted content", async t => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-desktop-log-")); const skills = join(root, "skills"); await mkdir(skills);
  const entries: string[] = [];
  const app = await startDesktop({ mode: "development", dataDirectory: join(root, "desktop-data"), models: modelPort(), cloudAuth: fixtureAuth(), bundledSkillDirectories: [skills], openBrowser: false, log: entry => entries.push(entry) });
  assert.equal(app.existing, false); t.after(async () => { if (!app.existing) await app.close(); await rm(root, { recursive: true, force: true }); });
  const call = client(app.origin, await session(app.origin));
  const privateInput = "terminal logs must never expose this task";
  const { run } = await jsonCall(call, "/api/runs", { requestId: "terminal-log-run", input: privateInput, modelKey: "local:test" });
  await settled(call, run.id);
  assert.ok(entries.some(entry => /^POST \/api\/runs → 200 \(\d+ms\)$/.test(entry)));
  assert.ok(entries.some(entry => entry.includes("event=run.started")));
  assert.ok(entries.some(entry => entry.includes("event=model.request.completed")));
  assert.ok(entries.some(entry => entry.includes("event=run.completed")));
  assert.equal(entries.some(entry => entry.includes(privateInput) || entry.includes(run.id) || entry.includes("fixture-password-only")), false);
});

test("Desktop admits write and command tools into the Kernel and logs failed Runs", async t => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-desktop-execution-")); const skills = join(root, "skills"); await mkdir(skills);
  const entries: string[] = []; let toolContext = "";
  const app = await startDesktop({ mode: "development", dataDirectory: join(root, "desktop-data"),
    models: modelPort({ ...greetingModel(), async complete(input) {
      toolContext = JSON.stringify(input);
      // Stop at the model boundary after inspecting the real admitted catalog.
      throw new AppError("MODEL_ERROR", "desktop_test_provider_unavailable", 502);
    } }), cloudAuth: fixtureAuth(), bundledSkillDirectories: [skills], openBrowser: false, log: entry => entries.push(entry) });
  assert.equal(app.existing, false); t.after(async () => { if (!app.existing) await app.close(); await rm(root, { recursive: true, force: true }); });
  const call = client(app.origin, await session(app.origin));
  const { run } = await jsonCall(call, "/api/runs", { requestId: "html-execution", input: "创建 HTML 项目周报", modelKey: "local:test" });
  assert.equal((await settled(call, run.id)).status, "failed");
  assert.match(toolContext, /computer_write_file/);
  assert.match(toolContext, /computer_run_command/);
  const database = new DatabaseSync(join(accountDataDirectory(join(root, "desktop-data"), TEST_OWNER), "runtime.db"), { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT allow_dangerous_tools FROM runs WHERE id = ?").get(run.id)?.allow_dangerous_tools, 1);
  } finally { database.close(); }
  assert.ok(entries.some(entry => entry.includes("event=run.failed") && entry.includes("MODEL_ERROR") && entry.includes("desktop_test_provider_unavailable")), entries.join("\n"));
});

test("Desktop general settings persist custom local storage and reload an idle Runtime", async t => {
  const { root, app, reopen } = await fixture(t);
  assert.equal((await fetch(`${app.origin}/api/device-storage`)).status, 401);
  const call = client(app.origin, await session(app.origin));
  const { storage } = await jsonCall(call, "/api/device-storage");
  const canonicalRoot = join(await realpath(accountDataDirectory(root, TEST_OWNER)), "storage");
  assert.deepEqual(storage, { workspaceRoot: join(canonicalRoot, "workspace"), uploadStorageRoot: join(canonicalRoot, "uploads") });
  const custom = { workspaceRoot: join(canonicalRoot, "custom-workspace"), uploadStorageRoot: join(canonicalRoot, "custom-uploads") };
  assert.deepEqual((await jsonCall(call, "/api/device-storage", custom)).storage, custom);
  const restarted = await reopen();
  assert.deepEqual((await jsonCall(client(restarted.origin, await session(restarted.origin)), "/api/device-storage")).storage, custom);
});
async function fixture(t: test.TestContext, models: LocalModelProviderPort | null = modelPort()) {
  const root = await mkdtemp(join(tmpdir(), "agentloop-desktop-test-"));
  const skills = join(root, "skills"); await mkdir(skills);
  const directory = join(root, "desktop-data");
  const options = { mode: "development" as const, dataDirectory: directory, cloudAuth: fixtureAuth(), models: models ?? undefined, bundledSkillDirectories: [skills], openBrowser: false };
  let app = await startDesktop(options); assert.equal(app.existing, false);
  t.after(async () => { if (!app.existing) await app.close(); await rm(root, { recursive: true, force: true }); });
  return { root: directory, options, app: app as OwnedApplication, reopen: async () => {
    if (!app.existing) await app.close(); app = await startDesktop(options); assert.equal(app.existing, false); return app as OwnedApplication;
  } };
}
async function session(origin: string) {
  const response = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "test@example.test", password: "fixture-password-only" }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.doesNotMatch(cookie, /Domain=/i);
  const { csrfToken } = await response.json();
  return { cookie: cookie.split(";")[0]!, csrf: csrfToken as string };
}
function client(origin: string, auth: { cookie: string; csrf: string }) {
  return async (path: string, body?: unknown) => fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { Cookie: auth.cookie,
      ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json", "X-Desktop-CSRF": auth.csrf }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function jsonCall(call: ReturnType<typeof client>, path: string, body?: unknown) {
  const response = await call(path, body); const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result)); return result;
}
async function settled(call: ReturnType<typeof client>, runId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { run } = await jsonCall(call, `/api/runs/${runId}`);
    if (run.status !== "running") { await setTimeout(10); return run; }
    await setTimeout(10);
  }
  throw new Error("deterministic_run_not_settled");
}
function raw(origin: string, path: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const req = request(`${origin}${path}`, { headers }, response => { response.resume(); response.on("end", () => resolve(response.statusCode!)); });
    req.on("error", reject); req.end();
  });
}

test("loopback HTTP enforces Host, Origin, Session, CSRF and trusted request fields", async t => {
  const { app } = await fixture(t); const origin = app.origin;
  const page = await fetch(origin); assert.equal(page.status, 200); assert.match(await page.text(), /正在确认云端账号/);
  assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(await raw(origin, "/", { Host: "evil.example.test" }), 403);
  assert.equal(await raw(origin, "/", { Host: new URL(origin).host, "X-Forwarded-Host": "evil.example.test" }), 200);
  assert.equal((await fetch(`${origin}/api/conversations`)).status, 401);
  assert.equal((await fetch(`${origin}/api/dev/session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example.test" }, body: "{}" })).status, 403);
  assert.equal((await fetch(`${origin}/api/dev/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
  const auth = await session(origin); const call = client(origin, auth);
  const input = { requestId: "security", input: "你好", modelKey: "local:test" };
  assert.equal((await fetch(`${origin}/api/runs`, { method: "POST", headers: { Cookie: auth.cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(input) })).status, 403);
  assert.equal((await fetch(`${origin}/api/runs`, { method: "POST", headers: { Cookie: auth.cookie, Origin: origin, "Content-Type": "application/json", "X-Desktop-CSRF": "é".repeat(43) }, body: JSON.stringify(input) })).status, 403);
  assert.equal((await fetch(`${origin}/api/conversations`, { headers: { Cookie: auth.cookie, Origin: "https://evil.example.test" } })).status, 403);
  assert.equal(await raw(origin, "/api/conversations", { Cookie: auth.cookie, "Sec-Fetch-Site": "cross-site" }), 403);
  for (const field of ["ownerUserId", "allowDangerousTools", "visibleDirectories", "connectorConnectionIds"]) {
    assert.equal((await call("/api/runs", { ...input, [field]: "untrusted" })).status, 400);
  }
  assert.equal((await fetch(`${origin}/api/runs`, { method: "POST", headers: { Cookie: auth.cookie, Origin: origin, "Content-Type": "text/plain", "X-Desktop-CSRF": auth.csrf }, body: JSON.stringify(input) })).status, 415);
  assert.equal((await fetch(`${origin}/api/runs`, { method: "POST", headers: { Cookie: auth.cookie, Origin: origin, "Content-Type": "application/json", "X-Desktop-CSRF": auth.csrf }, body: "{" })).status, 400);
  assert.equal((await call("/api/runs", { ...input, modelKey: "local:missing" })).status, 409);
  assert.deepEqual((await jsonCall(call, "/api/conversations")).conversations, []);
  assert.equal((await call("/api/runs/nonexistent/events?afterSeq=-1")).status, 400);
  const oversized = await call("/api/runs", { ...input, input: "x".repeat(1_500_000) }); assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get("access-control-allow-origin"), null);
});

test("Desktop serves its own Multi Runtime presentation without importing the cloud application", async t => {
  const { app } = await fixture(t);
  const page = await (await fetch(app.origin)).text();
  for (const className of ["app-shell", "sidebar", "conversation-scroll", "composer-box", "artifact-workspace"]) assert.ok(page.includes(className));
  assert.match(page, /account-identity/);
  for (const className of ["agent-settings-card", "agent-settings-layout", "agent-settings-nav", "agent-settings-content"]) assert.ok(page.includes(className), `settings shell missing ${className}`);
  for (const label of ["常规", "模型配置", "Skill 管理", "MCP 配置", "Runtime 管理", "Connector 配置", "完成"]) assert.ok(page.includes(label), `settings navigation missing ${label}`);
  for (const path of ["/app.js", "/composer-preferences.js", "/artifact-workspace.js", "/model-settings.js", "/conversation.js", "/turn-projection.js", "/run-polling.js", "/conversation.css", "/markdown.js", "/markdown.css", "/reference/ui/scroll-follow.js", "/reference/ui/composer-input.js", "/reference/ui/message-selection.js", "/reference/presentation/assistant-message-presentation.js", "/reference/projections/assistant-event-projection.js", "/reference/projections/execution-detail-projection.js", "/styles.css", "/multi-runtime.css", "/assets/xuanwu-mascot-icon.png"]) {
    const response = await fetch(`${app.origin}${path}`); assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.match(response.headers.get("content-security-policy")!, /default-src 'none'/);
  }
  const icon = Buffer.from(await (await fetch(`${app.origin}/assets/xuanwu-mascot-icon.png`)).arrayBuffer());
  assert.deepEqual(icon, await readFile(new URL("../../agentloop-multi-runtime/web/assets/xuanwu-mascot-icon.png", import.meta.url)));
  const script = await (await fetch(`${app.origin}/app.js`)).text();
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|runtime-config|\/router\/|https?:\/\//);
  assert.match(script, /textContent/);
  const settingsScript = await (await fetch(`${app.origin}/capability-settings.js`)).text();
  assert.match(settingsScript, /Memory 偏好与隐私沉淀/);
  assert.match(settingsScript, /绑定 126 邮箱/);
  assert.match(settingsScript, /客户端授权码/);
  assert.match(settingsScript, /runtime-manager-card/);
  assert.match(settingsScript, /runtime-detail-modal/);
  assert.match(settingsScript, /配置扩展 Skill/);
  assert.match(settingsScript, /\['configure', '配置'\]/);
  assert.match(settingsScript, /runtimeCapabilityTabs/);
  assert.match(settingsScript, /MCP Servers/);
  assert.match(settingsScript, /runtime-skill-option/);
  assert.match(settingsScript, /runtime-config-actions/);
  assert.match(settingsScript, /选择扩展 Skills/);
  assert.match(settingsScript, /function runtimeActionMenu/);
  assert.match(page, /data-settings-tab="mcp"/);
  assert.match(settingsScript, /renderDeviceMcp/);
  assert.match(settingsScript, /renderSharedMcp/);
  assert.match(settingsScript, /api\('\/api\/connectors'\)/);
  assert.doesNotMatch(settingsScript, /runtimes\/\$\{target\}\/connectors/);
  assert.match(script, /const \{ connections \} = await api\('\/api\/connectors'\)/);
  assert.doesNotMatch(script, /runtimes\/\$\{encodeURIComponent\(runtimeId\)\}\/connectors/);
  // Only copied presentation bytes are exposed; other App and filesystem paths stay private.
  for (const path of ["/runtime-config.js", "/client/app.js", "/styles/runtime-overrides.css", "/assets/unknown.png"]) assert.equal((await fetch(`${app.origin}${path}`)).status, 401);
});

test("local model settings require Session/CSRF and a saved configuration drives a real HTTP adapter Run", async t => {
  const provider = await fixtureProvider(); t.after(() => provider.close());
  const { app, reopen } = await fixture(t, null); const origin = app.origin;
  assert.equal((await fetch(`${origin}/api/model-configuration`)).status, 401);
  const auth = await session(origin); const call = client(origin, auth);
  const initial = await jsonCall(call, "/api/model-configuration"); assert.equal(initial.editable, true);
  assert.deepEqual((await jsonCall(call, "/api/memory-configuration")).memory, { enabled: false });
  assert.equal((await call("/api/memory-configuration", { enabled: true, settlementModelKey: "local:missing" })).status, 409, "Memory must not accept a model absent from the local catalog");
  const credential = "desktop-http-fixture-not-a-real-key";
  const input = { revision: initial.revision, configuration: { reuseCloudModels: false, providers: [{ key: "fixture", displayName: "本机测试服务", baseUrl: provider.baseUrl, apiKey: credential,
    models: [{ key: "fixture", displayName: "Fixture", providerModel: "test-upstream", protocol: "responses", contextWindowTokens: 128000, maxOutputTokens: 8192, maxAttempts: 1 }] }] } };
  assert.equal((await fetch(`${origin}/api/model-configuration`, { method: "POST", headers: { Cookie: auth.cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(input) })).status, 403);
  const stored = await jsonCall(call, "/api/model-configuration", input);
  assert.equal(JSON.stringify(stored).includes(credential), false); assert.equal(stored.configuration.providers[0].credentialConfigured, true);
  assert.equal(provider.calls.length, 0, "saving is not a provider connectivity test");
  assert.deepEqual((await jsonCall(call, "/api/models")).models, ["local:fixture"]);
  assert.deepEqual((await jsonCall(call, "/api/memory-configuration", { enabled: true, settlementModelKey: "local:fixture" })).memory, { enabled: true, settlementModelKey: "local:fixture" });
  assert.deepEqual((await jsonCall(call, "/api/memory-configuration", { enabled: false })).memory, { enabled: false });
  const { run } = await jsonCall(call, "/api/runs", { requestId: "saved-config", input: "你好", modelKey: "local:fixture" });
  assert.equal((await settled(call, run.id)).status, "completed"); assert.equal(provider.calls[0]?.authorization, `Bearer ${credential}`);
  assert.equal((await call("/api/model-configuration", input)).status, 409);
  const restored = await reopen(); const after = client(restored.origin, await session(restored.origin));
  assert.deepEqual((await jsonCall(after, "/api/models")).models, ["local:fixture"]);
  assert.equal((await jsonCall(after, "/api/model-configuration")).revision, stored.revision);
});

test("CLI/API model endpoint policy accepts HTTP gateways but not URL credentials or non-HTTP protocols", () => {
  for (const baseUrl of ["http://aigw.baocloud.cn/v1", "http://192.168.1.20:3000/v1", "http://127.0.0.1:3000/v1", "http://[fd00::20]:3000/v1", "https://models.example.test/v1"]) {
    assert.equal(modelEndpoint(baseUrl).href, baseUrl);
  }
  for (const baseUrl of ["http://user:password@models.example.test/v1", "https://user@example.test/v1", "http://models.example.test/v1?token=private", "http://models.example.test/v1#private", "file:///private/key", "ftp://example.test/v1", "ws://example.test/v1", "models.example.test/v1", null, {}]) assert.throws(() => modelEndpoint(baseUrl), /desktop_model_endpoint_invalid/);
});

test("non-loopback HTTP model settings persist through the public API and reopen without a provider request", async t => {
  const { app, reopen } = await fixture(t, null); const call = client(app.origin, await session(app.origin));
  const nativeFetch = globalThis.fetch; let remoteRequests = 0;
  // Only the test's local Desktop requests may leave fetch. Configuring an
  // external gateway must never issue a connectivity probe or send credentials.
  t.mock.method(globalThis, "fetch", ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1") { remoteRequests++; throw new Error("unexpected_remote_request"); }
    return nativeFetch(input, init);
  }) as typeof fetch);
  let settings = await jsonCall(call, "/api/model-configuration");
  for (const baseUrl of ["http://192.168.1.20:3000/v1", "http://models.example.test/v1", "http://aigw.baocloud.cn/v1"]) {
    settings = await jsonCall(call, "/api/model-configuration", { revision: settings.revision, configuration: { reuseCloudModels: false, providers: [{
      key: "http-gateway", displayName: "HTTP Gateway", baseUrl, apiKey: "http-policy-synthetic-key",
      models: [{ key: "http-chat", displayName: "Chat", providerModel: "test-model", protocol: "chat-completions" }, { key: "http-responses", displayName: "Responses", providerModel: "test-model", protocol: "responses" }],
    }] } });
    assert.equal(settings.configuration.providers[0].baseUrl, baseUrl);
    assert.equal(settings.configuration.providers[0].credentialConfigured, true);
    assert.equal(JSON.stringify(settings).includes("http-policy-synthetic-key"), false);
  }
  assert.deepEqual((await jsonCall(call, "/api/models")).models, ["local:http-chat", "local:http-responses"]);
  const restored = await reopen(); const after = client(restored.origin, await session(restored.origin));
  const saved = await jsonCall(after, "/api/model-configuration");
  assert.equal(saved.configuration.providers[0].baseUrl, "http://aigw.baocloud.cn/v1");
  assert.equal(saved.revision, settings.revision); assert.equal(remoteRequests, 0);
});

test("model settings reject URL credentials/non-HTTP endpoints/invalid parameters without reflecting secrets", async t => {
  const { app } = await fixture(t, null); const call = client(app.origin, await session(app.origin));
  const { revision } = await jsonCall(call, "/api/model-configuration"); const secret = "fixture-secret-never-reflected";
  const configuration = { reuseCloudModels: false, providers: [{ key: "provider", displayName: "Provider", baseUrl: "https://api.example.test/v1", apiKey: secret, models: [{ key: "one", displayName: "One", providerModel: "one", temperature: 0.5 }] }] };
  for (const baseUrl of ["http://user:pass@example.test/v1", "https://user:pass@example.test/v1", "http://example.test/v1?api_key=private", "https://example.test/v1?api_key=private", "http://example.test/v1#private", "https://example.test/v1#private", "file:///private/key", "ftp://example.test/v1", "ws://example.test/v1"]) {
    const response = await call("/api/model-configuration", { revision, configuration: { ...configuration, providers: [{ ...configuration.providers[0], baseUrl }] } });
    assert.equal(response.status, 400); assert.equal((await response.text()).includes(secret), false);
  }
  const invalid = await call("/api/model-configuration", { revision, configuration: { ...configuration, providers: [{ ...configuration.providers[0], models: [{ ...configuration.providers[0]!.models[0], temperature: 500 }] }] } });
  assert.equal(invalid.status, 400); assert.equal((await invalid.text()).includes(secret), false);
  assert.deepEqual((await jsonCall(call, "/api/models")).models, []);
  assert.equal((await jsonCall(call, "/api/model-configuration")).revision, revision);
  const readonly = await fixture(t); const readCall = client(readonly.app.origin, await session(readonly.app.origin));
  const host = await jsonCall(readCall, "/api/model-configuration"); assert.equal(host.editable, false);
  assert.equal((await readCall("/api/model-configuration", { revision: host.revision, configuration })).status, 409);
});

test("Desktop accepts attachments up to 4 MiB and rejects larger files", async t => {
  const { app } = await fixture(t); const call = client(app.origin, await session(app.origin));
  const upload = (size: number) => call("/api/sources", {
    conversationId: "upload-limit", originalName: "limit.txt", contentBase64: Buffer.alloc(size, "a").toString("base64"),
  });
  const accepted = await upload(4 * 1024 * 1024);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).source.byteSize, 4 * 1024 * 1024);
  assert.equal((await upload(4 * 1024 * 1024 + 1)).status, 400);
});

test("HTTP Run retries, attachment bindings and event cursors survive application restart", async t => {
  const { root, app, reopen } = await fixture(t);
  const auth = await session(app.origin); const call = client(app.origin, auth);
  assert.deepEqual((await jsonCall(call, "/api/models")).models, ["local:test"]);
  const input = { requestId: "same-request", input: "你好", modelKey: "local:test" };
  const results = await Promise.all(Array.from({ length: 4 }, () => jsonCall(call, "/api/runs", input)));
  const first = results[0].run; assert.equal(new Set(results.map(item => item.run.id)).size, 1);
  assert.equal(first.ownerUserId, TEST_OWNER);
  assert.equal((await settled(call, first.id)).status, "completed");
  assert.equal((await call("/api/runs", { ...input, input: "changed" })).status, 409);
  const { source } = await jsonCall(call, "/api/sources", { conversationId: first.conversationId, originalName: "notes.txt", contentBase64: Buffer.from("local evidence").toString("base64") });
  const { run: second } = await jsonCall(call, "/api/runs", { requestId: "attachment", input: "你好", modelKey: "local:test", conversationId: first.conversationId, uploadedSourceIds: [source.id] });
  await settled(call, second.id);
  const { events } = await jsonCall(call, `/api/runs/${first.id}/events`); assert.ok(events.length > 2);
  const cursor = events[Math.floor(events.length / 2)].seq;
  assert.deepEqual((await jsonCall(call, `/api/runs/${first.id}/events?afterSeq=${cursor}`)).events, events.filter((event: { seq: number }) => event.seq > cursor));
  const db = new DatabaseSync(join(accountDataDirectory(root, TEST_OWNER), "runtime.db"), { readOnly: true });
  try { assert.equal((db.prepare("SELECT COUNT(*) AS count FROM run_sources WHERE run_id = ? AND source_id = ?").get(second.id, source.id) as { count: number }).count, 1); } finally { db.close(); }
  const restored = await reopen();
  assert.equal((await client(restored.origin, auth)("/api/conversations")).status, 401, "Session is not persisted across restart");
  const restoredCall = client(restored.origin, await session(restored.origin));
  assert.equal((await jsonCall(restoredCall, "/api/runs", input)).run.id, first.id);
  assert.deepEqual((await jsonCall(restoredCall, `/api/runs/${first.id}/events`)).events, events);
  assert.equal((await jsonCall(restoredCall, `/api/sources/${source.id}`)).source.originalName, "notes.txt");
  assert.equal((await jsonCall(restoredCall, `/api/conversations/${first.conversationId}`)).runs.length, 2);
});

test("Desktop conversation deletion is authenticated, scoped and durable, including retry tombstones", async t => {
  const { app, reopen } = await fixture(t);
  const auth = await session(app.origin); const call = client(app.origin, auth);
  const input = { requestId: "delete-history", input: "你好", modelKey: "local:test" };
  const { run } = await jsonCall(call, "/api/runs", input); await settled(call, run.id);
  const { source } = await jsonCall(call, "/api/sources", { conversationId: run.conversationId, originalName: "notes.txt", contentBase64: Buffer.from("test source").toString("base64") });
  const path = `/api/conversations/${run.conversationId}/remove`;
  assert.equal((await fetch(`${app.origin}${path}`, { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" } })).status, 401);
  assert.equal((await fetch(`${app.origin}${path}`, { method: "POST", headers: { Origin: app.origin, Cookie: auth.cookie, "Content-Type": "application/json" } })).status, 403);
  assert.equal((await fetch(`${app.origin}${path}`, { method: "POST", headers: { Origin: "https://evil.example.test", Cookie: auth.cookie, "X-Desktop-CSRF": auth.csrf } })).status, 403);
  assert.equal((await call(path, { ownerUserId: "someone-else" })).status, 400);
  const { runtime } = await jsonCall(call, "/api/runtimes", { displayName: "Other Runtime" });
  assert.equal((await call(`${path}?runtimeId=${runtime.id}`, {})).status, 404);
  assert.equal((await jsonCall(call, `/api/conversations/${run.conversationId}`)).runs.length, 1);
  await jsonCall(call, "/api/sources", { conversationId: "keep-draft", originalName: "keep.txt", contentBase64: Buffer.from("keep").toString("base64") });
  assert.deepEqual(await jsonCall(call, path, {}), { removed: true });
  assert.equal((await call(`/api/runs/${run.id}`)).status, 404);
  assert.equal((await call(`/api/sources/${source.id}`)).status, 404);
  assert.deepEqual((await jsonCall(call, "/api/conversations")).conversations.map((item: { id: string }) => item.id), ["keep-draft"]);
  assert.equal((await call(path, {})).status, 404);
  const restored = await reopen(); const after = client(restored.origin, await session(restored.origin));
  assert.equal((await after(`/api/conversations/${run.conversationId}`)).status, 404);
  const retry = await after("/api/runs", input); assert.equal(retry.status, 410);
  assert.equal((await retry.json()).error, "admission_run_deleted");
  await jsonCall(after, "/api/conversations/keep-draft/remove", {});
  assert.deepEqual((await jsonCall(after, "/api/conversations")).conversations, []);
});

test("Desktop rejects deleting an active conversation and retains its history", async t => {
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; }); const base = greetingModel();
  const { app } = await fixture(t, modelPort({ ...base, async complete(input, signal) { enter(); await blocked; return base.complete(input, signal); } }));
  const call = client(app.origin, await session(app.origin));
  const { run } = await jsonCall(call, "/api/runs", { requestId: "delete-active", input: "你好", modelKey: "local:test" }); await entered;
  try {
    assert.equal((await call(`/api/conversations/${run.conversationId}/remove`, {})).status, 409);
    assert.equal((await jsonCall(call, `/api/conversations/${run.conversationId}`)).runs[0].id, run.id);
  } finally { release(); }
  await settled(call, run.id);
  await jsonCall(call, `/api/conversations/${run.conversationId}/remove`, {});
});

test("a new Desktop conversation accepts a local upload before its first Run", async t => {
  const { app, root } = await fixture(t); const call = client(app.origin, await session(app.origin));
  const conversationId = "draft-upload-conversation";
  const { source } = await jsonCall(call, "/api/sources", {
    conversationId, originalName: "before-first-run.txt", contentBase64: Buffer.from("uploaded before the first message").toString("base64"),
  });
  assert.equal(source.originalName, "before-first-run.txt");
  assert.equal((await jsonCall(call, "/api/conversations")).conversations[0]?.id, conversationId);
  const { run } = await jsonCall(call, "/api/runs", {
    requestId: "draft-upload-run", input: "请读取附件", modelKey: "local:test", conversationId, uploadedSourceIds: [source.id],
  });
  await settled(call, run.id);
  const db = new DatabaseSync(join(accountDataDirectory(root, TEST_OWNER), "runtime.db"));
  try {
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM run_sources WHERE run_id = ? AND source_id = ?").get(run.id, source.id) as { count: number }).count, 1);
  } finally { db.close(); }
});

test("repeated launch reuses the ready instance without initializing a second Runtime", async t => {
  const { root, app, options } = await fixture(t); let launches = 0;
  const noSecondRuntime: LocalModelProviderPort = { modelKeys() { throw new Error("second_runtime_opened"); }, create() { throw new Error("second_runtime_opened"); } };
  const second = await startDesktop({ ...options, dataDirectory: root, models: noSecondRuntime, openBrowser: true, browserLauncher: async origin => { assert.equal(origin, app.origin); launches++; } });
  assert.equal(second.existing, true); assert.equal(second.origin, app.origin); assert.equal(launches, 1);
  await app.close(); await app.close();
  await assert.rejects(access(join(root, ".desktop-instance.lock")), { code: "ENOENT" });
});

test("simultaneous processes elect one owner and a second process only reopens its page", async t => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-desktop-process-")); const children: ReturnType<typeof fork>[] = [];
  t.after(async () => {
    for (const child of children) if (child.connected) {
      const ended = new Promise<void>(resolve => child.once("exit", () => resolve())); child.send("close"); await ended;
    }
    await rm(root, { recursive: true, force: true });
  });
  function launch() {
    const child = fork(new URL("./fixtures/child.ts", import.meta.url), [root], { stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(child);
    return new Promise<{ existing: boolean; origin: string }>((resolve, reject) => {
      child.once("message", message => resolve(message as { existing: boolean; origin: string }));
      child.once("error", reject); child.once("exit", code => { if (code) reject(new Error("child_start_failed")); });
    });
  }
  const results = await Promise.all([launch(), launch()]);
  assert.equal(results.filter(item => !item.existing).length, 1);
  assert.equal(new Set(results.map(item => item.origin)).size, 1);
  const metadata = JSON.parse(await readFile(join(root, "desktop-data", ".desktop-instance.lock"), "utf8"));
  assert.equal(metadata.origin, results[0]!.origin); assert.equal("csrfToken" in metadata, false);
});

test("unknown instance locks are retained and never treated as safe to reclaim", async t => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-desktop-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, ".desktop-instance.lock"); await writeFile(lock, "invalid metadata", { mode: 0o600 });
  await assert.rejects(startDesktop({ mode: "development", dataDirectory: root, models: modelPort(), openBrowser: false }), /desktop_instance_unavailable/);
  assert.equal(await readFile(lock, "utf8"), "invalid metadata");
  await assert.rejects(access(join(root, "runtime.db")), { code: "ENOENT" });
});

test("a published lock with a proven-dead owner is preserved then safely recovered", async t => {
  const { root, app, options } = await fixture(t); await app.close();
  const lock = join(root, ".desktop-instance.lock");
  await writeFile(lock, JSON.stringify({ version: 1, instanceId: "dead-instance", pid: 999_999_999, origin: "http://127.0.0.1:1" }), { mode: 0o600 });
  const recovered = await startDesktop({ ...options, dataDirectory: root, openBrowser: false });
  assert.equal(recovered.existing, false);
  const entries = await readdir(root);
  assert.ok(entries.some(entry => entry.startsWith(".desktop-instance.lock.recovered-")));
  if (!recovered.existing) await recovered.close();
});

test("port binding failure releases only its own lock and does not initialize a Runtime", async t => {
  const blocker = createServer(); await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address(); assert.ok(address && typeof address !== "string");
  const root = await mkdtemp(join(tmpdir(), "agentloop-desktop-bind-"));
  t.after(async () => { await new Promise<void>(resolve => blocker.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(startDesktop({ mode: "development", dataDirectory: root, models: modelPort(), port: address.port, openBrowser: false }), { code: "EADDRINUSE" });
  await assert.rejects(access(join(root, ".desktop-instance.lock")), { code: "ENOENT" });
  await assert.rejects(access(join(root, "runtime.db")), { code: "ENOENT" });
});

test("a persisted artifact fixture is served as an attachment, never active same-origin HTML", async t => {
  const { root, app, reopen } = await fixture(t); const call = client(app.origin, await session(app.origin));
  const { run } = await jsonCall(call, "/api/runs", { requestId: "artifact-fixture", input: "你好", modelKey: "local:test" });
  await settled(call, run.id); await app.close();
  // Explicit persisted tool-receipt fixture: this test verifies read transport,
  // not a model-generated artifact or final-delivery acceptance.
  const workspace = new RuntimeWorkspaceService(join(accountDataDirectory(root, TEST_OWNER), "storage", "workspace"), { ownerScoped: true });
  await writeFile(join(workspace.forConversation(TEST_OWNER, run.conversationId), "fixture.html"), "<script>throw new Error('must not execute')</script>");
  const database = new DatabaseSync(join(accountDataDirectory(root, TEST_OWNER), "runtime.db"));
  try {
    const { seq } = database.prepare("SELECT MAX(seq) + 1 AS seq FROM run_events WHERE run_id = ?").get(run.id) as { seq: number };
    database.prepare("INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(run.id, seq, "tool.completed", JSON.stringify({ toolName: "computer_write_file", isError: false, result: JSON.stringify({ path: "fixture.html" }) }), Date.now());
  } finally { database.close(); }
  const restored = await reopen(); const read = client(restored.origin, await session(restored.origin));
  const { artifacts } = await jsonCall(read, `/api/runs/${run.id}/artifacts`); assert.equal(artifacts.length, 1); assert.equal(artifacts[0].role, "process");
  const download = await read(`/api/runs/${run.id}/artifacts/${artifacts[0].id}/download`);
  assert.equal(download.status, 200); assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.match(download.headers.get("content-disposition")!, /^attachment;/); assert.match(download.headers.get("content-security-policy")!, /sandbox/);
  assert.match(await download.text(), /must not execute/);
  assert.equal((await read(`/api/runs/${run.id}/artifacts/missing/download`)).status, 404);
  const endpoint = `/api/runs/${run.id}/artifacts/${artifacts[0].id}`;
  const content = await read(`${endpoint}/content`);
  assert.equal(content.status, 200); assert.match(content.headers.get("content-type")!, /text\/html/);
  assert.equal(content.headers.get("content-disposition"), "inline");
  const policy = content.headers.get("content-security-policy")!;
  assert.match(policy, /sandbox allow-scripts;/); assert.doesNotMatch(policy, /allow-same-origin/);
  assert.match(policy, /frame-ancestors 'self'/); assert.match(policy, /default-src 'none'/);
  assert.match(await content.text(), /must not execute/);
  const preview = await jsonCall(read, `${endpoint}/preview`);
  assert.equal(preview.kind, "text"); assert.match(preview.text, /must not execute/);
  for (const action of ["content", "preview", "download"]) {
    assert.equal((await fetch(`${restored.origin}${endpoint}/${action}`)).status, 401);
    assert.equal((await read(`/api/runs/${run.id}/artifacts/missing/${action}`)).status, 404);
    assert.equal((await read(`${endpoint}/${action}?runtimeId=missing`)).status, 409);
  }

});

test("close refuses a cancelled-but-unwinding Run and keeps the local API usable", async t => {
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; }); const base = greetingModel();
  const { app } = await fixture(t, modelPort({ ...base, async complete(input, signal) { enter(); await blocked; return base.complete(input, signal); } }));
  const call = client(app.origin, await session(app.origin));
  const { run } = await jsonCall(call, "/api/runs", { requestId: "blocked", input: "你好", modelKey: "local:test" }); await entered;
  try {
    await assert.rejects(app.close(), /runtime_active_runs_prevent_close/);
    await jsonCall(call, `/api/runs/${run.id}/cancel`, {});
    await assert.rejects(app.close(), /runtime_active_runs_prevent_close/);
    assert.equal((await jsonCall(call, `/api/runs/${run.id}`)).run.status, "cancelled");
  } finally { release(); }
  await setTimeout(30); await app.close();
});

test("development mode must be explicit and browser failure does not tear down a ready host", async t => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-desktop-mode-"));
  const skills = join(root, "skills"); await mkdir(skills);
  let owned: OwnedApplication | undefined;
  t.after(async () => { await owned?.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(startDesktop({ mode: "production" as "development", dataDirectory: root, models: modelPort() }), /desktop_production_auth_not_implemented/);
  await assert.rejects(access(join(root, ".desktop-instance.lock")), { code: "ENOENT" });
  const app = await startDesktop({ mode: "development", dataDirectory: join(root, "desktop-data"), models: modelPort(), bundledSkillDirectories: [skills], browserLauncher: async () => { throw new Error("browser_error"); } });
  assert.equal(app.existing, false); if (app.existing) throw new Error();
  owned = app; assert.equal(app.browserOpened, false); assert.equal((await fetch(app.origin)).status, 200);
});

test("Desktop refuses to adopt unrelated nonempty data directories", async t => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-desktop-unrelated-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const existing = join(root, "existing-agent.db"); await writeFile(existing, "not-desktop-owned");
  await assert.rejects(startDesktop({ mode: "development", dataDirectory: root, models: modelPort(), openBrowser: false }), /desktop_data_directory_not_empty/);
  assert.equal(await readFile(existing, "utf8"), "not-desktop-owned");
  await assert.rejects(access(join(root, "runtime.db")), { code: "ENOENT" });
  await assert.rejects(access(join(root, ".desktop-instance.lock")), { code: "ENOENT" });
});

test("Runtime initialization failure releases the listener and lock without replacing damaged data", async t => {
  const { root, app, options } = await fixture(t); await app.close();
  const path = join(root, "supervisor.db"); await writeFile(path, "explicit_corrupt_database_fixture");
  await assert.rejects(startDesktop({ ...options, port: Number(new URL(app.origin).port) }));
  await assert.rejects(access(join(root, ".desktop-instance.lock")), { code: "ENOENT" });
  await assert.rejects(fetch(app.origin, { signal: AbortSignal.timeout(500) }));
  assert.equal(await readFile(path, "utf8"), "explicit_corrupt_database_fixture");
});


test("Desktop Human Loop validates, persists and resumes the same real Run through its authenticated API", async t => {
  let resumedContext = '';
  const { app, root } = await fixture(t, modelPort(humanLoopModel(selectionRequirement, context => { resumedContext = context; })));
  const auth = await session(app.origin), call = client(app.origin, auth);
  const { run } = await jsonCall(call, '/api/runs', { requestId: 'hil', input: '请让我选择后继续回答', modelKey: 'local:test' });
  const currentPath = `/api/runs/${run.id}/human-loop/current`;
  let request;
  for (let attempt = 0; attempt < 200; attempt++) {
    request = (await jsonCall(call, currentPath)).request;
    if (request) break;
    await setTimeout(10);
  }
  assert.ok(request, JSON.stringify(await jsonCall(call, `/api/runs/${run.id}`)));
  assert.deepEqual(request.responseSchema, selectionRequirement.responseSchema);
  const path = `/api/runs/${run.id}/human-loop/${request.id}/respond`;
  const answer = { expectedRevision: request.revision, value: ['summary'] };
  assert.equal((await fetch(`${app.origin}${currentPath}`)).status, 401);
  assert.equal((await fetch(`${app.origin}${path}`, { method: 'POST', headers: { Origin: app.origin, Cookie: auth.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(answer) })).status, 403);
  assert.equal((await call(`${currentPath}?runtimeId=missing`)).status, 409);
  assert.equal((await call(path, { ...answer, ownerUserId: 'another-user' })).status, 400);
  assert.equal((await call(path, { value: ['summary'] })).status, 400);
  assert.equal((await call(path, { ...answer, value: ['unknown'] })).status, 400);
  assert.equal((await call(path, { ...answer, expectedRevision: 100 })).status, 409);
  const { runtime } = await jsonCall(call, '/api/runtimes', { displayName: 'Isolated runtime' });
  assert.equal((await call(`${path}?runtimeId=${runtime.id}`, answer)).status, 404);
  // Re-login/reload can discover the durable open question without old events.
  const reconnected = client(app.origin, await session(app.origin));
  assert.equal((await jsonCall(reconnected, currentPath)).request.id, request.id);
  const responses = await Promise.all([reconnected(path, answer), call(path, answer)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const completed = await settled(call, run.id);
  assert.equal(completed.id, run.id); assert.equal(completed.status, 'completed');
  assert.match(completed.output, /已收到用户回答/);
  assert.match(resumedContext, /summary/);
  assert.equal((await jsonCall(call, currentPath)).request, undefined);
  const { events } = await jsonCall(call, `/api/runs/${run.id}/events`);
  assert.equal(events.filter((event: { type: string }) => event.type === 'human_loop.answered').length, 1);
  assert.equal(events.some((event: { type: string }) => event.type === 'human_loop.resume_failed'), false);
  assert.equal((await jsonCall(call, `/api/conversations/${run.conversationId}`)).runs.length, 1);
  const database = new DatabaseSync(join(accountDataDirectory(root, TEST_OWNER), 'runtime.db'), { readOnly: true });
  try {
    const saved = database.prepare('SELECT actor_user_id, response_json FROM human_loop_responses WHERE run_id = ?').all(run.id) as Array<{ actor_user_id: string; response_json: string }>;
    assert.equal(saved.length, 1); assert.equal(saved[0]!.actor_user_id, TEST_OWNER); assert.deepEqual(JSON.parse(saved[0]!.response_json), ['summary']);
  } finally { database.close(); }
});

test("a cancelled Desktop Run cannot accept an old Human Loop answer", async t => {
  const { app } = await fixture(t, modelPort(humanLoopModel()));
  const call = client(app.origin, await session(app.origin));
  const { run } = await jsonCall(call, '/api/runs', { requestId: 'cancel-hil', input: '等待用户选择', modelKey: 'local:test' });
  const path = `/api/runs/${run.id}/human-loop`;
  let request;
  for (let attempt = 0; attempt < 200; attempt++) {
    request = (await jsonCall(call, `${path}/current`)).request;
    if (request) break;
    await setTimeout(10);
  }
  assert.ok(request);
  await jsonCall(call, `/api/runs/${run.id}/cancel`, {});
  assert.equal((await jsonCall(call, `${path}/current`)).request, undefined);
  assert.equal((await call(`${path}/${request.id}/respond`, { expectedRevision: request.revision, value: ['summary'] })).status, 409);
  assert.equal((await jsonCall(call, `/api/runs/${run.id}`)).run.status, 'cancelled');
});


test("model editor schema and draft probe use account auth, CSRF and the persisted configuration revision", async t => {
  const { app } = await fixture(t, null); const auth = await session(app.origin); const call = client(app.origin, auth);
  const schema = await jsonCall(call, "/api/model-configuration/schema");
  assert.deepEqual(schema.providers.map((provider: { id: string }) => provider.id), ["openai-compatible", "openai", "deepseek", "alibaba"]);
  assert.equal((await fetch(`${app.origin}/api/model-configuration/schema`)).status, 401);
  const initial = await jsonCall(call, "/api/model-configuration");
  const upstream = await fixtureProvider(); t.after(() => upstream.close());
  const configuration = { reuseCloudModels: false, providers: [{ key: "bailian", displayName: "百炼", kind: "alibaba", baseUrl: upstream.baseUrl, apiKey: "fixture-probe-key", models: [{ key: "qwen", displayName: "Qwen", providerModel: "qwen3-max", reasoning: "medium" }] }] };
  const input = { revision: initial.revision, configuration, modelKey: "qwen" };
  assert.equal((await fetch(`${app.origin}/api/model-configuration/test`, { method: "POST", headers: { Cookie: auth.cookie, Origin: app.origin, "Content-Type": "application/json" }, body: JSON.stringify(input) })).status, 403);
  const result = await jsonCall(call, "/api/model-configuration/test", input);
  assert.equal(result.ok, true); assert.equal(JSON.stringify(result).includes("fixture-probe-key"), false);
  assert.equal(upstream.calls.length, 1); assert.equal(upstream.calls[0]?.body.enable_thinking, true);
  assert.deepEqual(await jsonCall(call, "/api/model-configuration"), initial);
  assert.equal((await call("/api/model-configuration/test", { ...input, modelKey: "missing" })).status, 400);
  const stored = await jsonCall(call, "/api/model-configuration", { revision: initial.revision, configuration });
  assert.equal((await call("/api/model-configuration/test", input)).status, 409);
  assert.equal((await jsonCall(call, "/api/model-configuration")).revision, stored.revision);
});
