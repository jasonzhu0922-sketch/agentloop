import assert from "node:assert/strict";
import test from "node:test";
import { localRuntimeListMarkup, localRuntimeOptions, localRuntimeViewModel } from "../web/client/local-runtime/local-runtime-view-model.js";

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
    { id: "default", displayName: "默认", status: "ready", isDefault: true, activeRunCount: 0, extensionSkillCount: 0, mcpServerCount: 0 },
    { id: "busy", displayName: "忙碌", status: "ready", isDefault: false, activeRunCount: 1, extensionSkillCount: 1, extensionSkillNames: ["合同审核"], mcpServerCount: 1, mcpServerNames: ["合同库"] },
    { id: "stopped", displayName: "已停止", status: "stopped", isDefault: false, activeRunCount: 0 },
  ], "default", String, (status) => status);
  assert.match(markup, /data-local-runtime-action="select" data-runtime-id="default" aria-pressed="true"/);
  assert.match(markup, /data-local-runtime-action="delete" data-runtime-id="busy" disabled/);
  assert.match(markup, /data-local-runtime-action="view" data-runtime-id="default" title="查看 Skill 和 MCP 明细"/);
  assert.doesNotMatch(markup, /data-local-runtime-action="configure" data-runtime-id="default"/);
  assert.match(markup, /data-local-runtime-action="configure" data-runtime-id="stopped"\s+title="配置扩展 Skill 和 MCP"/);
  assert.match(markup, /class="local-runtime-action-menu"/);
  assert.match(markup, /aria-label="忙碌 的更多操作"/);
  assert.match(markup, /1 个扩展 Skill · 1 个 MCP/);
  assert.doesNotMatch(markup, /合同审核|合同库/);
  assert.match(markup, /忙碌/);
});
