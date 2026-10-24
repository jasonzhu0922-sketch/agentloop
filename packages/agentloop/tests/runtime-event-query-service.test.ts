import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeEventQueryService } from "../src/runtime/runtime-event-query-service.ts";

test("public event reads authorize first and remove provider-private reasoning", async () => {
  const authorizations: Array<[string, string]> = [];
  const queries = new RuntimeEventQueryService({
    runs: {
      eventsByRun: async () => [{
        seq: 7,
        type: "assistant.committed",
        payload_json: JSON.stringify({ content: "visible", privateReasoningContent: "provider-state" }),
        created_at: 70,
      }],
    },
    authorizeRun: async (actorUserId, runId) => { authorizations.push([actorUserId, runId]); },
  });

  const publicEvents = await queries.list("owner", "run-1");
  assert.deepEqual(authorizations, [["owner", "run-1"]]);
  assert.deepEqual(publicEvents, [{ seq: 7, type: "assistant.committed", data: { content: "visible" }, createdAt: 70 }]);

  const storedEvents = await queries.storedForRun("run-1");
  assert.equal(storedEvents[0]?.data.privateReasoningContent, "provider-state");
});

test("latest event reads one durable row without requesting the full ledger", async () => {
  let fullReads = 0;
  let latestReads = 0;
  const queries = new RuntimeEventQueryService({
    runs: {
      eventsByRun: async () => { fullReads++; return []; },
      latestEventByRun: async () => { latestReads++; return { seq: 9, type: "run.completed", payload_json: JSON.stringify({ output: "done" }), created_at: 90 }; },
    },
    authorizeRun: async () => {},
  });
  assert.deepEqual(await queries.latest("owner", "run-1"), { seq: 9, type: "run.completed", data: { output: "done" }, createdAt: 90 });
  assert.equal(latestReads, 1);
  assert.equal(fullReads, 0);
});
