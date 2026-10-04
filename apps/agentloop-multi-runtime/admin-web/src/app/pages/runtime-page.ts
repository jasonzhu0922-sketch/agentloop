import type { RuntimeInventoryEntry } from "../../../../control-plane/contracts/index.ts";
import { escape, emptyRow, formatTime, runtimeStatusPill } from "../page-helpers.ts";
import type { PageRenderContext } from "../page-context.ts";

export function renderRuntimePage({ state }: PageRenderContext): string {
  const page = state.runtimes;
  return `<section class="page-grid runtime-page"><article class="panel wide runtime-list-panel"><div class="panel-title"><div><p>当前 Runtime 实例</p><span>按启动时间倒序；只读数据来自 Router 已登记的 Cloud Host 与已连接的 Local Runtime。</span></div><span class="count">${page.total}</span></div><div class="table-wrap"><table><thead><tr><th>实例</th><th>Plane / Profile</th><th>状态</th><th>容量</th><th>启动时间</th><th>操作</th></tr></thead><tbody>${page.items.length === 0 ? emptyRow(6, "Router 当前没有登记 Runtime 实例") : page.items.map(runtimeRow).join("")}</tbody></table></div><div class="pagination"><button class="ghost" data-action="runtime-page-prev" ${page.page <= 1 ? "disabled" : ""}>上一页</button><span>第 ${page.page} / ${page.pageCount} 页 · 共 ${page.total} 个</span><button class="ghost" data-action="runtime-page-next" ${page.page >= page.pageCount ? "disabled" : ""}>下一页</button></div></article></section>`;
}

function runtimeRow(runtime: RuntimeInventoryEntry): string {
  const name = runtime.displayName ?? runtime.id;
  const capacity = `${runtime.activeRunCount} 活跃 · ${runtime.queuedRunCount} 排队 / ${runtime.maxConcurrentRuns}`;
  const heartbeat = runtime.lastHeartbeatAt === undefined ? "尚未收到心跳" : formatTime(runtime.lastHeartbeatAt);
  const actions = runtime.plane === "local" ? `<span class="muted-text">本地 Runtime 不支持运维操作</span>` : `<button class="text-button danger-link" data-runtime-operation="drain" data-runtime-id="${escape(runtime.id)}">Drain</button><button class="text-button" data-runtime-operation="recover" data-runtime-id="${escape(runtime.id)}">Recover</button><button class="text-button" data-runtime-operation="restart" data-runtime-id="${escape(runtime.id)}">Restart</button>`;
  return `<tr><td><strong>${escape(name)}</strong><small>${escape(runtime.id)}${runtime.deviceId === undefined ? "" : ` · device ${escape(runtime.deviceId)}`}${runtime.scopeId === undefined ? "" : ` · scope ${escape(runtime.scopeId)}`}</small></td><td>${escape(runtime.plane)}<small>${escape(runtime.profile)}${runtime.catalogVersion === undefined ? "" : ` · catalog ${escape(runtime.catalogVersion)}`}</small></td><td>${runtimeStatusPill(runtime.status)}</td><td>${escape(capacity)}<small>${runtime.capabilities.length === 0 ? "未声明 capability" : escape(runtime.capabilities.join(" · "))}</small></td><td>${escape(formatTime(runtime.startedAt))}<small>${escape(heartbeat)}</small></td><td class="actions">${actions}</td></tr>`;
}
