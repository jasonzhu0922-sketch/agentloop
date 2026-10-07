import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeHostRunProjectionQueryService } from "../src/runtime/runtime-host-run-projection-query-service.ts";

test("Host Run projection composes durable facts without inferring an Outcome from events or artifacts", async () => {
  const query = new RuntimeHostRunProjectionQueryService({
    run: async () => ({ id: "run-1", status: "completed" }),
    plan: async () => ({
      state: "available", id: "plan-1", version: 2, status: "completed", goal: "deliver",
      selectedSkillIds: [], steps: [], assessmentCount: 1, approvedAssessmentCount: 1,
    }),
    outcome: async () => undefined,
    artifacts: async () => [],
    events: async () => [{ seq: 4, type: "candidate.approved", data: {}, createdAt: 40 }],
  });

  const projection = await query.read("owner", "run-1");
  assert.equal(projection.run.id, "run-1");
  assert.equal(projection.outcome, undefined, "an artifact event is not a canonical Outcome");
  assert.equal(projection.eventCursor.lastSeq, 4);
});
