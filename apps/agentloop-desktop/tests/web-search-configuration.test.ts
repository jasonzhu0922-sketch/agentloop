import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { accountDataDirectory, desktopRuntimeEnvironment } from "../src/accounts/account-managers.ts";
import { DESKTOP_DEVELOPMENT_ENV_DIRECTORY } from "../src/main.ts";
import { startDesktop } from "../src/application.ts";
import { fixtureAuth, TEST_OWNER } from "./fixtures/auth.ts";
import { modelPort } from "../../../packages/agentloop-local-runtime/tests/fixtures/models.ts";

test("Desktop login, models and ordinary Runs survive a missing saved search credential", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-missing-search-"));
  const skills = join(root, "skills"); await mkdir(skills);
  const dataDirectory = join(root, "desktop");
  const options = { mode: "development" as const, dataDirectory, models: modelPort(), cloudAuth: fixtureAuth(), bundledSkillDirectories: [skills], openBrowser: false };
  let app = await startDesktop(options); assert.equal(app.existing, false);
  t.after(async () => { if (!app.existing) await app.close(); await rm(root, { recursive: true, force: true }); });
  async function login() {
    const response = await fetch(`${app.origin}/api/auth/login`, { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "test@example.test", password: "fixture-only" }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const { csrfToken } = await response.json();
    return async (path: string, body?: unknown) => {
      const result = await fetch(`${app.origin}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: app.origin, "Content-Type": "application/json", "X-Desktop-CSRF": csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.equal(result.status, 200, `${path}: ${await result.clone().text()}`);
      return result.json();
    };
  }
  let call = await login();
  await call("/api/web-search-configuration", { enabled: true, searchProvider: "bocha", searchEndpoint: "https://search.example/v1", searchApiKey: "synthetic-search-key" });
  await app.close();
  const vault = join(accountDataDirectory(dataDirectory, TEST_OWNER), "private", "web-search-secrets");
  for (const file of await readdir(vault)) if (file.endsWith(".json")) await rm(join(vault, file));
  app = await startDesktop(options); assert.equal(app.existing, false);
  call = await login();
  assert.equal((await call("/api/runtimes")).runtimes[0].status, "ready");
  assert.deepEqual(await call("/api/models"), { models: ["local:test"] });
  assert.deepEqual((await call("/api/connectors")).connections, []);
  assert.deepEqual((await call("/api/conversations")).conversations, []);
  const { webSearch } = await call("/api/web-search-configuration");
  assert.deepEqual(webSearch, { enabled: true, searchProvider: "bocha", searchEndpoint: "https://search.example/v1", credentialConfigured: false, unavailableReason: "web_search_credentials_missing" });
  let { run } = await call("/api/runs", { requestId: "missing-search", input: "你好", modelKey: "local:test" });
  for (let count = 0; count < 200 && run.status === "running"; count++) {
    await setTimeout(10); ({ run } = await call(`/api/runs/${run.id}`));
  }
  assert.equal(run.status, "completed");
  const repaired = await call("/api/web-search-configuration", { enabled: true, searchProvider: webSearch.searchProvider, searchEndpoint: webSearch.searchEndpoint, searchApiKey: "replacement-key" });
  assert.equal(repaired.webSearch.credentialConfigured, true);
  assert.equal(repaired.webSearch.unavailableReason, undefined);
  assert.equal((await call("/api/runtimes")).runtimes[0].status, "ready");
});

test("development reads the environment from the Desktop application directory", () => {
  assert.equal(DESKTOP_DEVELOPMENT_ENV_DIRECTORY, fileURLToPath(new URL("..", import.meta.url)));
});

test("Desktop search requires explicit opt-in and reads only search settings", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-web-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await desktopRuntimeEnvironment(root), {});
  await writeFile(join(root, ".env"), "WEB_SEARCH_DISABLED=1\nWEB_SEARCH_API_KEY=secret\n");
  assert.deepEqual(await desktopRuntimeEnvironment(root), {});
  await writeFile(join(root, ".env"), "WEB_SEARCH_DISABLED=0\nWEB_SEARCH_PROVIDER=bocha\nWEB_SEARCH_ENDPOINT=https://search.example/v1\nWEB_SEARCH_API_KEY=secret\nPLANNING_MAX_TURNS=8\nSTEP_MAX_TURNS=64\nOTHER=ignored\n");
  assert.deepEqual(await desktopRuntimeEnvironment(root), { webSearch: { searchProvider: "bocha", searchEndpoint: "https://search.example/v1", searchApiKey: "secret" }, planningMaxTurns: 8, stepMaxTurns: 64 });
  await writeFile(join(root, ".env"), "PLANNING_MAX_TURNS=65\n");
  await assert.rejects(desktopRuntimeEnvironment(root), /planning_max_turns_invalid/);
  await writeFile(join(root, ".env"), "STEP_MAX_TURNS=0\n");
  await assert.rejects(desktopRuntimeEnvironment(root), /step_max_turns_invalid/);
});

test("installed turn defaults can be overridden independently by device configuration", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-turn-defaults-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaults = { planningMaxTurns: 8, stepMaxTurns: 64 };
  assert.deepEqual(await desktopRuntimeEnvironment(root, defaults), defaults);
  await writeFile(join(root, ".env"), "STEP_MAX_TURNS=40\n");
  assert.deepEqual(await desktopRuntimeEnvironment(root, defaults), { planningMaxTurns: 8, stepMaxTurns: 40 });
  await writeFile(join(root, ".env"), "STEP_MAX_TURNS=257\n");
  await assert.rejects(desktopRuntimeEnvironment(root, defaults), /step_max_turns_invalid/);
});

test("packaged search defaults can be disabled or configured on the device", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-web-defaults-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaults = { webSearch: { searchProvider: "baidu" as const } };
  assert.deepEqual(await desktopRuntimeEnvironment(root, defaults), defaults);
  await writeFile(join(root, ".env"), "WEB_SEARCH_DISABLED=1\n");
  assert.deepEqual(await desktopRuntimeEnvironment(root, defaults), {});
  await writeFile(join(root, ".env"), "WEB_SEARCH_DISABLED=0\nWEB_SEARCH_PROVIDER=bocha\nWEB_SEARCH_ENDPOINT=https://search.example/v1\nWEB_SEARCH_API_KEY=secret\n");
  assert.deepEqual(await desktopRuntimeEnvironment(root, defaults), { webSearch: { searchProvider: "bocha", searchEndpoint: "https://search.example/v1", searchApiKey: "secret" } });
});

test("incomplete legacy Bocha environment does not block Desktop startup", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-web-incomplete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".env"), "WEB_SEARCH_DISABLED=0\nWEB_SEARCH_PROVIDER=bocha\nWEB_SEARCH_ENDPOINT=https://search.example/v1\n");
  assert.deepEqual(await desktopRuntimeEnvironment(root), {});
});
