import assert from "node:assert/strict";
import test from "node:test";
import { localRuntimeListMarkup, localRuntimeOptions, localRuntimeViewModel } from "../web/local-runtime-view-model.js";

test("local Runtime view model derives control availability without touching DOM state", () => {
  const model = localRuntimeViewModel({
    agentStatus: "online",
    device: { id: "device-1" },
    localSessionToken: "session",
    runtimes: [{ id: "runtime-1", status: "ready" }],
    runtimeId: "runtime-1",
    localExecution: true,
  });
  assert.deepEqual(model, {
    paired: true,
    runtimeReady: true,
    hasReadyRuntime: true,
    runtimePickerHidden: false,
    runtimeDisabled: false,
    directoryScopeDisabled: false,
    runtimeManagerHidden: false,
    uploadDisabled: false,
  });
});

test("local Runtime option projection disables non-ready entries and preserves selection order", () => {
  const markup = localRuntimeOptions([
    { id: "default", displayName: "默认", status: "ready", isDefault: true },
    { id: "draining", displayName: "研究", status: "draining" },
  ], String, (status) => status);
  assert.match(markup, /value="default"/);
  assert.match(markup, /默认 · 默认/);
  assert.match(markup, /value="draining" disabled/);
});

test("local Runtime manager markup preserves lifecycle affordances as data attributes", () => {
  const markup = localRuntimeListMarkup([
    { id: "default", displayName: "默认", status: "ready", isDefault: true, activeRunCount: 0 },
    { id: "busy", displayName: "忙碌", status: "ready", isDefault: false, activeRunCount: 1 },
  ], "default", String, (status) => status);
  assert.match(markup, /data-local-runtime-action="select" data-runtime-id="default" aria-pressed="true"/);
  assert.match(markup, /data-local-runtime-action="delete" data-runtime-id="busy" disabled/);
  assert.match(markup, /忙碌/);
});
