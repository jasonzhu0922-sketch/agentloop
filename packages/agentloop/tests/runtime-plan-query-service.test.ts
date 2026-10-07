import assert from "node:assert/strict";
import test from "node:test";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import { RuntimePlanQueryService } from "../src/runtime/runtime-plan-query-service.ts";
import { AppDatabase } from "../src/storage/database.ts";

test("Plan read model projects absent Plans without creating or mutating one", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const plans = new PlanRepository(database);
    const pending = new RuntimePlanQueryService({
      plans,
      run: async () => ({ status: "running", createdAt: 42 }),
    });
    const pendingPlan = await pending.read("owner", "run-pending");
    assert.equal(pendingPlan.state, "pending");
    assert.equal(pendingPlan.plan.runId, "run-pending");
    assert.equal(pendingPlan.plan.goal, "Plan is not available yet.");
    assert.deepEqual(pendingPlan.assessments, []);
    assert.equal((await pending.hostProjection("owner", "run-pending")).steps.length, 0);

    const unavailable = new RuntimePlanQueryService({
      plans,
      run: async () => ({ status: "failed", createdAt: 42, finishedAt: 84 }),
    });
    const absentPlan = await unavailable.read("owner", "run-failed");
    assert.equal(absentPlan.state, "unavailable");
    assert.equal(absentPlan.plan.goal, "No Plan was persisted for this Run.");
    assert.equal(absentPlan.plan.updatedAt, 84);
  } finally {
    database.close();
  }
});
