import { auditRows, metric, quick } from "../page-helpers.ts";
import type { PageRenderContext } from "../page-context.ts";

export function renderOverviewPage({ state, can }: PageRenderContext): string {
  const active = state.releases.filter((release) => release.state === "active").length;
  const skills = state.releases.filter((release) => release.kind === "skill").length;
  return `<section class="metric-grid">${metric("已发布资源", state.resources.length, "含版本与并发修订")}${metric("生效 Release", active, "状态为 active")}${metric("Skill Release", skills, "受独立 Skill 权限约束")}${metric("活跃管理用户", state.users.filter((user) => user.status === "active").length, "Admin API 登录用户")}</section><section class="two-column"><article class="panel"><div class="panel-title"><div><p>最近配置变更</p><span>来自不可变审计事件</span></div><button class="text-button" data-page="audit">查看全部</button></div>${auditRows(state.audit.slice(0, 5))}</article><article class="panel"><div class="panel-title"><div><p>运维工作台</p><span>按权限开放入口</span></div></div><div class="quick-actions">${can("skill.write") ? quick("Skill 运营", "查看 Skill 目录", "skills") : ""}${can("runtime.operate") ? quick("Runtime 运维", "执行 drain 或 recover", "runtime") : ""}${can("trace.read") ? quick("任务追踪", "查询 Run 的跨边界事实", "traces") : ""}</div></article></section>`;
}
