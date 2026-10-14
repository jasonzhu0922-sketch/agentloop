/** Pure projection from Local Runtime state to browser control facts. */
export function localRuntimeViewModel({ agentStatus, device, localSessionToken, runtimes, runtimeId, localExecution }) {
  const values = Array.isArray(runtimes) ? runtimes : [];
  const paired = agentStatus === "online" && Boolean(device && localSessionToken);
  const selected = values.find((runtime) => runtime.id === runtimeId);
  const runtimeReady = selected?.status === "ready";
  return {
    paired,
    runtimeReady,
    hasReadyRuntime: values.some((runtime) => runtime.status === "ready"),
    runtimePickerHidden: !paired,
    runtimeDisabled: !paired || !values.some((runtime) => runtime.status === "ready"),
    directoryScopeDisabled: !localExecution || !runtimeReady,
    runtimeManagerHidden: !paired,
    uploadDisabled: Boolean(localExecution && !runtimeReady),
  };
}

export function localRuntimeOptions(values, escapeHtml, runtimeStatusLabel) {
  return (Array.isArray(values) ? values : []).map((runtime) => `<option value="${escapeHtml(runtime.id)}" ${runtime.status === "ready" ? "" : "disabled"}>${runtime.isDefault ? "默认 · " : ""}${escapeHtml(runtime.displayName)} · ${escapeHtml(runtimeStatusLabel(runtime.status))}</option>`).join("");
}

export function localRuntimeListMarkup(values, selectedRuntimeId, escapeHtml, runtimeStatusLabel) {
  return (Array.isArray(values) ? values : []).map((runtime) => {
    const isSelected = runtime.id === selectedRuntimeId;
    const isStopped = runtime.status === "stopped";
    const canDrain = runtime.status === "ready";
    const canRestart = runtime.status !== "stopped" && runtime.status !== "failed" && !runtime.pendingAction;
    const canToggle = runtime.status !== "restarting" && !runtime.pendingAction;
    const canDelete = !runtime.isDefault && !runtime.pendingAction && runtime.activeRunCount === 0;
    const canConfigure = isStopped && !runtime.pendingAction;
    const toggleLabel = isStopped ? "启动" : runtime.status === "draining" && !runtime.pendingAction ? "恢复" : "停止";
    const pending = runtime.pendingAction ? ` · 等待${runtime.pendingAction === "restart" ? "重启" : "停止"}` : "";
    const capabilitySummary = [
      `${Number(runtime.extensionSkillCount || 0)} 个扩展 Skill`,
      `${Number(runtime.mcpServerCount || 0)} 个 MCP`,
    ].join(" · ");
    const menuActions = [
      canConfigure ? `<button type="button" role="menuitem" data-local-runtime-action="configure" data-runtime-id="${escapeHtml(runtime.id)}" title="配置扩展 Skill 和 MCP">配置</button>` : "",
      canDrain ? `<button type="button" role="menuitem" data-local-runtime-action="drain" data-runtime-id="${escapeHtml(runtime.id)}">Drain</button>` : "",
      canRestart ? `<button type="button" role="menuitem" data-local-runtime-action="restart" data-runtime-id="${escapeHtml(runtime.id)}">重启</button>` : "",
      `<button type="button" role="menuitem" data-local-runtime-action="toggle" data-runtime-id="${escapeHtml(runtime.id)}" ${canToggle ? "" : "disabled"}>${toggleLabel}</button>`,
      runtime.isDefault ? "" : `<button type="button" role="menuitem" class="danger" data-local-runtime-action="delete" data-runtime-id="${escapeHtml(runtime.id)}" ${canDelete ? "" : "disabled"} title="${runtime.activeRunCount > 0 ? "有活动任务时不能删除" : runtime.pendingAction ? "生命周期操作完成后才能删除" : "删除并回收独立状态"}">删除</button>`,
    ].filter(Boolean).join("");
    return `<article class="local-runtime-item${isSelected ? " selected" : ""}" role="listitem">
      <button type="button" class="local-runtime-summary" data-local-runtime-action="select" data-runtime-id="${escapeHtml(runtime.id)}" aria-pressed="${isSelected}">
        <span class="local-runtime-heading"><span class="local-runtime-name">${escapeHtml(runtime.displayName)}${runtime.isDefault ? '<b class="runtime-default-badge">默认</b>' : ""}</span><span class="runtime-status runtime-status-${escapeHtml(runtime.status)}">${escapeHtml(runtimeStatusLabel(runtime.status))}</span></span>
        <small class="local-runtime-meta">${runtime.activeRunCount > 0 ? `${runtime.activeRunCount} 个任务${escapeHtml(pending)}` : pending ? escapeHtml(pending.slice(3)) : "当前无活动任务"}</small>
        <small class="local-runtime-capabilities">${escapeHtml(capabilitySummary)}</small>
      </button>
      <div class="local-runtime-actions" aria-label="${escapeHtml(runtime.displayName)} 的操作">
        <button type="button" class="local-runtime-view-action" data-local-runtime-action="view" data-runtime-id="${escapeHtml(runtime.id)}" title="查看 Skill 和 MCP 明细">查看</button>
        <details class="local-runtime-action-menu"><summary aria-label="${escapeHtml(runtime.displayName)} 的更多操作" title="更多操作">•••</summary><div class="local-runtime-action-menu-panel" role="menu">${menuActions}</div></details>
      </div>
    </article>`;
  }).join("");
}
