import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { mapWithConcurrencyLimit } from "../src/shared/concurrency.ts";

test("mapWithConcurrencyLimit preserves order while running items concurrently", async () => {
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  const completed: number[] = [];
  const result = await mapWithConcurrencyLimit([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    started.push(value);
    await delay(20 - value * 2);
    completed.push(value);
    active -= 1;
    return value * 10;
  });

  assert.deepEqual(result, [10, 20, 30, 40]);
  assert.equal(peak >= 2, true);
  assert.deepEqual(started, [1, 2, 3, 4]);
  assert.equal(completed.length, 4);
});
