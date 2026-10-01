import type { AdminAuthorizationPort, AdminPrincipal, WorkloadPrincipal } from "./ports.ts";

/** Secure default until an independent admin audience and workload identity adapter is deployed. */
export class DenyAllAuthorization implements AdminAuthorizationPort {
  public async adminPrincipal(_authorization: string | undefined): Promise<AdminPrincipal | undefined> { return undefined; }
  public async workloadPrincipal(_authorization: string | undefined): Promise<WorkloadPrincipal | undefined> { return undefined; }
  public async login(_username: string, _password: string): Promise<undefined> { return undefined; }
}
