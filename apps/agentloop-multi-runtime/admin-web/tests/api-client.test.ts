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
