import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { RuntimeWorkspaceService } from "@zhujun/agentloop";
import type { LocalModelProviderPort } from "@zhujun/agentloop-local-runtime";
import { startDesktop, type DesktopApplication } from "../src/application.ts";
import { fixtureAuth, TEST_OWNER } from "./fixtures/auth.ts";
import { modelEndpoint } from "../src/security/model-endpoint.ts";
import { greetingModel, modelPort } from "../../../packages/agentloop-local-runtime/tests/fixtures/models.ts";
import { fixtureProvider } from "../../../packages/agentloop-local-runtime/tests/fixtures/http-model.ts";

type OwnedApplication = Extract<DesktopApplication, { existing: false }>;
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
  for (const label of ["模型配置", "Skill 管理", "Runtime 管理", "Connector 配置", "MCP 配置"]) assert.ok(page.includes(label), `settings navigation missing ${label}`);
  for (const path of ["/app.js", "/model-settings.js", "/conversation.js", "/turn-projection.js", "/conversation.css", "/markdown.js", "/markdown.css", "/reference/ui/scroll-follow.js", "/reference/ui/composer-input.js", "/reference/ui/message-selection.js", "/reference/presentation/assistant-message-presentation.js", "/reference/projections/assistant-event-projection.js", "/reference/projections/execution-detail-projection.js", "/styles.css", "/multi-runtime.css", "/assets/xuanwu-mascot-icon.png"]) {
    const response = await fetch(`${app.origin}${path}`); assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.match(response.headers.get("content-security-policy")!, /default-src 'none'/);
  }
  const icon = Buffer.from(await (await fetch(`${app.origin}/assets/xuanwu-mascot-icon.png`)).arrayBuffer());
  assert.deepEqual(icon, await readFile(new URL("../../agentloop-multi-runtime/web/assets/xuanwu-mascot-icon.png", import.meta.url)));
  const script = await (await fetch(`${app.origin}/app.js`)).text();
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|runtime-config|\/router\/|https?:\/\//);
  assert.match(script, /textContent/);
  // Only copied presentation bytes are exposed; other App and filesystem paths stay private.
  for (const path of ["/runtime-config.js", "/client/app.js", "/styles/runtime-overrides.css", "/assets/unknown.png"]) assert.equal((await fetch(`${app.origin}${path}`)).status, 401);
});

test("local model settings require Session/CSRF and a saved configuration drives a real HTTP adapter Run", async t => {
  const provider = await fixtureProvider(); t.after(() => provider.close());
  const { app, reopen } = await fixture(t, null); const origin = app.origin;
  assert.equal((await fetch(`${origin}/api/model-configuration`)).status, 401);
  const auth = await session(origin); const call = client(origin, auth);
  const initial = await jsonCall(call, "/api/model-configuration"); assert.equal(initial.editable, true);
  const credential = "desktop-http-fixture-not-a-real-key";
  const input = { revision: initial.revision, configuration: { reuseCloudModels: false, providers: [{ key: "fixture", displayName: "本机测试服务", baseUrl: provider.baseUrl, apiKey: credential,
    models: [{ key: "fixture", displayName: "Fixture", providerModel: "test-upstream", protocol: "responses", contextWindowTokens: 128000, maxOutputTokens: 8192, maxAttempts: 1 }] }] } };
  assert.equal((await fetch(`${origin}/api/model-configuration`, { method: "POST", headers: { Cookie: auth.cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(input) })).status, 403);
  const stored = await jsonCall(call, "/api/model-configuration", input);
  assert.equal(JSON.stringify(stored).includes(credential), false); assert.equal(stored.configuration.providers[0].credentialConfigured, true);
  assert.equal(provider.calls.length, 0, "saving is not a provider connectivity test");
  assert.deepEqual((await jsonCall(call, "/api/models")).models, ["local:fixture"]);
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
  const db = new DatabaseSync(join(root, "runtime.db"), { readOnly: true });
  try { assert.equal((db.prepare("SELECT COUNT(*) AS count FROM run_sources WHERE run_id = ? AND source_id = ?").get(second.id, source.id) as { count: number }).count, 1); } finally { db.close(); }
  const restored = await reopen();
  assert.equal((await client(restored.origin, auth)("/api/conversations")).status, 401, "Session is not persisted across restart");
  const restoredCall = client(restored.origin, await session(restored.origin));
  assert.equal((await jsonCall(restoredCall, "/api/runs", input)).run.id, first.id);
  assert.deepEqual((await jsonCall(restoredCall, `/api/runs/${first.id}/events`)).events, events);
  assert.equal((await jsonCall(restoredCall, `/api/sources/${source.id}`)).source.originalName, "notes.txt");
  assert.equal((await jsonCall(restoredCall, `/api/conversations/${first.conversationId}`)).runs.length, 2);
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
  const workspace = new RuntimeWorkspaceService(join(root, "workspace"), { ownerScoped: true });
  await writeFile(join(workspace.forConversation(TEST_OWNER, run.conversationId), "fixture.html"), "<script>throw new Error('must not execute')</script>");
  const database = new DatabaseSync(join(root, "runtime.db"));
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
