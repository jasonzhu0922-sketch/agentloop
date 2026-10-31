import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { DesktopConfig } from "./config.ts";

const PROXY_PREFIXES = [
  "/v1/local-runtimes",
  "/v1/local-models",
  "/v1/local-memory",
  "/v1/local-skill-packages",
  "/v1/local-skill-package-uploads",
  "/v1/local-mcp-servers",
  "/v1/agent",
  "/v1/directory-scopes",
  "/v1/uploads",
  "/v1/strict-local-runs",
  "/v1/device-registration",
];

export async function createDesktopServer(config: DesktopConfig): Promise<Server> {
  const index = await readFile(join(config.appRoot, "web", "index.html"));
  const appScript = await readFile(join(config.appRoot, "web", "app.js"));
  const desktopCookie = randomBytes(24).toString("base64url");
  return createServer(async (request, response) => {
    try {
      await handleRequest(config, desktopCookie, index, appScript, request, response);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function handleRequest(
  config: DesktopConfig,
  desktopCookie: string,
  index: Buffer,
  appScript: Buffer,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", config.webOrigin);
  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ready", service: "agentloop-desktop", localAgentUrl: config.localAgentUrl });
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("set-cookie", "agentloop_desktop=" + desktopCookie + "; HttpOnly; SameSite=Strict; Path=/");
    response.end(index);
    return;
  }
  if (request.method === "GET" && url.pathname === "/app.js") {
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    response.end(appScript);
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/desktop/config") {
    sendJson(response, 200, {
      service: "agentloop-desktop",
      localAgent: { url: config.localAgentUrl, managed: config.manageLocalAgent },
      auth: { cloudConfigured: config.cloudAuthUrl !== undefined, localSessionConfigured: config.localSessionToken !== undefined },
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/auth/status") {
    sendJson(response, 200, {
      authenticated: config.localSessionToken !== undefined,
      cloudConfigured: config.cloudAuthUrl !== undefined,
      ...(config.cloudAuthUrl === undefined ? {} : { cloudAuthUrl: config.cloudAuthUrl }),
    });
    return;
  }
  if (PROXY_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix + "/"))) {
    await proxyToLocalAgent(config, request, response);
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
    const asset = await readFile(join(config.appRoot, "web", url.pathname.slice(1)));
    response.setHeader("content-type", contentType(extname(url.pathname)));
    response.end(asset);
    return;
  }
  sendJson(response, 404, { error: "not_found" });
}

async function proxyToLocalAgent(config: DesktopConfig, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request);
  const headers: Record<string, string> = { origin: config.webOrigin };
  const contentType = request.headers["content-type"];
  if (typeof contentType === "string") headers["content-type"] = contentType;
  if (config.localSessionToken !== undefined) headers["x-local-session"] = config.localSessionToken;
  const target = new URL(request.url ?? "/", config.localAgentUrl);
  const upstream = await fetch(target, { method: request.method, headers, body: body.length === 0 ? undefined : body });
  const payload = Buffer.from(await upstream.arrayBuffer());
  response.statusCode = upstream.status;
  const upstreamType = upstream.headers.get("content-type");
  if (upstreamType !== null) response.setHeader("content-type", upstreamType);
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 100 * 1024 * 1024) throw new Error("request_body_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function contentType(extension: string): string {
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}
