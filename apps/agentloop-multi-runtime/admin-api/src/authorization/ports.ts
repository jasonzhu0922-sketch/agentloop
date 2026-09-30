import type { RuntimeTarget } from "../../../control-plane/contracts/index.ts";

export interface AdminPrincipal {
  readonly actorId: string;
  /** Tenant scope from the Admin identity provider; omitted only for platform-wide administrators. */
  readonly tenantId?: string;
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
}
