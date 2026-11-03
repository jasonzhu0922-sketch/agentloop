import { createHash } from "node:crypto";
import { IdentityError } from "./service.ts";

export interface CloudPrincipal { readonly userId: string; readonly tenantId: string; readonly email: string }
export interface CloudSession { readonly token: string; readonly expiresAt: number; readonly principal: CloudPrincipal }
/** Identity only. Local conversations, models, files and Run evidence never cross this port. */
export interface CloudAuthPort {
  readonly issuer: string;
  authenticate(mode: "login" | "register", email: string, password: string): Promise<CloudSession>;
  current(token: string): Promise<CloudPrincipal>;
  logout(token: string): Promise<void>;
}
export function authBaseUrl(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new Error("desktop_auth_url_invalid"); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || /[?#]/.test(value)) throw new Error("desktop_auth_url_invalid");
  return url.href.replace(/\/+$/, "");
}
export function localAccountId(issuer: string, principal: CloudPrincipal): string {
  return `cloud_${createHash("sha256").update(JSON.stringify([issuer, principal.tenantId, principal.userId])).digest("hex")}`;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IdentityError(502, "cloud_auth_response_invalid");
  return value as Record<string, unknown>;
}
function principal(value: unknown): CloudPrincipal {
  const body = record(value), user = record(body.user), tenant = record(body.tenant);
  if (typeof user.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(user.id)
    || typeof tenant.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(tenant.id)
    || typeof user.email !== "string" || user.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) throw new IdentityError(502, "cloud_auth_response_invalid");
  return Object.freeze({ userId: user.id, tenantId: tenant.id, email: user.email });
}
/** Client for the shared /v1/auth contract, with no local user database. */
export class AccountServiceClient implements CloudAuthPort {
  readonly issuer: string;
  constructor(baseUrl: string) { this.issuer = authBaseUrl(baseUrl); }
  private async request(path: string, token?: string, credentials?: { email: string; password: string }): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.issuer}/v1/auth/${path}`, {
        method: path === "me" ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(credentials ? { "content-type": "application/json" } : {}) },
        ...(credentials ? { body: JSON.stringify(credentials) } : {}),
      });
    } catch { throw new IdentityError(503, "cloud_auth_unavailable"); }
    // Bound and whitelist the upstream protocol; never reflect arbitrary errors or redirects.
    let body: unknown = {};
    if (response.status !== 204) {
      try {
        const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
          if (size > 16_384) throw new Error("oversize"); chunks.push(part.value); } }
        finally { await reader.cancel().catch(() => undefined); }
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { throw new IdentityError(502, "cloud_auth_response_invalid"); }
    }
    if (!response.ok) {
      const code = record(body).error;
      if (["invalid_email", "invalid_password", "invalid_credentials", "email_registered", "authentication_required", "session_invalid"].includes(String(code))) {
        const status = code === "email_registered" ? 409 : ["invalid_email", "invalid_password"].includes(String(code)) ? 400 : 401;
        throw new IdentityError(status, String(code));
      }
      throw new IdentityError(response.status === 429 ? 429 : 503, response.status === 429 ? "cloud_auth_rate_limited" : "cloud_auth_unavailable");
    }
    return body;
  }
  async authenticate(mode: "login" | "register", email: string, password: string): Promise<CloudSession> {
    const body = record(await this.request(mode, undefined, { email, password }));
    if (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{32,512}$/.test(body.token)
      || typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= Date.now()) throw new IdentityError(502, "cloud_auth_response_invalid");
    return { token: body.token, expiresAt: body.expiresAt, principal: principal(body) };
  }
  async current(token: string): Promise<CloudPrincipal> { return principal(await this.request("me", token)); }
  async logout(token: string): Promise<void> { await this.request("logout", token); }
}
