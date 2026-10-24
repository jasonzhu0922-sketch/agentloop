import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOCAL_AGENT_PLANNING_MAX_TURNS,
  DEFAULT_LOCAL_AGENT_STEP_MAX_TURNS,
  localAgentTurnLimits,
} from "../local-agent-runtime/src/config/turn-limits.ts";

test("downloaded Local Agent uses its documented 8/64 defaults without a device env file", () => {
  assert.deepEqual(localAgentTurnLimits({}), {
    planningMaxTurns: DEFAULT_LOCAL_AGENT_PLANNING_MAX_TURNS,
    stepMaxTurns: DEFAULT_LOCAL_AGENT_STEP_MAX_TURNS,
  });
  assert.deepEqual(localAgentTurnLimits({ OTHER_SETTING: "preserved" }), {
    planningMaxTurns: 8,
    stepMaxTurns: 64,
  });
});

test("Local Agent turn budgets still honor explicit device overrides", () => {
  assert.deepEqual(localAgentTurnLimits({ PLANNING_MAX_TURNS: "5", STEP_MAX_TURNS: "70" }), {
    planningMaxTurns: 5,
    stepMaxTurns: 70,
  });
  assert.throws(() => localAgentTurnLimits({ STEP_MAX_TURNS: "0" }), /STEP_MAX_TURNS/);
  assert.throws(() => localAgentTurnLimits({ PLANNING_MAX_TURNS: "65" }), /PLANNING_MAX_TURNS/);
});
