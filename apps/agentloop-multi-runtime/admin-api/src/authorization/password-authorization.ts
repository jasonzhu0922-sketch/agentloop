import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { AdminMemberRole, RuntimeTarget } from "../../../control-plane/contracts/index.ts";
import type { AdminAuthorizationPort, AdminPrincipal } from "./ports.ts";

type Session = { readonly principal: AdminPrincipal; readonly expiresAt: number };

/**
 * Password login for the independent Admin audience. The configured password is
 * a scrypt hash, never plaintext; issued tokens are opaque, process-local
 * sessions until a durable identity provider is introduced.
 */
export class PasswordAuthorization implements AdminAuthorizationPort {
  private readonly username: string;
  private readonly passwordHash: string;
  private readonly principal: AdminPrincipal;
  private readonly sessionTtlMs: number;
  private readonly sessions = new Map<string, Session>();

  public constructor(input: { readonly username: string; readonly passwordHash: string; readonly actorId: string; readonly role: AdminMemberRole; readonly scopeId?: string; readonly sessionTtlMs?: number }) {
    if (input.username.trim() === "") throw new TypeError("ADMIN_AUTH_USERNAME must not be empty");
    if (input.actorId.trim() === "") throw new TypeError("ADMIN_AUTH_ACTOR_ID must not be empty");
    parseHash(input.passwordHash);
    this.username = input.username;
    this.passwordHash = input.passwordHash;
    this.principal = { actorId: input.actorId, role: input.role, ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }) };
    this.sessionTtlMs = input.sessionTtlMs ?? 8 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 60_000 || this.sessionTtlMs > 24 * 60 * 60 * 1000) throw new TypeError("ADMIN_AUTH_SESSION_TTL_MS must be between 60000 and 86400000");
  }

  public async login(username: string, password: string): Promise<{ readonly accessToken: string; readonly expiresAt: number } | undefined> {
    if (username !== this.username || !verifyPassword(password, this.passwordHash)) return undefined;
    const accessToken = `adm_${randomUUID().replaceAll("-", "")}_${randomBytes(18).toString("hex")}`;
    const expiresAt = Date.now() + this.sessionTtlMs;
    this.sessions.set(accessToken, { principal: this.principal, expiresAt });
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

  public async workloadPrincipal(_authorization: string | undefined): Promise<undefined> { return undefined; }
}

export function hashAdminPassword(password: string): string {
  if (password.length < 12) throw new TypeError("Admin password must contain at least 12 characters");
  const salt = randomBytes(16).toString("hex");
  const digest = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1 }).toString("hex");
  return `scrypt$16384$8$1$${salt}$${digest}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [, n, r, p, salt, expected] = parseHash(encoded);
    const actual = scryptSync(password, salt, expected.length / 2, { N: n, r, p });
    return timingSafeEqual(actual, Buffer.from(expected, "hex"));
  } catch { return false; }
}

function parseHash(encoded: string): [string, number, number, number, string, string] {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") throw new TypeError("ADMIN_AUTH_PASSWORD_HASH must use scrypt$N$r$p$salt$hash format");
  const n = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3]);
  const salt = parts[4]!; const digest = parts[5]!;
  if (![n, r, p].every((value) => Number.isSafeInteger(value) && value > 0) || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(digest)) throw new TypeError("Invalid ADMIN_AUTH_PASSWORD_HASH");
  return [parts[0]!, n, r, p, salt, digest];
}
