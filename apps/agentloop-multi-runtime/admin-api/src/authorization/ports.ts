import type { AdminMemberRole, RuntimeTarget } from "../../../control-plane/contracts/index.ts";

export type AdminPermission =
  | "member.read" | "member.write"
  | "release.read" | "release.write"
  | "skill.read" | "skill.write"
  | "runtime.operate" | "trace.read" | "audit.read";

export interface AdminPrincipal {
  readonly actorId: string;
  readonly role: AdminMemberRole;
  /** Optional identity-provider grants; role permissions are always included. */
  readonly permissions?: readonly AdminPermission[];
  /** Execution scope from the Admin identity provider; omitted only for platform-wide administrators. */
  readonly scopeId?: string;
}

export interface WorkloadPrincipal {
  readonly actorId: string;
  /** Derived from workload/device identity, never accepted from a request body. */
  readonly target: RuntimeTarget;
}

/** Transport-independent authorization seam. A real admin/session and workload identity adapter comes later. */
export interface AdminAuthorizationPort {
  adminPrincipal(authorization: string | undefined): Promise<AdminPrincipal | undefined>;
  workloadPrincipal(authorization: string | undefined): Promise<WorkloadPrincipal | undefined>;
  /** Optional interactive Admin login. Workload and Router authentication never use this seam. */
  login?(username: string, password: string): Promise<{ readonly accessToken: string; readonly expiresAt: number } | undefined>;
}
