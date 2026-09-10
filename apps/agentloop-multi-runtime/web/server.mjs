import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const sharedPreview = fileURLToPath(new URL("../../../packages/agentloop-artifact-preview/dist/index.js", import.meta.url));
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.WEB_PORT ?? 5174);
const routerUrl = process.env.ROUTER_URL ?? "http://127.0.0.1:8788";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

export function runtimeConfigScript(apiUrl) {
  return `globalThis.AGENTLOOP_ROUTER_URL = ${JSON.stringify(String(apiUrl).trim())};\n`;
}

export function createWebServer() {
  return createServer(async (request, response) => {
    // This is the local control-plane UI.  Its browser state and Router
    // protocol evolve together, so a cached app.js can otherwise keep an old
    // SSE/recovery implementation alive after the Router has been restarted.
    response.setHeader("cache-control", "no-store");
    const pathname = new URL(request.url ?? "/", "http://web.local").pathname;
    if (pathname === "/runtime-config.js") {
      response.statusCode = 200;
      response.setHeader("content-type", types[".js"]);
      response.end(runtimeConfigScript(routerUrl));
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
    const requested = pathname === "/" ? "index.html" : basename(pathname);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createWebServer().listen(port, host, () => process.stdout.write(`AgentLoop multi-runtime Web listening on http://${host}:${port} (Router: ${routerUrl})\n`));
}
