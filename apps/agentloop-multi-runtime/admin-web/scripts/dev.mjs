import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = spawnSync(process.execPath, [resolve(root, "scripts/build.mjs")], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const port = Number(process.env.ADMIN_WEB_PORT ?? "5175");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError("ADMIN_WEB_PORT must be a TCP port");
// Local Runtime Hosts use 8791 onward; the standalone Admin API defaults to 8892.
const apiOrigin = new URL(process.env.ADMIN_WEB_API_ORIGIN ?? "http://127.0.0.1:8892");
if (apiOrigin.protocol !== "http:" && apiOrigin.protocol !== "https:") throw new TypeError("ADMIN_WEB_API_ORIGIN must use http or https");

createServer(async (request, response) => {
  if (request.url === "/healthz" || request.url?.startsWith("/admin/")) {
    proxyToAdminApi(request, response);
    return;
  }
  const requested = request.url === "/app.js" ? "app.js" : request.url === "/styles.css" ? "styles.css" : "index.html";
  const file = resolve(root, "dist", requested);
  try {
    await stat(file);
    response.writeHead(200, { "content-type": requested === "app.js" ? "text/javascript; charset=utf-8" : requested === "styles.css" ? "text/css; charset=utf-8" : "text/html; charset=utf-8" });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => process.stdout.write(`AgentLoop Admin Web listening on 127.0.0.1:${port}\n`));

/**
 * Keeps the browser on one origin while preserving Admin API authentication.
 * This is deliberately a narrow proxy: it never proxies Router, Host, Agent,
 * database, or arbitrary user-controlled destinations.
 */
function proxyToAdminApi(browserRequest, browserResponse) {
  const upstream = new URL(browserRequest.url, apiOrigin);
  const headers = { ...browserRequest.headers, host: apiOrigin.host };
  const requestUpstream = apiOrigin.protocol === "https:" ? requestHttps : requestHttp;
  const upstreamRequest = requestUpstream({
    protocol: apiOrigin.protocol,
    hostname: apiOrigin.hostname,
    port: apiOrigin.port || undefined,
    method: browserRequest.method,
    path: `${upstream.pathname}${upstream.search}`,
    headers,
  }, (upstreamResponse) => {
    browserResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(browserResponse);
  });
  upstreamRequest.on("error", () => {
    if (!browserResponse.headersSent) browserResponse.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    browserResponse.end(JSON.stringify({ code: "ADMIN_API_UNAVAILABLE" }));
  });
  browserRequest.pipe(upstreamRequest);
}
