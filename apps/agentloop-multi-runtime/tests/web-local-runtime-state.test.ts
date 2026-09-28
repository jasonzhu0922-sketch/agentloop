import assert from "node:assert/strict";
import test from "node:test";
import { createLocalRuntimeState } from "../web/local-runtime-state.js";

test("local runtime state keeps device, Runtime, scope, and Agent lifecycle together", () => {
  const state = createLocalRuntimeState();
  state.device = { id: "device-1" };
  state.runtimeId = "runtime-1";
  state.runtimes = [{ id: "runtime-1", status: "ready" }];
  state.scopes = [{ id: "scope-1", status: "active" }];
  state.agentStatus = "online";
  state.agentHealth = { registered: true };
  state.hydratedPreferenceKey = "user-1:device-1";
  state.clear();
  assert.equal(state.device, undefined);
  assert.equal(state.runtimeId, "");
  assert.deepEqual(state.runtimes, []);
  assert.deepEqual(state.scopes, []);
  assert.equal(state.agentStatus, "checking");
  assert.equal(state.agentHealth, undefined);
  assert.equal(state.hydratedPreferenceKey, "");
});
