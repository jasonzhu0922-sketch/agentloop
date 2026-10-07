import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeActionQueryService } from "../src/runtime/runtime-action-query-service.ts";

test("Action history is read only after the Run authorization boundary", async () => {
  const authorizations: Array<[string, string]> = [];
  const queries = new RuntimeActionQueryService({
    actions: { list: async () => [] },
    authorizeRun: async (actorUserId, runId) => { authorizations.push([actorUserId, runId]); },
  });

  assert.deepEqual(await queries.list("owner", "run-1"), []);
  assert.deepEqual(authorizations, [["owner", "run-1"]]);
});
