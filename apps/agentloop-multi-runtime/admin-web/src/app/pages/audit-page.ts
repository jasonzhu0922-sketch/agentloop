import { auditRows } from "../page-helpers.ts";
import type { PageRenderContext } from "../page-context.ts";

export function renderAuditPage({ state }: PageRenderContext): string { return `<section class="panel"><div class="panel-title"><div><p>审计记录</p><span>不可变操作事实，按记录时间倒序。</span></div><span class="count">${state.audit.length}</span></div>${auditRows(state.audit)}</section>`; }
