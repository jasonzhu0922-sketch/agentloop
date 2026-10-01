import type { AdminPermission, AdminSession } from "../shared/api/admin-api-client.ts";

/** Pages are an Admin Web concern; they do not mirror Router or Runtime modules. */
export type Page = "overview" | "releases" | "skills" | "members" | "runtime" | "traces" | "audit" | "settings";

export interface NavigationItem {
  readonly id: Page;
  readonly label: string;
  readonly icon: string;
  readonly permission?: AdminPermission;
}

export const navigationItems: readonly NavigationItem[] = [
  { id: "overview", label: "总览", icon: "▦" },
  { id: "releases", label: "配置发布", icon: "◈", permission: "release.read" },
  { id: "skills", label: "Skill 运营", icon: "✦", permission: "skill.read" },
  { id: "members", label: "成员与授权", icon: "♙", permission: "member.read" },
  { id: "runtime", label: "Runtime 运维", icon: "◌", permission: "runtime.operate" },
  { id: "traces", label: "任务追踪", icon: "⌁", permission: "trace.read" },
  { id: "audit", label: "审计记录", icon: "◷", permission: "audit.read" },
  { id: "settings", label: "连接设置", icon: "⚙" },
];

export function hasPermission(session: AdminSession | undefined, permission: AdminPermission): boolean {
  return session?.permissions.includes(permission) === true;
}

export function visibleNavigation(session: AdminSession | undefined): readonly NavigationItem[] {
  return navigationItems.filter((item) => item.permission === undefined || hasPermission(session, item.permission));
}
