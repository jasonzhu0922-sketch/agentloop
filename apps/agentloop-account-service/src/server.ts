import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { IdentityError, type IdentityService, type IdentitySession } from "@zhujun/agentloop-identity";

function json(response: ServerResponse, status: number, body?: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}
function sessionBody(session: IdentitySession) {
  return { token: session.token, expiresAt: session.expiresAt,
    user: { id: session.principal.userId, email: session.principal.email }, tenant: { id: session.principal.tenantId } };
}
async function credentials(request: IncomingMessage): Promise<{ email: string; password: string }> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) throw new IdentityError(415, "json_required", "JSON required");
  let size = 0; const chunks: Buffer[] = [];
  // Drain oversized requests without retaining their contents or aborting the response socket.
  for await (const chunk of request) { size += chunk.length; if (size <= 8192) chunks.push(chunk); }
  if (size > 8192) throw new IdentityError(413, "body_too_large", "Request too large");
  let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new IdentityError(400, "json_invalid", "Invalid JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["email", "password"].includes(key))) throw new IdentityError(400, "credentials_invalid", "Invalid credentials fields");
  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== "string" || email.length > 254) throw new IdentityError(400, "invalid_email", "Invalid email");
  if (typeof password !== "string" || password.length > 256) throw new IdentityError(400, "invalid_password", "Invalid password");
  return { email, password };
}
/** Deploy behind an HTTPS ingress. No Router, Runtime, business APIs, cookies or credential logs. */
export function createAccountServer(identity: Pick<IdentityService, "register" | "login" | "authenticate" | "revoke">) {
  // Fixed-size per-process abuse protection. Ingress must impose shared rate/body/time limits in production.
  let windowStart = Date.now(), attempts = 0, inFlight = 0;
  const server = createServer(async (request, response) => {
    try {
      const path = request.url;
      if (request.method === "GET" && path === "/healthz") { json(response, 200, { status: "ok" }); return; }
      if (request.method === "POST" && ["/v1/auth/login", "/v1/auth/register"].includes(path ?? "")) {
        if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); attempts = 0; }
        if (attempts >= 120 || inFlight >= 4) { json(response, 429, { error: "rate_limited" }); return; }
        attempts++; inFlight++;
        try {
          const body = await credentials(request);
          const session = path === "/v1/auth/register" ? await identity.register(body.email, body.password) : await identity.login(body.email, body.password);
          json(response, path === "/v1/auth/register" ? 201 : 200, sessionBody(session)); return;
        } finally { inFlight--; }
      }
      if (request.method === "GET" && path === "/v1/auth/me") {
        const principal = await identity.authenticate(request.headers.authorization);
        json(response, 200, { user: { id: principal.userId, email: principal.email }, tenant: { id: principal.tenantId } }); return;
      }
      if (request.method === "POST" && path === "/v1/auth/logout") {
        await identity.authenticate(request.headers.authorization); await identity.revoke(request.headers.authorization);
        json(response, 204); return;
      }
      json(response, 404, { error: "route_not_found" });
    } catch (error) {
      if (error instanceof IdentityError) json(response, error.status, { error: error.code });
      else json(response, 500, { error: "account_operation_failed" });
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 1_000;
  server.maxConnections = 256;
  return server;
}
