import assert from "node:assert/strict";
import test from "node:test";
import { parseTurnBudget } from "../src/turn-budgets.ts";

test("turn budgets accept an omitted value or a bounded positive integer", () => {
  assert.equal(parseTurnBudget(undefined, "TEST_BUDGET", 20), undefined);
  assert.equal(parseTurnBudget("  ", "TEST_BUDGET", 20), undefined);
  assert.equal(parseTurnBudget(" 7 ", "TEST_BUDGET", 20), 7);
});

test("turn budgets reject invalid or excessive deployment values", () => {
  for (const value of ["0", "-1", "1.5", "abc", "21", "9007199254740992"]) {
    assert.throws(() => parseTurnBudget(value, "TEST_BUDGET", 20), /TEST_BUDGET/);
  }
});
