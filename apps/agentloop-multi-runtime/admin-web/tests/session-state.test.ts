import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_SESSION_TOKEN_KEY, clearAdminSession } from "../src/app/session-state.ts";

test("logout clears the Admin session token", () => {
  const removed: string[] = [];
  clearAdminSession({ removeItem: (key) => removed.push(key) });
  assert.deepEqual(removed, [ADMIN_SESSION_TOKEN_KEY]);
});
