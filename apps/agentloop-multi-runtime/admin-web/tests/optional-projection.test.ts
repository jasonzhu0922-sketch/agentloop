import assert from "node:assert/strict";
import test from "node:test";
import { optionalProjection } from "../src/app/optional-projection.ts";

test("optional Admin projections preserve the authenticated view when a dependency is unavailable", async () => {
  const failures: string[] = [];
  const value = await optionalProjection("Runs", async () => { throw new Error("503 · configuration_unavailable"); }, { items: [] }, failures, (error) => error instanceof Error ? error.message : "unknown");
  assert.deepEqual(value, { items: [] });
  assert.deepEqual(failures, ["Runs: 503 · configuration_unavailable"]);
});

test("optional Admin projections keep successful data unchanged", async () => {
  const failures: string[] = [];
  const value = await optionalProjection("Runs", async () => ["run-a"], [], failures, String);
  assert.deepEqual(value, ["run-a"]);
  assert.deepEqual(failures, []);
});
