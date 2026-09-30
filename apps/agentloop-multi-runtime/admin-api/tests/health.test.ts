import assert from "node:assert/strict";
import test from "node:test";
import { adminApiHealth } from "../src/transport/admin-http/health.ts";

test("Admin API scaffold exposes only a dependency-free health contract", () => {
  assert.deepEqual(adminApiHealth(), { status: "ok", service: "agentloop-admin-api", phase: "wp-0-scaffold" });
});
