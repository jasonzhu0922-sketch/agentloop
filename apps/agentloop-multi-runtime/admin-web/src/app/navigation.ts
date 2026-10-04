import type { AdminPermission, AdminSession } from "../shared/api/admin-api-client.ts";

/** Pages are an Admin Web concern; they do not mirror Router or Runtime modules. */
export type Page = "overview" | "models" | "skills" | "business-users" | "runtime" | "traces" | "audit" | "settings";

export interface NavigationItem {
  readonly id: Page;
  readonly label: string;
  readonly icon: string;
  readonly permission?: AdminPermission;
  readonly group?: string;
}

export const navigationItems: readonly NavigationItem[] = [
  { id: "overview", label: "总览", icon: "▦" },
  { id: "models", label: "模型管理", icon: "◇", permission: "release.read" },
  { id: "skills", label: "Skill 运营", icon: "✦", permission: "skill.read" },
  { id: "business-users", label: "用户管理", icon: "♙", permission: "user.read", group: "业务运营" },
  { id: "runtime", label: "Runtime 运维", icon: "◌", permission: "runtime.operate" },
  { id: "traces", label: "任务跟踪", icon: "⌁", permission: "trace.read", group: "业务运营" },
  { id: "audit", label: "审计记录", icon: "◷", permission: "audit.read" },
  { id: "settings", label: "连接设置", icon: "⚙" },
];

export function hasPermission(session: AdminSession | undefined, permission: AdminPermission): boolean {
  return session?.permissions.includes(permission) === true;
}

export function visibleNavigation(session: AdminSession | undefined): readonly NavigationItem[] {
  return navigationItems.filter((item) => item.permission === undefined || hasPermission(session, item.permission));
}
