import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudAuthPort, CloudPrincipal, CloudSession } from "../auth/cloud-auth.ts";
import { localAccountId } from "../auth/cloud-auth.ts";

export class HttpError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
export function assertLoopback(request: IncomingMessage, origin: string): void {
  if (request.headers.host !== new URL(origin).host) throw new HttpError(403, "host_rejected");
  if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new HttpError(403, "origin_rejected");
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") throw new HttpError(403, "cross_site_rejected");
  if (!request.url?.startsWith("/") || request.url.startsWith("//")) throw new HttpError(400, "request_target_invalid");
}
export function assertWriteOrigin(request: IncomingMessage, origin: string): void {
  if (request.headers.origin !== origin) throw new HttpError(403, "origin_required");
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) throw new HttpError(415, "json_required");
}
export function securityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
interface Session { token: string; csrf: string; expiresAt: number; ownerUserId: string;
  principal: CloudPrincipal; cloudToken: string; verifiedAt: number; verifying?: Promise<void> }
/** Local transport capabilities bound only to a verified cloud identity. Tokens never enter browser JSON. */
export class AccountSessions {
  readonly cookieName = `agentloop_desktop_${randomBytes(12).toString("hex")}`;
  readonly #sessions = new Map<string, Session>();
  readonly #now: () => number;
  constructor(now: () => number = Date.now) { this.#now = now; }
  private find(request: IncomingMessage): Session | undefined {
    const tokens = (request.headers.cookie ?? "").split(";").map(pair => pair.trim()).filter(pair => pair.startsWith(`${this.cookieName}=`));
    if (tokens.length !== 1) return undefined;
    const session = this.#sessions.get(tokens[0]!.slice(this.cookieName.length + 1));
    if (session === undefined || session.expiresAt <= this.#now()) return undefined;
    return session;
  }
  issue(response: ServerResponse, issuer: string, cloud: CloudSession): Session {
    for (const [key, session] of this.#sessions) if (session.expiresAt <= this.#now()) this.#sessions.delete(key);
    if (this.#sessions.size >= 32) throw new HttpError(429, "session_limit");
    const session = { token: randomBytes(32).toString("base64url"), csrf: randomBytes(32).toString("base64url"),
      expiresAt: Math.min(cloud.expiresAt, this.#now() + 4 * 60 * 60 * 1000), ownerUserId: localAccountId(issuer, cloud.principal),
      principal: cloud.principal, cloudToken: cloud.token, verifiedAt: this.#now() };
    this.#sessions.set(session.token, session);
    // HTTP loopback: deliberately no Secure flag. Target-browser acceptance is
    // required before release; random names prevent cross-instance collisions.
    response.setHeader("Set-Cookie", `${this.cookieName}=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(1, Math.floor((session.expiresAt - this.#now()) / 1000))}`);
    return session;
  }
  require(request: IncomingMessage, write: boolean): Session {
    const session = this.find(request);
    if (!session) throw new HttpError(401, "session_required");
    if (write) {
      const token = request.headers["x-desktop-csrf"];
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(session.csrf))) throw new HttpError(403, "csrf_rejected");
    }
    return session;
  }
  async verify(session: Session, cloud: CloudAuthPort, force = false): Promise<void> {
    if (!force && this.#now() - session.verifiedAt < 60_000) return;
    if (!session.verifying) session.verifying = (async () => {
      try {
        const current = await cloud.current(session.cloudToken);
        if (localAccountId(cloud.issuer, current) !== session.ownerUserId) throw new HttpError(401, "session_invalid");
        session.principal = current; session.verifiedAt = this.#now();
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) this.#sessions.delete(session.token);
        throw error;
      }
    })().finally(() => { session.verifying = undefined; });
    await session.verifying;
    if (!this.#sessions.has(session.token) || session.expiresAt <= this.#now()) throw new HttpError(401, "session_required");
  }
  revoke(session: Session, response: ServerResponse): void {
    this.#sessions.delete(session.token);
    response.setHeader("Set-Cookie", `${this.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }
  clear(): void { this.#sessions.clear(); }
}
