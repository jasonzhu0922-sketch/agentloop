import type { RuntimeInventoryEntry } from "../../../control-plane/contracts/index.ts";
import type { Page } from "./navigation.ts";
import type { AuditRow } from "./ui-state.ts";

export function escape(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

export function text(data: FormData, name: string): string { return String(data.get(name) ?? "").trim(); }

export function metric(label: string, value: number, hint: string): string { return `<article class="metric"><p>${label}</p><strong>${value}</strong><span>${hint}</span></article>`; }
export function quick(title: string, description: string, page: Page): string { return `<button class="quick" data-page="${page}"><strong>${title}</strong><span>${description}</span><b>→</b></button>`; }
export function permissionNote(textValue: string): string { return `<article class="panel muted-panel"><p class="panel-kicker">只读边界</p><h3>操作权限受限</h3><p>${escape(textValue)}</p></article>`; }
export function emptyRow(columns: number, message: string): string { return `<tr><td colspan="${columns}"><div class="empty">${escape(message)}</div></td></tr>`; }

export function statusPill(value: string): string {
  const tone = value === "active" || value === "loaded" ? "success" : value === "draft" || value === "planned" || value === "invited" ? "neutral" : value === "suspended" || value === "rolled_back" || value === "failed" ? "danger" : "warn";
  return `<span class="pill ${tone}">${escape(value)}</span>`;
}

export function runtimeStatusPill(value: RuntimeInventoryEntry["status"]): string {
  const tone = value === "ready" ? "success" : value === "offline" ? "danger" : "warn";
  return `<span class="pill ${tone}">${escape(value)}</span>`;
}

export function auditRows(events: readonly AuditRow[]): string {
  return events.length === 0 ? `<div class="empty">暂无审计记录</div>` : `<div class="activity">${events.map((event) => `<div class="activity-row"><span class="activity-dot"></span><div><strong>${escape(event.action)}</strong><p>${escape(event.actorId)} · ${escape(event.resourceId)}${event.releaseId === undefined ? "" : ` · ${escape(event.releaseId)}`}</p></div><time>${formatTime(event.createdAt)}</time></div>`).join("")}</div>`;
}

export function formatTime(value: number): string { return Number.isFinite(value) && value > 0 ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—"; }
export function formatBytes(value: number): string { if (value < 1_024) return `${value} B`; if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`; return `${(value / (1_024 * 1_024)).toFixed(1)} MB`; }
