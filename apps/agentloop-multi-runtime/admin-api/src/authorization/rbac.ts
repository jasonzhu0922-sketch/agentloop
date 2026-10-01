import type { AdminMemberRole } from "../../../control-plane/contracts/index.ts";
import type { AdminPermission, AdminPrincipal } from "./ports.ts";

const rolePermissions: Readonly<Record<AdminMemberRole, readonly AdminPermission[]>> = {
  platform_admin: ["member.read", "member.write", "release.read", "release.write", "skill.read", "skill.write", "runtime.operate", "trace.read", "audit.read"],
  tenant_admin: ["member.read", "member.write", "release.read", "release.write", "skill.read", "skill.write", "runtime.operate", "trace.read", "audit.read"],
  operator: ["release.read", "skill.read", "runtime.operate", "trace.read"],
  auditor: ["member.read", "release.read", "skill.read", "trace.read", "audit.read"],
};

export function hasAdminPermission(principal: AdminPrincipal, permission: AdminPermission): boolean {
  return rolePermissions[principal.role].includes(permission) || principal.permissions?.includes(permission) === true;
}

export function permissionsForRole(role: AdminMemberRole): readonly AdminPermission[] {
  return rolePermissions[role];
}
