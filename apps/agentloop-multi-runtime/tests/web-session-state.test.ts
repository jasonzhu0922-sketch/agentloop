import assert from "node:assert/strict";
import test from "node:test";
import { createSessionState } from "../web/session-state.js";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  } as unknown as Storage;
}

test("session state keeps identity and Local Agent credentials together but independently", () => {
  const state = createSessionState({ storage: storage(), authTokenKey: "auth", activeUserKey: "user" });
  state.setUser({ id: "u1", email: "u@example.test" });
  state.setLocalSession("local-1", 123);
  assert.equal(state.user?.id, "u1");
  assert.equal(state.localSessionToken, "local-1");
  state.clearLocalSession();
  assert.equal(state.user?.id, "u1");
  assert.equal(state.localSessionToken, "");
});
