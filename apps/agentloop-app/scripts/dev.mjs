#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const processes = [];
let shuttingDown = false;

const apiPort = await findAvailablePort(Number(process.env.PORT ?? 8787));
const webPort = await findAvailablePort(Number(process.env.WEB_PORT ?? 5173));

start("api", process.execPath, ["--env-file-if-exists=.env", "src/main.ts"], {
  cwd: appRoot,
  env: {
    ...process.env,
    PORT: String(apiPort),
    WEB_ORIGINS_JSON: process.env.WEB_ORIGINS_JSON ?? JSON.stringify([
      `http://localhost:${webPort}`,
      `http://127.0.0.1:${webPort}`,
    ]),
  },
});

const webRoot = join(appRoot, "web");
if (!existsSync(join(webRoot, "node_modules"))) {
  console.error("[web] missing web/node_modules; run `cd apps/agentloop-app/web && npm install` first");
  shutdown(1);
} else {
  start("web", npm, ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(webPort)], {
    cwd: webRoot,
    env: {
      ...process.env,
      AGENTLOOP_API_URL: process.env.AGENTLOOP_API_URL ?? `http://127.0.0.1:${apiPort}`,
    },
  });
}

console.log(`[dev] API: http://127.0.0.1:${apiPort}`);
console.log(`[dev] Web: http://127.0.0.1:${webPort}`);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function start(name, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  child.stdout.on("data", (chunk) => prefix(name, chunk));
  child.stderr.on("data", (chunk) => prefix(name, chunk));
  child.on("error", (error) => {
    console.error(`[${name}] failed to start: ${error.message}`);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${name}] exited with ${signal ?? code}`);
    shutdown(code === null ? 1 : code);
  });
}

function prefix(name, chunk) {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line.length > 0) console.log(`[${name}] ${line}`);
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 500).unref();
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await canListen(port)) return port;
  }
  console.error(`[dev] no available port found in ${startPort}-${startPort + 99}`);
  process.exit(1);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}
