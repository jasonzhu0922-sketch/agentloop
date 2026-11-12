import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, parse } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RuntimeWorkspaceService } from "@zhujun/agentloop";
import { createLocalRuntimeManager, EncryptedLocalRuntimeSecretStore, type LocalModelProviderPort } from "@zhujun/agentloop-local-runtime";
import { localAccountId, type CloudAuthPort } from "../src/auth/cloud-auth.ts";
import { accountDataDirectory, DesktopAccountManagers } from "../src/accounts/account-managers.ts";
import { startDesktop, type DesktopApplication } from "../src/application.ts";
import { claimInstance } from "../src/platform/instance-lock.ts";
import { builtinConnectorModules } from "../src/connectors/builtin-connector-modules.ts";
import { greetingModel, modelPort } from "../../../packages/agentloop-local-runtime/tests/fixtures/models.ts";

const issuer = "https://accounts.isolation.example.test";
const principal = (email: string) => ({ email, userId: email.split("@")[0]!, tenantId: "tenant" });
const owner = (email: string) => localAccountId(issuer, principal(email));
const aliceEmail = "alice@example.test", bobEmail = "bob@example.test";
function cloudAuth(): CloudAuthPort {
  const tokens = new Map<string, ReturnType<typeof principal>>();
  return { issuer, async authenticate(_mode, email) {
    const token = `synthetic-${email}`; const user = principal(email); tokens.set(token, user);
    return { token, principal: user, expiresAt: Date.now() + 3_600_000 };
  }, async current(token) { return tokens.get(token)!; }, async logout(token) { tokens.delete(token); } };
}

test("Skill forms and requirement operations validate revisions and remain account isolated", async t => {
  const f = await start(t); await f.login(aliceEmail);
  const result = await f.json("/api/skills/import", { files: [
    { path: "sample/SKILL.md", contentBase64: Buffer.from("---\nname: requirement-sample\ndescription: Requirement sample\n---\nRead local data.\n").toString("base64") },
    { path: "sample/requirements.txt", contentBase64: Buffer.from("agentloop_test_runtime_dep_0917==1.0\n").toString("base64") },
  ] });
  const pkg = result.skills[0]; assert.equal(pkg.requirementsDiagnosis.status, "attention");
  const metadata = await f.json(`/api/skills/${pkg.packageId}/metadata`);
  assert.ok(metadata.editorSchema.groups.some((group: { id: string }) => group.id === "requirements"));
  const invalid = await f.call(`/api/skills/${pkg.packageId}/metadata`, { declaration: { ...metadata.declaration, workflow: { ...metadata.declaration.workflow, roles: [] } }, revision: metadata.revision });
  assert.equal(invalid.status, 400);
  await f.json(`/api/skills/${pkg.packageId}/metadata`, { declaration: { ...metadata.declaration, requirements: { commands: ["node"] } }, revision: metadata.revision });
  assert.equal((await f.call(`/api/skills/${pkg.packageId}/metadata`, { declaration: metadata.declaration, revision: metadata.revision })).status, 409);
  const report = await f.json(`/api/skills/${pkg.packageId}/requirements/diagnose`, {});
  assert.ok(report.checks.some((check: { label: string }) => check.label === "node"));
  const plan = await f.json(`/api/skills/${pkg.packageId}/requirements/plan`, {}); assert.equal(plan.fingerprint.length, 64);
  // A deliberately stale plan must terminate before invoking pip or changing the Runtime.
  const accepted = await f.call(`/api/skills/${pkg.packageId}/requirements/install`, { fingerprint: "0".repeat(64) });
  assert.equal(accepted.status, 202); const job = await accepted.json();
  let status;
  for (let count = 0; count < 100; count++) {
    status = await f.json(`/api/skill-installations/${job.id}`); if (status.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(status.status, "failed"); assert.equal(status.error, "skill_requirements_plan_stale");
  assert.equal((await f.json("/api/runtimes")).runtimes[0].status, "ready");
  await f.login(bobEmail);
  assert.equal((await f.call(`/api/skills/${pkg.packageId}/requirements/diagnose`, {})).status, 404);
  assert.equal((await f.call(`/api/skills/${pkg.packageId}/requirements/install`, { fingerprint: plan.fingerprint })).status, 404);
  assert.equal((await f.call(`/api/skill-installations/${job.id}`)).status, 404);
});

test("Desktop upload uses the account's saved model order, persists recognition, and bypasses models for package declarations", async t => {
  const calls: Array<{ model: string; authorization?: string }> = [];
  const declaration = {
    schema: "agentloop.skillDeclaration/v1", identity: { name: "model-sample", description: "Analyze local records" },
    activation: { semanticTags: ["record-analysis"], intentExamples: ["分析本地记录"] },
    workflow: { roles: ["primary_builder"], artifactKinds: ["none"], sourceKinds: ["dataset"], qaKinds: [], requiredSkills: [] },
  };
  const provider = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ model: body.model, authorization: request.headers.authorization });
    const content = body.model === "z-first" ? "invalid metadata" : JSON.stringify(declaration);
    if (body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "metadata", choices: [{ delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "metadata", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }));
    }
  })().catch(() => { response.writeHead(500); response.end(); }); });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections(); }));
  const address = provider.address(); assert.ok(address && typeof address !== "string");
  const f = await start(t); await f.login(aliceEmail);
  const original = await f.json("/api/model-configuration");
  await f.json("/api/model-configuration", { revision: original.revision, configuration: { reuseCloudModels: false, providers: [{
    key: "metadata", displayName: "Metadata", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "synthetic-metadata-key",
    models: ["z-first", "b-second", "a-unused"].map(key => ({ key, displayName: key, providerModel: key, protocol: "chat-completions", maxAttempts: 1 })),
  }] } });
  assert.equal(calls.length, 0);
  const skill = Buffer.from("---\nname: model-sample\ndescription: Analyze local records\n---\nRead and analyze a local dataset.\n").toString("base64");
  const upload = (sidecar?: unknown) => f.json("/api/skills/import", { files: [{ path: "sample/SKILL.md", contentBase64: skill },
    ...(sidecar ? [{ path: "sample/agentloop.skill.json", contentBase64: Buffer.from(JSON.stringify(sidecar)).toString("base64") }] : [])] });
  const pkg = (await upload()).skills[0];
  assert.deepEqual(calls.map(call => call.model), ["z-first", "b-second"]);
  assert.ok(calls.every(call => call.authorization === "Bearer synthetic-metadata-key"));
  assert.equal(pkg.metadataGenerationMethod, "deterministic+model"); assert.equal(pkg.metadataGenerationStatus, "completed");
  assert.equal(pkg.metadataModelKey, "local:b-second");
  const metadata = await f.json(`/api/skills/${pkg.packageId}/metadata`);
  assert.deepEqual(metadata.declaration, declaration);
  assert.deepEqual(metadata.generation.attemptedModelKeys, ["local:z-first", "local:b-second"]);
  assert.equal(metadata.fields["workflow.roles"].origin, "suggested");
  await f.reopen(); await f.login(aliceEmail);
  assert.deepEqual((await f.json(`/api/skills/${pkg.packageId}/metadata`)).declaration, declaration);
  assert.equal(calls.length, 2, "reopening must not regenerate metadata");
  await f.login(bobEmail);
  const bob = (await upload()).skills[0];
  assert.equal(bob.metadataGenerationMethod, "deterministic"); assert.equal(bob.metadataGenerationStatus, "fallback");
  assert.equal(calls.length, 2, "another account must not use Alice's model catalog");
  await f.login(aliceEmail);
  const packaged = (await upload(declaration)).skills[0];
  assert.equal(packaged.metadataGenerationMethod, "none"); assert.equal(packaged.metadataGenerationStatus, "not-needed");
  assert.equal(calls.length, 2, "a package declaration must bypass model recognition");
  const storedRoot = join(accountDataDirectory(f.root, owner(aliceEmail)), "skill-library", `uploaded-${(await f.json(`/api/skills/${packaged.packageId}/metadata`)).packageHash}`);
  assert.equal(await readFile(join(storedRoot, "SKILL.md"), "base64"), skill);
  assert.deepEqual(JSON.parse(await readFile(join(storedRoot, "agentloop.skill.json"), "utf8")), declaration);
});

test("upload and diagnosis preserve Runtime choices; multiple Runtimes independently select a shared Skill", async t => {
  const f = await start(t); await f.login(aliceEmail);
  const initialConfiguration = await f.json("/api/runtimes/desktop-default/configuration");
  const uploaded = (await f.json("/api/skills/import", { files: [{ path: "shared/SKILL.md", contentBase64: Buffer.from("---\nname: shared-skill\ndescription: Shared library skill\n---\nFollow the instructions.\n").toString("base64") }] })).skills[0];
  const initial = await f.json(`/api/skills/${uploaded.packageId}/setup`, {});
  assert.equal(initial.scope, "device"); assert.equal(initial.modelsConfigured, false);
  assert.deepEqual(initial.selectedBy, []); assert.equal(initial.requirements.scope, "device");
  assert.equal(initial.requirements.status, "satisfied");
  assert.deepEqual(await f.json("/api/runtimes/desktop-default/configuration"), initialConfiguration);
  assert.equal((await f.call(`/api/skills/${uploaded.packageId}/setup`, { runtimeId: "desktop-default" })).status, 400);
  assert.equal((await f.call(`/api/skills/${uploaded.packageId}/requirements/diagnose`, { runtimeId: "desktop-default" })).status, 400);
  assert.equal((await f.call(`/api/skills/${uploaded.packageId}/bind`, { runtimeId: "desktop-default", revision: initialConfiguration.revision })).status, 404);
  const second = (await f.json("/api/runtimes", { displayName: "Another Runtime" })).runtime;
  async function choose(id: string, skills: string[]) {
    if ((await f.json("/api/runtimes")).runtimes.find((runtime: any) => runtime.id === id).status !== "stopped") await f.json(`/api/runtimes/${id}/stop`, {});
    const settings = await f.json(`/api/runtimes/${id}/configuration`);
    await f.json(`/api/runtimes/${id}/configuration`, { revision: settings.revision, configuration: { iconKey: settings.configuration.iconKey, skillPackageIds: skills, mcpServerIds: settings.configuration.mcpServerIds } });
  }
  await choose("desktop-default", [uploaded.packageId]); await choose(second.id, [uploaded.packageId]);
  assert.deepEqual((await f.json(`/api/skills/${uploaded.packageId}/setup`, {})).selectedBy.map((r: any) => r.id).sort(), ["desktop-default", second.id].sort());
  await choose(second.id, []);
  assert.deepEqual((await f.json("/api/runtimes/desktop-default/configuration")).configuration.skills.map((skill: any) => skill.packageId), [uploaded.packageId]);
  assert.deepEqual((await f.json(`/api/skills/${uploaded.packageId}/setup`, {})).selectedBy.map((r: any) => r.id), ["desktop-default"]);
  await f.json(`/api/runtimes/${second.id}/remove`, {});
  assert.equal((await f.json(`/api/skills/${uploaded.packageId}/setup`, {})).metadata.packageId, uploaded.packageId);
  await f.login(bobEmail);
  assert.equal((await f.call(`/api/skills/${uploaded.packageId}/setup`, {})).status, 404);
});
async function start(t: test.TestContext, root?: string, models?: LocalModelProviderPort, directoryPicker?: () => Promise<string | undefined>) {
  root ??= await mkdtemp(join(tmpdir(), "desktop-account-isolation-"));
  const claim = await claimInstance(root, "development");
  if (claim.existing) throw new Error("unexpected_instance"); await claim.lock.release();
  const skills = join(root, "bundled"); await mkdir(skills, { recursive: true });
  const options = { mode: "development" as const, dataDirectory: root, openBrowser: false,
    cloudAuth: cloudAuth(), models, bundledSkillDirectories: [skills], connectorModules: builtinConnectorModules(), directoryPicker };
  let app: DesktopApplication = await startDesktop(options);
  t.after(async () => {
    if (!app.existing) await app.close();
    const makeWritable = async (path: string): Promise<void> => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) await makeWritable(join(path, entry.name));
      }
    };
    await makeWritable(root!);
    await rm(root!, { recursive: true, force: true });
  });
  let auth: { cookie: string; csrf: string } | undefined;
  const call = async (path: string, body?: unknown) => fetch(app.origin + path, {
    method: body === undefined ? "GET" : "POST", headers: { ...auth && { Cookie: auth.cookie },
      ...body !== undefined && { Origin: app.origin, "Content-Type": "application/json", ...auth && { "X-Desktop-CSRF": auth.csrf } } },
    ...body !== undefined && { body: JSON.stringify(body) },
  });
  const json = async (path: string, body?: unknown) => { const response = await call(path, body); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result; };
  const login = async (email: string) => {
    if (auth) { await json("/api/auth/logout", {}); auth = undefined; }
    const response = await call("/api/auth/login", { email, password: "synthetic-fixture-password" });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
    auth = { cookie: response.headers.get("set-cookie")!.split(";")[0]!, csrf: body.csrfToken }; return body;
  };
  return { root, call, json, login, close: async () => { if (!app.existing) await app.close(); }, reopen: async () => {
    if (!app.existing) await app.close(); app = await startDesktop(options); auth = undefined;
  } };
}

test("native storage selection remains account scoped and survives restart", async t => {
  const parent = await mkdtemp(join(tmpdir(), "desktop-selected-storage-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  let selected: string | undefined = parent;
  const f = await start(t, undefined, undefined, async () => selected);
  await f.login(aliceEmail);
  const original = (await f.json("/api/device-storage")).storage;
  selected = undefined;
  assert.equal((await f.json("/api/device-storage/pick", { kind: "workspace" })).path, null);
  selected = parent;
  const alice = (await f.json("/api/device-storage/pick", { kind: "workspace" })).path;
  assert.equal(alice, join(await realpath(parent), ".agentloop-desktop", owner(aliceEmail), "workspace"));
  await f.json("/api/device-storage", { ...original, workspaceRoot: alice });
  await f.login(bobEmail);
  const bobOriginal = (await f.json("/api/device-storage")).storage;
  assert.equal((await f.call("/api/device-storage", { ...bobOriginal, workspaceRoot: alice })).status, 403);
  selected = alice;
  assert.equal((await f.call("/api/device-storage/pick", { kind: "workspace" })).status, 403);
  selected = parent;
  const bob = (await f.json("/api/device-storage/pick", { kind: "workspace" })).path;
  assert.notEqual(alice, bob);
  await f.json("/api/device-storage", { ...bobOriginal, workspaceRoot: bob });
  await f.reopen(); await f.login(aliceEmail);
  assert.equal((await f.json("/api/device-storage")).storage.workspaceRoot, alice);
  await f.login(bobEmail);
  assert.equal((await f.json("/api/device-storage")).storage.workspaceRoot, bob);
});
function configuration(key: string) {
  return { reuseCloudModels: false, providers: [{ key, displayName: key, baseUrl: "https://models.example.test/v1", apiKey: `synthetic-${key}-key`,
    models: [{ key, displayName: key, providerModel: key, protocol: "responses", contextWindowTokens: 128000, maxOutputTokens: 8192 }] }] };
}

test("account configuration, vaults and Runtime management stay isolated across switching and restart", async t => {
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", ((input: string | URL | Request, init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : String(input)).hostname === "models.example.test") return Promise.reject(new Error("synthetic offline provider"));
    return nativeFetch(input, init);
  }) as typeof fetch);
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
  const f = await start(t);
  await f.login(aliceEmail);
  const initial = await f.json("/api/model-configuration");
  await f.json("/api/model-configuration", { configuration: configuration("alice"), revision: initial.revision });
  const { runtime } = await f.json("/api/runtimes", { displayName: "Alice Runtime" });
  const { server } = await f.json("/api/mcp", { server: { displayName: "Alice MCP", key: "alice-service", transport: "http", url: `http://127.0.0.1:${address.port}/alice`, auth: { kind: "bearer", token: "synthetic-alice-mcp-key" } } });
  const imported = await f.json("/api/skills/import", { files: [{ path: "private-skill/SKILL.md", contentBase64: Buffer.from("---\nname: private-skill\ndescription: Alice private skill\n---\n# Private\nUse Alice's template.\n").toString("base64") }] });
  assert.equal(imported.skills.length, 1);
  const { connector } = await f.json("/api/connectors", { connector: { connectorKey: "126-mail", displayName: "Alice mail", enabled: false, scopes: [], credentials: { TOKEN: "synthetic-alice-mail-key" } } });
  const aStorage = (await f.json("/api/device-storage")).storage;
  const aRoot = await realpath(accountDataDirectory(f.root, owner(aliceEmail)));
  assert.equal(aStorage.workspaceRoot, join(aRoot, "storage", "workspace"));
  await f.login(bobEmail);
  assert.deepEqual((await f.json("/api/model-configuration")).configuration.providers, []);
  assert.deepEqual((await f.json("/api/models")).models, []);
  assert.deepEqual((await f.json("/api/mcp")).servers, []);
  assert.deepEqual((await f.json("/api/skills")).skills, []);
  assert.deepEqual((await f.json("/api/connectors")).connections, []);
  assert.equal((await f.json("/api/runtimes")).runtimes.length, 1);
  for (const action of ["rename", "start", "stop", "drain", "restart", "remove", "configuration"]) {
    const response = await f.call(`/api/runtimes/${runtime.id}/${action}`, action === "rename" ? { displayName: "stolen" }
      : action === "configuration" ? { configuration: { skillPackageIds: [], mcpServerIds: [] }, revision: "stale" } : {});
    assert.equal(response.status, 404, action);
  }
  assert.equal((await f.call(`/api/runtimes/${runtime.id}/configuration`)).status, 404);
  assert.equal((await f.call(`/api/mcp/${server.id}/remove`, {})).status, 404);
  assert.equal((await f.call(`/api/connectors/${connector.id}/remove`, {})).status, 404);
  assert.equal((await f.call(`/api/skills/${imported.skills[0].packageId}/metadata`)).status, 404);
  assert.equal((await f.call("/api/device-storage", aStorage)).status, 403);
  const bStorage = (await f.json("/api/device-storage")).storage;
  await f.json("/api/runtimes/desktop-default/stop", {});
  await symlink(join(aRoot, "storage"), join(bStorage.workspaceRoot, "escape"));
  assert.equal((await f.call("/api/device-storage", { ...bStorage, workspaceRoot: join(bStorage.workspaceRoot, "escape", "workspace") })).status, 403);
  const bModel = await f.json("/api/model-configuration");
  await f.json("/api/model-configuration", { configuration: configuration("bob"), revision: bModel.revision });
  const bRoot = accountDataDirectory(f.root, owner(bobEmail));
  const aKey = await readFile(join(aRoot, "private", "model-secrets", "master.key"));
  const bKey = await readFile(join(bRoot, "private", "model-secrets", "master.key"));
  assert.notDeepEqual(aKey, bKey);
  await f.reopen(); await f.login(aliceEmail);
  assert.deepEqual((await f.json("/api/models")).models, ["local:alice"]);
  assert.ok((await f.json("/api/runtimes")).runtimes.some((row: { id: string }) => row.id === runtime.id));
  assert.equal((await f.json("/api/runtimes")).runtimes.find((row: { id: string }) => row.id === "desktop-default").status, "ready");
  assert.equal((await f.json("/api/mcp")).servers[0].id, server.id);
  assert.equal((await f.json("/api/skills")).skills.length, 1);
  assert.equal((await f.json("/api/connectors")).connections[0].id, connector.id);
  const db = new DatabaseSync(join(bRoot, "supervisor.db"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM local_device_mcp_servers").get()!.n, 0); } finally { db.close(); }
});

test("legacy owner data migrates once without copying another account or unowned shared credentials", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-legacy-owners-"));
  const claim = await claimInstance(root, "development"); assert.equal(claim.existing, false);
  if (claim.existing) throw new Error("unexpected_instance"); await claim.lock.release();
  const skills = join(root, "bundled"); await mkdir(skills);
  const legacy = await createLocalRuntimeManager({ dataDirectory: root, defaultRuntimeId: "desktop-default", models: modelPort(),
    bundledSkillDirectories: [skills], connectorModules: builtinConnectorModules(),
    secrets: new EncryptedLocalRuntimeSecretStore(join(root, "private", "mcp-secrets")) });
  const ids: Record<string, { id: string; conversationId?: string }> = {};
  for (const email of [aliceEmail, bobEmail]) {
    const context = { ownerUserId: owner(email) }; const runtime = legacy.runtime("desktop-default");
    const run = await runtime.startRun(context, { requestId: "same-request", input: `private-${email}`, modelKey: "local:test", allowDangerousTools: true });
    for (let attempt = 0; (await runtime.getRun(context, run.id)).status === "running" && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    ids[email] = run;
    await runtime.upload(context, { conversationId: run.conversationId, originalName: `${email}.txt`, content: Buffer.from(`source-${email}`) });
  }
  await legacy.configureDeviceMcpServer({ displayName: "Unowned legacy MCP", key: "legacy", transport: "http", url: "https://mcp.example.test/legacy", auth: { kind: "bearer", token: "synthetic-unowned-legacy-key" } });
  await legacy.configureConnector(owner(aliceEmail), { connectorKey: "126-mail", displayName: "Owned legacy mail", enabled: false, scopes: [], credentials: { TOKEN: "synthetic-owned-legacy-key" } });
  await legacy.close();
  const workspace = new RuntimeWorkspaceService(join(root, "workspace"), { ownerScoped: true });
  await writeFile(join(workspace.forConversation(owner(aliceEmail), ids[aliceEmail]!.conversationId!), "legacy.html"), "<html>alice-owned-file</html>");
  const before = await readFile(join(root, "runtime.db"));
  const f = await start(t, root);
  const session = await f.login(aliceEmail); assert.equal(session.migration.legacySharedConfiguration, true);
  assert.equal((await f.json("/api/conversations")).conversations.length, 1);
  assert.equal((await f.json(`/api/runs/${ids[aliceEmail]!.id}`)).run.id, ids[aliceEmail]!.id);
  assert.equal((await f.call(`/api/runs/${ids[bobEmail]!.id}`)).status, 404);
  assert.deepEqual((await f.json("/api/mcp")).servers, []);
  assert.equal((await f.json("/api/connectors")).connections[0].credentialConfigured, true);
  const aRoot = accountDataDirectory(root, owner(aliceEmail));
  const db = new DatabaseSync(join(aRoot, "runtime.db"), { readOnly: true });
  let sourcePath: string;
  try {
    assert.deepEqual(db.prepare("SELECT DISTINCT owner_user_id FROM runs").all().map(row => row.owner_user_id), [owner(aliceEmail)]);
    sourcePath = String(db.prepare("SELECT storage_path FROM sources").get()!.storage_path);
    assert.match(sourcePath, /accounts\/cloud_.*\/storage\/uploads/);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { db.close(); }
  assert.equal(await readFile(sourcePath!, "utf8"), `source-${aliceEmail}`);
  const migratedWorkspace = new RuntimeWorkspaceService(join(aRoot, "storage", "workspace"), { ownerScoped: true });
  assert.match(await readFile(join(migratedWorkspace.forConversation(owner(aliceEmail), ids[aliceEmail]!.conversationId!), "legacy.html"), "utf8"), /alice-owned-file/);
  assert.equal((await readFile(join(aRoot, "runtime.db"))).includes(Buffer.from(`private-${bobEmail}`)), false, "vacuum removes the other account's deleted SQLite pages");
  assert.deepEqual(await readFile(join(root, "runtime.db")), before, "legacy data is not changed");
  await f.login(bobEmail);
  assert.equal((await f.json("/api/conversations")).conversations.length, 1);
  assert.equal((await f.call(`/api/runs/${ids[aliceEmail]!.id}`)).status, 404);
  assert.deepEqual((await f.json("/api/connectors")).connections, []);
  await f.reopen(); await f.login(aliceEmail);
  assert.equal((await f.json("/api/conversations")).conversations.length, 1);
  assert.equal((await readdir(join(root, "accounts"))).some(name => name.startsWith(".pending-")), false);
});

test("one account's active or unwinding Run cannot partially close another account", async t => {
  let release!: () => void, enter!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const base = greetingModel();
  const f = await start(t, undefined, modelPort({ ...base, async complete(input, signal) {
    if (input.runId.startsWith("skill-metadata:")) return base.complete(input, signal);
    enter(); await blocked; return base.complete(input, signal);
  } }));
  await f.login(aliceEmail); await f.login(bobEmail);
  const uploaded = (await f.json("/api/skills/import", { files: [{ path: "idle-only/SKILL.md", contentBase64: Buffer.from("---\nname: idle-only\ndescription: Shared resource sample\n---\nFollow the instructions.\n").toString("base64") }] })).skills[0];
  await f.json(`/api/skills/${uploaded.packageId}/setup`, {});
  const { run } = await f.json("/api/runs", { requestId: "blocked", input: "synthetic greeting", modelKey: "local:test" });
  await entered;
  try {
    const install = await f.call(`/api/skills/${uploaded.packageId}/requirements/install`, { fingerprint: "0".repeat(64) });
    assert.equal(install.status, 202);
    let job = await install.json();
    for (let attempts = 0; attempts < 100 && job.status === "running"; attempts++) {
      await new Promise(resolve => setTimeout(resolve, 10)); job = await f.json(`/api/skill-installations/${job.id}`);
    }
    assert.equal(job.status, "failed"); assert.equal(job.error, "runtime_active_runs_prevent_reconfiguration");
    assert.deepEqual((await f.json("/api/runtimes/desktop-default/configuration")).configuration.skills, []);
    await assert.rejects(f.close(), /runtime_active_runs_prevent_close/);
    await f.login(aliceEmail);
    await f.json("/api/runtimes/desktop-default/rename", { displayName: "Alice still usable" });
    await f.json("/api/conversations");
    await f.login(bobEmail); await f.json(`/api/runs/${run.id}/cancel`, {});
    await assert.rejects(f.close(), /runtime_active_runs_prevent_close/);
    await f.login(aliceEmail); await f.json("/api/conversations");
  } finally { release(); }
  await new Promise(resolve => setTimeout(resolve, 50));
  await f.close();
});

test("failed legacy file migration is atomic and a child-only account retains its default Runtime", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-migration-atomic-"));
  let accounts: DesktopAccountManagers | undefined;
  t.after(async () => { await accounts?.close(); await rm(root, { recursive: true, force: true }); });
  const bundled = join(root, "bundled"); await mkdir(bundled);
  const options = { dataDirectory: root, defaultRuntimeId: "desktop-default", models: modelPort(), bundledSkillDirectories: [bundled] };
  const legacy = await createLocalRuntimeManager(options);
  const child = await legacy.createRuntime("Owned child only");
  const context = { ownerUserId: owner(aliceEmail) };
  const runtime = legacy.runtime(child.id);
  const run = await runtime.startRun(context, { requestId: "child-only", input: "synthetic greeting", modelKey: "local:test" });
  for (let attempt = 0; (await runtime.getRun(context, run.id)).status === "running" && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  await legacy.close();
  const workspace = new RuntimeWorkspaceService(join(root, "workspace"), { ownerScoped: true });
  const link = join(workspace.forConversation(context.ownerUserId, run.conversationId!), "foreign-link");
  await symlink(join(root, "supervisor.db"), link);
  // The storage key is persisted independently from the public Runtime ID.
  const supervisor = new DatabaseSync(join(root, "supervisor.db"), { readOnly: true });
  const key = String(supervisor.prepare("SELECT storage_key FROM local_runtime_instances WHERE runtime_id=?").get(child.id)!.storage_key);
  supervisor.close();
  const sourcePath = join(root, "runtimes", key, "agentloop.db");
  const before = await readFile(sourcePath);
  accounts = new DesktopAccountManagers(options); await accounts.ready();
  await assert.rejects(accounts.forOwner(context.ownerUserId), /account_data_migration_failed/);
  assert.deepEqual(await readdir(join(root, "accounts")), []);
  assert.deepEqual(await readFile(sourcePath), before);
  await rm(link);
  const migrated = await accounts.forOwner(context.ownerUserId);
  assert.ok((await migrated.runtimes()).some(row => row.isDefault));
  assert.equal((await migrated.runtime(child.id).getRun(context, run.id)).id, run.id);
  assert.deepEqual(await readFile(sourcePath), before);
});

test("host tool search paths cannot grant filesystem root or account databases to commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-tool-boundary-"));
  const link = join(root, "tool-link");
  await symlink(parse(root).root, link);
  try {
    for (const path of [parse(root).root, root, link]) {
      const accounts = new DesktopAccountManagers({ dataDirectory: root, defaultRuntimeId: "desktop-default",
        computerCommandEnvironment: { NODE_PATH: path } });
      try {
        await accounts.ready();
        await assert.rejects(accounts.forOwner(owner(aliceEmail)), /desktop_tool_directory_invalid/);
      } finally { await accounts.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("Skill replacement keeps bindings and removal enforces account and reference boundaries", async t => {
  const f = await start(t); await f.login(aliceEmail);
  const upload = (description: string) => f.json("/api/skills/import", { files: [{ path: "sample/SKILL.md", contentBase64: Buffer.from(`---\nname: sample\ndescription: ${description}\n---\n# Sample\n${description}\n`).toString("base64") }] });
  const first = (await upload("first version")).skills[0];
  await f.json("/api/runtimes/desktop-default/stop", {});
  const stopped = await f.json("/api/runtimes/desktop-default/configuration");
  await f.json("/api/runtimes/desktop-default/configuration", { configuration: { skillPackageIds: [first.packageId], mcpServerIds: [], iconKey: stopped.configuration.iconKey }, revision: stopped.revision });
  await f.json("/api/runtimes/desktop-default/start", {});
  const blocked = await f.call("/api/skills/import", { files: [{ path: "sample/SKILL.md", contentBase64: Buffer.from("---\nname: sample\ndescription: blocked version\n---\n# Sample\n").toString("base64") }] });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, "skill_runtime_active");
  await f.json("/api/runtimes/desktop-default/stop", {});
  const second = (await upload("second version")).skills[0];
  assert.equal(second.packageId, first.packageId);
  assert.equal((await f.json("/api/skills")).skills.length, 1);
  assert.equal(second.description, "second version");
  assert.equal((await f.json("/api/runtimes/desktop-default/configuration")).configuration.skills[0].packageId, first.packageId);
  assert.equal((await f.call(`/api/skills/${first.packageId}/remove`, {})).status, 409);
  await f.reopen(); await f.login(aliceEmail);
  assert.equal((await f.json("/api/skills")).skills[0].description, "second version");
  await f.login(bobEmail);
  assert.equal((await f.call(`/api/skills/${first.packageId}/remove`, {})).status, 404);
  await f.login(aliceEmail);
  const current = await f.json("/api/runtimes/desktop-default/configuration");
  await f.json("/api/runtimes/desktop-default/configuration", { configuration: { skillPackageIds: [], mcpServerIds: [], iconKey: current.configuration.iconKey }, revision: current.revision });
  await f.json(`/api/skills/${first.packageId}/remove`, {});
  assert.deepEqual((await f.json("/api/skills")).skills, []);
});
