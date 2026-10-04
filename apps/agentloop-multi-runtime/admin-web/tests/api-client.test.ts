import assert from "node:assert/strict";
import test from "node:test";
import { AdminApiClient } from "../src/shared/api/admin-api-client.ts";

test("Admin Web client is scoped to the Admin API origin", async () => {
  let requested = "";
  const client = new AdminApiClient("https://admin.example.test", async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({ status: "ok", service: "agentloop-admin-api", phase: "wp-1-release-core" }), { status: 200 });
  });
  assert.deepEqual(await client.health(), { status: "ok", service: "agentloop-admin-api", phase: "wp-1-release-core" });
  assert.equal(requested, "https://admin.example.test/healthz");
});

test("Admin Web rejects a healthy response from another service", async () => {
  const client = new AdminApiClient("http://127.0.0.1:8892", async () => (
    new Response(JSON.stringify({ status: "ok", service: "agentloop-runtime-host" }), { status: 200 })
  ));
  await assert.rejects(client.health(), /Unexpected Admin API health response/);
});

test("Admin Web uses typed Admin API reads and never a database transport", async () => {
  const requests: string[] = [];
  const client = new AdminApiClient("https://admin.example.test", async (input) => {
    requests.push(String(input));
    if (String(input).includes("members")) return new Response(JSON.stringify({ members: [] }), { status: 200 });
    if (String(input).includes("audit-events")) return new Response(JSON.stringify({ events: [] }), { status: 200 });
    return new Response(JSON.stringify({ contractVersion: "control-plane/v1", runId: "run-a", facts: [], missingBoundaries: [{ source: "runtime", reason: "not_recorded" }] }), { status: 200 });
  });
  assert.deepEqual(await client.members("tenant-a"), []);
  assert.deepEqual(await client.auditEvents(10), []);
  assert.deepEqual((await client.trace("run-a")).missingBoundaries, [{ source: "runtime", reason: "not_recorded" }]);
  assert.deepEqual(requests, [
    "https://admin.example.test/admin/v1/members?scopeId=tenant-a",
    "https://admin.example.test/admin/v1/audit-events?limit=10",
    "https://admin.example.test/admin/v1/runs/run-a/trace",
  ]);
});

test("Admin Web sends nested model key-value parameters as JSON", async () => {
  let requestBody: unknown;
  const client = new AdminApiClient("https://admin.example.test", async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ releaseId: "model-route-draft" }), { status: 201 });
  });
  await client.registerModel({
    modelKey: "deepseek-v4-flash-2",
    displayName: "DeepSeek v4 Flash 2",
    providerKey: "my-provider",
    providerModel: "DeepSeek-V4-flash",
    baseUrl: "https://models.example.test/v1",
    apiKeyEnv: "MODEL_API_KEY",
    protocol: "chat-completions",
    parameters: { maxOutputTokens: 16_384, chatTemplateKwargs: { thinking: false, effort: "none" } },
  }, "model-register", 3);
  assert.deepEqual((requestBody as { model: { parameters: unknown } }).model.parameters, {
    maxOutputTokens: 16_384,
    chatTemplateKwargs: { thinking: false, effort: "none" },
  });
});

test("Admin Web requests paginated custom Skills and reads a selected detail", async () => {
  const requests: string[] = [];
  const client = new AdminApiClient("https://admin.example.test", async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/admin/v1/skills?")) return new Response(JSON.stringify({ items: [], page: 2, pageSize: 12, total: 0, pageCount: 1 }), { status: 200 });
    return new Response(JSON.stringify({ name: "alpha", description: "Alpha", packageHash: "a".repeat(64), fileCount: 1, totalBytes: 10, skillMd: "# Alpha", files: ["SKILL.md"] }), { status: 200 });
  });
  assert.equal((await client.skills(2, 12)).page, 2);
  assert.equal((await client.skill("alpha")).files[0], "SKILL.md");
  assert.deepEqual(requests, ["https://admin.example.test/admin/v1/skills?page=2&pageSize=12", "https://admin.example.test/admin/v1/skills/alpha"]);
});

test("Admin Web requests paginated Run operations and selected detail through Admin API", async () => {
  const requests: string[] = [];
  const client = new AdminApiClient("https://admin.example.test", async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("?page=")) return new Response(JSON.stringify({ items: [], page: 2, pageSize: 20, total: 0, pageCount: 1 }), { status: 200 });
    return new Response(JSON.stringify({ id: "run-a", status: "completed", artifacts: [], missingBoundaries: [] }), { status: 200 });
  });
  assert.equal((await client.runs(2, 20)).page, 2);
  assert.equal((await client.run("run-a")).id, "run-a");
  assert.deepEqual(requests, ["https://admin.example.test/admin/v1/runs?page=2&pageSize=20", "https://admin.example.test/admin/v1/runs/run-a"]);
});

test("Admin Web reads the current Runtime inventory from the Admin API", async () => {
  let requested = "";
  const client = new AdminApiClient("https://admin.example.test", async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({ items: [{ id: "runtime-a", plane: "cloud", profile: "general", status: "ready", capabilities: [], maxConcurrentRuns: 4, activeRunCount: 0, queuedRunCount: 0, startedAt: 1_000 }], page: 1, pageSize: 20, total: 1, pageCount: 1 }), { status: 200 });
  });
  assert.equal((await client.runtimes()).items[0]?.id, "runtime-a");
  assert.equal(requested, "https://admin.example.test/admin/v1/runtimes?page=1&pageSize=20");
});

test("Admin Web user management stays on the Admin API boundary", async () => {
  const requests: string[] = [];
  let body: unknown;
  const client = new AdminApiClient("https://admin.example.test", async (input, init) => {
    requests.push(String(input));
    body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    if (String(input).endsWith("/admin/v1/users")) return new Response(JSON.stringify({ users: [] }));
    return new Response(JSON.stringify({ contractVersion: "control-plane/v1", userId: "admin-1", username: "ops", displayName: "Ops", role: "platform_admin", status: "active", revision: 1, createdAt: 1, updatedAt: 1 }));
  });
  assert.equal((await client.users())[0], undefined);
  await client.resetUserPassword("admin-1", "a-secure-admin-password", 1, "admin-password-reset");
  assert.deepEqual(requests, ["https://admin.example.test/admin/v1/users", "https://admin.example.test/admin/v1/users/admin-1/password"]);
  assert.deepEqual(body, { password: "a-secure-admin-password", expectedRevision: 1 });
});
