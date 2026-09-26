import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const sharedPreview = fileURLToPath(new URL("../../../packages/agentloop-artifact-preview/dist/index.js", import.meta.url));
const sharedMarkdownStyles = fileURLToPath(new URL("../../../packages/agentloop-artifact-preview/markdown.css", import.meta.url));
const sharedMarked = fileURLToPath(new URL("../../../node_modules/marked/lib/marked.esm.js", import.meta.url));
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.WEB_PORT ?? 5174);
const routerUrl = process.env.ROUTER_URL ?? "http://127.0.0.1:8788";
const localAgentUrl = process.env.LOCAL_AGENT_URL ?? "http://127.0.0.1:8790";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

export function runtimeConfigScript(apiUrl, agentUrl = "http://127.0.0.1:8790") {
  // Browser traffic stays same-origin even when Web and Router are separate
  // processes. The configured Router URL is consumed by this server's proxy,
  // not copied into browser state where port/CORS drift can break live Runs.
  return `globalThis.AGENTLOOP_ROUTER_URL = "/api";\nglobalThis.AGENTLOOP_ROUTER_PUBLIC_URL = ${JSON.stringify(String(apiUrl).trim())};\nglobalThis.AGENTLOOP_LOCAL_AGENT_URL = ${JSON.stringify(String(agentUrl).trim())};\n`;
}

export function createWebServer() {
  return createServer(async (request, response) => {
    // This is the local control-plane UI.  Its browser state and Router
    // protocol evolve together, so a cached app.js can otherwise keep an old
    // SSE/recovery implementation alive after the Router has been restarted.
    response.setHeader("cache-control", "no-store");
    const pathname = new URL(request.url ?? "/", "http://web.local").pathname;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      proxyRouterRequest(request, response);
      return;
    }
    if (pathname === "/runtime-config.js") {
      response.statusCode = 200;
      response.setHeader("content-type", types[".js"]);
      response.end(runtimeConfigScript(routerUrl, localAgentUrl));
      return;
    }
    if (pathname === "/artifact-preview.js") {
      try {
        await stat(sharedPreview);
        response.statusCode = 200;
        response.setHeader("content-type", types[".js"]);
        createReadStream(sharedPreview).pipe(response);
      } catch {
        response.statusCode = 503;
        response.end("Shared artifact preview has not been built. Run npm run build:artifact-preview first.");
      }
      return;
    }
    if (pathname === "/marked.js") {
      try {
        await stat(sharedMarked);
        response.statusCode = 200;
        response.setHeader("content-type", types[".js"]);
        createReadStream(sharedMarked).pipe(response);
      } catch {
        response.statusCode = 503;
        response.end("Shared Markdown dependency is unavailable. Run npm install first.");
      }
      return;
    }
    if (pathname === "/artifact-markdown.css") {
      try {
        await stat(sharedMarkdownStyles);
        response.statusCode = 200;
        response.setHeader("content-type", types[".css"]);
        createReadStream(sharedMarkdownStyles).pipe(response);
      } catch {
        response.statusCode = 503;
        response.end("Shared Markdown styles are unavailable.");
      }
      return;
    }
    const requested = pathname === "/" ? "index.html" : (pathname === "/login" || pathname === "/register" ? "login.html" : basename(pathname));
    const file = resolve(root, requested);
    try {
      await stat(file);
      response.statusCode = 200;
      response.setHeader("content-type", types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream");
      createReadStream(file).pipe(response);
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
}

function proxyRouterRequest(request, response) {
  const incoming = new URL(request.url ?? "/api", "http://web.local");
  const suffix = incoming.pathname === "/api" ? "/" : incoming.pathname.slice("/api".length);
  const target = new URL(`${suffix}${incoming.search}`, routerUrl);
  const requestToRouter = target.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = { ...request.headers, host: target.host };
  delete headers.origin;
  const upstream = requestToRouter(target, { method: request.method, headers }, (upstreamResponse) => {
    response.statusCode = upstreamResponse.statusCode ?? 502;
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value !== undefined) response.setHeader(name, value);
    }
    upstreamResponse.pipe(response);
  });
  upstream.once("error", () => {
    if (response.headersSent) return response.destroy();
    response.statusCode = 503;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "router_unavailable" }));
  });
  request.pipe(upstream);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createWebServer().listen(port, host, () => process.stdout.write(`AgentLoop multi-runtime Web listening on http://${host}:${port} (Router: ${routerUrl})\n`));
}
