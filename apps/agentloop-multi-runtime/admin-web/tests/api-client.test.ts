import assert from "node:assert/strict";
import test from "node:test";
import { AdminApiClient } from "../src/shared/api/admin-api-client.ts";

test("Admin Web client is scoped to the Admin API origin", async () => {
  let requested = "";
  const client = new AdminApiClient("https://admin.example.test", async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  });
  assert.deepEqual(await client.health(), { status: "ok" });
  assert.equal(requested, "https://admin.example.test/healthz");
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
