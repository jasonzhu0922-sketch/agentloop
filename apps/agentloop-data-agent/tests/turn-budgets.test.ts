import assert from "node:assert/strict";
import test from "node:test";
import { parseTurnBudget } from "../src/turn-budgets.ts";

test("turn budgets are optional when the environment is unset", () => {
  assert.equal(parseTurnBudget(undefined, "PLANNING_MAX_TURNS", 64), undefined);
  assert.equal(parseTurnBudget("", "STEP_MAX_TURNS", 256), undefined);
});

test("turn budgets accept configured values within the Runtime ceiling", () => {
  assert.equal(parseTurnBudget("8", "PLANNING_MAX_TURNS", 64), 8);
  assert.equal(parseTurnBudget("64", "STEP_MAX_TURNS", 256), 64);
});

test("turn budgets reject malformed and out-of-range values", () => {
  assert.throws(() => parseTurnBudget("0", "PLANNING_MAX_TURNS", 64), /PLANNING_MAX_TURNS/);
  assert.throws(() => parseTurnBudget("8.0", "PLANNING_MAX_TURNS", 64), /正整数/);
  assert.throws(() => parseTurnBudget("65", "PLANNING_MAX_TURNS", 64), /1 到 64/);
  assert.throws(() => parseTurnBudget("257", "STEP_MAX_TURNS", 256), /1 到 256/);
});
