import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = spawnSync(process.execPath, [resolve(root, "scripts/build.mjs")], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const port = Number(process.env.ADMIN_WEB_PORT ?? "5175");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError("ADMIN_WEB_PORT must be a TCP port");

createServer(async (request, response) => {
  const requested = request.url === "/app.js" ? "app.js" : "index.html";
  const file = resolve(root, "dist", requested);
  try {
    await stat(file);
    response.writeHead(200, { "content-type": requested === "app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => process.stdout.write(`AgentLoop Admin Web scaffold listening on 127.0.0.1:${port}\n`));
