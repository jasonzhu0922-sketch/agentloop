import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { startDesktop } from "../src/application.ts";
import { accountDataDirectory } from "../src/accounts/account-managers.ts";
import { localAccountId, type CloudAuthPort } from "../src/auth/cloud-auth.ts";
import { modelPort } from "../../../packages/agentloop-local-runtime/tests/fixtures/models.ts";
import { seedMemory, seedRun } from "./fixtures/memory-inspection.ts";

test("the independent memory page serves authenticated, account-scoped read-only queries", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-memory-page-"));
  const skills = join(root, "skills"); await mkdir(skills);
  const dataDirectory = join(root, "data"), issuer = "https://memory.example.test";
  const principal = (email: string) => ({ userId: email, tenantId: "fixture", email });
  const cloudAuth: CloudAuthPort = { issuer,
    async authenticate(_mode, email) { return { token: email, principal: principal(email), expiresAt: Date.now() + 3_600_000 }; },
    async current(token) { return principal(token); }, async logout() {} };
  const app = await startDesktop({ mode: "development", port: 0, dataDirectory, models: modelPort(), cloudAuth, bundledSkillDirectories: [skills], openBrowser: false });
  assert.equal(app.existing, false);
  t.after(async () => { if (!app.existing) await app.close(); await rm(root, { recursive: true, force: true }); });
  const anonymous = await fetch(app.origin + "/api/memory"); assert.equal(anonymous.status, 401);
  const page = await fetch(app.origin + "/memory"); assert.equal(page.status, 200); assert.match(await page.text(), /Run 核对/);
  for (const path of ["/memory.js", "/memory.css"]) assert.equal((await fetch(app.origin + path)).status, 200);
  assert.match(await (await fetch(app.origin)).text(), /href="\/memory" target="_blank" rel="noopener"/);
  async function login(email: string) {
    const response = await fetch(app.origin + "/api/auth/login", { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "fixture-only" }) });
    assert.equal(response.status, 200); const cookie = response.headers.get("set-cookie")!.split(";")[0]!; const { csrfToken } = await response.json();
    return async (path: string, body?: object, expected = 200) => {
      const result = await fetch(app.origin + path, { method: body ? "POST" : "GET", headers: { Cookie: cookie, Origin: app.origin, "Content-Type": "application/json", "X-Desktop-CSRF": csrfToken }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(result.status, expected, `${path}: ${await result.clone().text()}`); return result.json();
    };
  }
  const alice = await login("alice@example.test"); await alice("/api/runtimes");
  const owner = localAccountId(issuer, principal("alice@example.test")), account = accountDataDirectory(dataDirectory, owner);
  const saved = await seedMemory(account, owner); await seedRun(join(account, "runtime.db"), owner);
  const list = await alice("/api/memory?q=中文");
  assert.equal(list.accountId, owner); assert.equal(list.total, 1); assert.equal(list.items[0].id, saved.id);
  const detail = await alice(`/api/memory/items/${saved.id}`); assert.equal(detail.current.revision, 28);
  assert.equal(detail.revisions.length, 25); assert.equal(detail.total, 28);
  const run = await alice("/api/memory/runs?run=memory-run");
  assert.equal(run.detail.projections[0].id, saved.projection!.id); assert.equal(run.detail.events.length, 25);
  assert.equal((await alice("/api/memory/jobs?status=dead_letter")).jobs.length, 1);
  await alice("/api/memory?category=__proto__", undefined, 400);
  await alice("/api/memory/runs?run=abc", undefined, 400);
  await alice("/api/memory", {}, 405);
  await alice("/api/auth/logout", {});
  const bob = await login("bob@example.test");
  assert.equal((await bob("/api/memory")).total, 0);
  await bob(`/api/memory/items/${saved.id}`, undefined, 404);
  assert.deepEqual((await bob("/api/memory/runs?run=memory-run")).matches, []);
  assert.equal((await bob("/api/memory/jobs")).total, 0);
});
