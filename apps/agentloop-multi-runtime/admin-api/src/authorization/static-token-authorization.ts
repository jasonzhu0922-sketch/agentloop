import type { AdminMemberRole } from "../../../control-plane/contracts/index.ts";
import type { AdminAuthorizationPort, AdminPrincipal, WorkloadPrincipal } from "./ports.ts";

/**
 * Explicit bootstrap adapter for a local/private Admin API.
 *
 * The secure default remains DenyAllAuthorization. This adapter is only
 * constructed when the process is deliberately started with
 * ADMIN_AUTH_MODE=static and a token supplied out-of-band.
 */
export class StaticTokenAuthorization implements AdminAuthorizationPort {
  private readonly token: string;
  private readonly principal: AdminPrincipal;

  public constructor(input: { readonly token: string; readonly actorId: string; readonly role?: AdminMemberRole; readonly tenantId?: string }) {
    if (input.token.trim().length < 16) throw new TypeError("ADMIN_AUTH_TOKEN must contain at least 16 characters");
    if (input.actorId.trim() === "") throw new TypeError("ADMIN_AUTH_ACTOR_ID must not be empty");
    this.token = input.token;
    this.principal = { actorId: input.actorId, role: input.role ?? "platform_admin", ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }) };
  }

  public async adminPrincipal(authorization: string | undefined): Promise<AdminPrincipal | undefined> {
    return authorization === `Bearer ${this.token}` ? this.principal : undefined;
  }

  public async workloadPrincipal(_authorization: string | undefined): Promise<WorkloadPrincipal | undefined> {
    return undefined;
  }
}
