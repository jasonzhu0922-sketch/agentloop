import { randomBytes, randomUUID } from "node:crypto";
import type { AdminMemberRole, RuntimeTarget } from "../../../control-plane/contracts/index.ts";
import type { AdminAuthorizationPort, AdminPrincipal, AdminUserCredentialPort, WorkloadPrincipal } from "./ports.ts";
import { verifyAdminPassword } from "./password-authorization.ts";

type Session = { readonly principal: AdminPrincipal; readonly expiresAt: number };

/** Password authentication backed by Admin-owned users in the Admin TiDB database. */
export class DatabaseAdminAuthorization implements AdminAuthorizationPort {
  private readonly users: AdminUserCredentialPort;
  private readonly fallback?: { readonly username: string; readonly passwordHash: string; readonly actorId: string; readonly role: AdminMemberRole; readonly scopeId?: string };
  private readonly sessionTtlMs: number;
  private readonly sessions = new Map<string, Session>();

  public constructor(input: { readonly users: AdminUserCredentialPort; readonly sessionTtlMs?: number; readonly fallback?: { readonly username: string; readonly passwordHash: string; readonly actorId: string; readonly role: AdminMemberRole; readonly scopeId?: string } }) {
    this.users = input.users;
    this.fallback = input.fallback;
    this.sessionTtlMs = input.sessionTtlMs ?? 8 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 60_000 || this.sessionTtlMs > 24 * 60 * 60 * 1000) throw new TypeError("ADMIN_AUTH_SESSION_TTL_MS must be between 60000 and 86400000");
  }

  public async login(username: string, password: string): Promise<{ readonly accessToken: string; readonly expiresAt: number } | undefined> {
    const credential = await this.users.findAdminUserCredential(username);
    const fallback = credential === undefined && this.fallback?.username === username ? this.fallback : undefined;
    const valid = credential === undefined
      ? fallback !== undefined && verifyAdminPassword(password, fallback.passwordHash)
      : credential.status === "active" && verifyAdminPassword(password, credential.passwordHash);
    if (!valid) return undefined;
    if (credential !== undefined) {
      try { await this.users.recordAdminUserLogin?.(credential.userId, Date.now()); } catch { /* login remains authoritative; timestamp is a projection */ }
    }
    const principal: AdminPrincipal = credential === undefined
      ? { actorId: fallback!.actorId, role: fallback!.role, ...(fallback!.scopeId === undefined ? {} : { scopeId: fallback!.scopeId }) }
      : { actorId: credential.userId, role: credential.role, ...(credential.scopeId === undefined ? {} : { scopeId: credential.scopeId }) };
    const accessToken = `adm_${randomUUID().replaceAll("-", "")}_${randomBytes(18).toString("hex")}`;
    const expiresAt = Date.now() + this.sessionTtlMs;
    this.sessions.set(accessToken, { principal, expiresAt });
    return { accessToken, expiresAt };
  }

  public async adminPrincipal(authorization: string | undefined): Promise<AdminPrincipal | undefined> {
    if (authorization === undefined || !authorization.startsWith("Bearer ")) return undefined;
    const token = authorization.slice("Bearer ".length);
    const session = this.sessions.get(token);
    if (session === undefined) return undefined;
    if (session.expiresAt <= Date.now()) { this.sessions.delete(token); return undefined; }
    return session.principal;
  }

  public async workloadPrincipal(_authorization: string | undefined): Promise<WorkloadPrincipal | undefined> { return undefined; }
}
