import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeCount = parseRuntimeCount(process.argv.slice(2));
const routerPort = positiveInteger(process.env.PORT, 8788);
const webPort = positiveInteger(process.env.WEB_PORT, 5174);
const runtimePort = positiveInteger(process.env.RUNTIME_BASE_PORT, 8791);
const runtimeHost = process.env.RUNTIME_HOST ?? "127.0.0.1";
const routerHost = process.env.HOST ?? "127.0.0.1";
const publicRouterHost = process.env.PUBLIC_HOST ?? (routerHost === "0.0.0.0" ? "127.0.0.1" : routerHost);
const publicRouterUrl = process.env.ROUTER_URL ?? `http://${publicRouterHost}:${routerPort}`;
const dispatchToken = process.env.RUNTIME_DISPATCH_TOKEN ?? "development-dispatch-token-123";
const attachmentToken = process.env.RUNTIME_ATTACHMENT_TOKEN ?? "development-attachment-token-123";
const runtimeDataRoot = resolve(appRoot, process.env.RUNTIME_DATA_ROOT ?? "./data/local");
const sharedStateDatabasePath = resolve(appRoot, process.env.AGENTLOOP_STATE_SQLITE_PATH ?? join(runtimeDataRoot, "agentloop.db"));
const sharedWorkspaceRoot = resolve(appRoot, process.env.RUNTIME_WORKSPACE_ROOT ?? join(runtimeDataRoot, "workspace"));
const providerConfigPath = resolve(
  appRoot,
  process.env.LLM_PROVIDER_CONFIG_PATH ?? "./config/llm-providers.json",
);
if (!existsSync(providerConfigPath)) {
  throw new Error(`LLM_PROVIDER_CONFIG_PATH does not exist: ${providerConfigPath}. Copy config/llm-providers.example.json first.`);
}
const stepExecutionStrategyConfigPath = resolve(
  appRoot,
  process.env.STEP_EXECUTION_STRATEGY_CONFIG_PATH ?? "./config/step-execution-strategy.json",
);
if (!existsSync(stepExecutionStrategyConfigPath)) {
  throw new Error(`STEP_EXECUTION_STRATEGY_CONFIG_PATH does not exist: ${stepExecutionStrategyConfigPath}.`);
}
const providerEnvFileSetting = process.env.LLM_PROVIDER_ENV_FILE;
const providerEnvFile = resolve(appRoot, providerEnvFileSetting ?? "./.env");
if (providerEnvFileSetting !== undefined && !existsSync(providerEnvFile)) {
  throw new Error(`LLM_PROVIDER_ENV_FILE does not exist: ${providerEnvFile}`);
}
const providerEnvFiles = existsSync(providerEnvFile) ? [providerEnvFile] : [];
const localEnvFiles = existsSync(join(appRoot, ".env")) ? [join(appRoot, ".env")] : [];
try {
  await assertPortsAvailable([
    { label: "Router", host: routerHost, port: routerPort },
    { label: "Web", host: routerHost, port: webPort },
    ...Array.from({ length: runtimeCount }, (_, index) => ({
      label: `Runtime Host general-${String(index + 1).padStart(2, "0")}`,
      host: runtimeHost,
      port: runtimePort + index,
    })),
  ]);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
const tempRoot = await mkdtemp(join(tmpdir(), "agentloop-multi-runtime-"));
const configPath = join(tempRoot, "runtimes.json");
const config = {
  schema: "agentloop.multiRuntimeConfig/v1",
  runtimes: Array.from({ length: runtimeCount }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    return {
      id: `general-${ordinal}`,
      endpoint: `http://${runtimeHost}:${runtimePort + index}`,
      profile: "general",
      capabilities: ["document"],
      maxConcurrentRuns: positiveInteger(process.env.MAX_CONCURRENT_RUNS, 2),
    };
  }),
};
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

const children = [];
const common = {
  ...process.env,
  RUNTIME_DISPATCH_TOKEN: dispatchToken,
  RUNTIME_ATTACHMENT_TOKEN: attachmentToken,
};
const defaultWebOrigins = [...new Set([
  `http://${routerHost}:${webPort}`,
  `http://${publicRouterHost}:${webPort}`,
  `http://localhost:${webPort}`,
  `http://127.0.0.1:${webPort}`,
])].join(",");
children.push(start("router", "src/entrypoints/router-main.ts", {
  ...common,
  HOST: routerHost,
  PORT: String(routerPort),
  RUNTIME_CONFIG_PATH: configPath,
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? defaultWebOrigins,
  ATTACHMENT_BASE_URL: process.env.ATTACHMENT_BASE_URL ?? publicRouterUrl,
  AGENTLOOP_STATE_DRIVER: process.env.AGENTLOOP_STATE_DRIVER ?? "sqlite",
  AGENTLOOP_STATE_SQLITE_PATH: sharedStateDatabasePath,
}, localEnvFiles));

// The Router owns initial schema setup.  Starting Hosts only after its health
// endpoint responds prevents multiple processes from competing to initialize
// a shared SQLite/WAL file during local development.
await waitForRouterHealth(publicRouterUrl);

for (let index = 0; index < runtimeCount; index += 1) {
  const ordinal = String(index + 1).padStart(2, "0");
  const runtimeId = `general-${ordinal}`;
  await mkdir(runtimeDataRoot, { recursive: true });
  await mkdir(sharedWorkspaceRoot, { recursive: true });
  children.push(start(`runtime-${runtimeId}`, "src/entrypoints/runtime-host-main.ts", {
    ...common,
    HOST: runtimeHost,
    PORT: String(runtimePort + index),
    RUNTIME_ID: runtimeId,
    ROUTER_URL: publicRouterUrl,
    LLM_PROVIDER_CONFIG_PATH: providerConfigPath,
    STEP_EXECUTION_STRATEGY_CONFIG_PATH: stepExecutionStrategyConfigPath,
    AGENTLOOP_STATE_DRIVER: process.env.AGENTLOOP_STATE_DRIVER ?? "sqlite",
    AGENTLOOP_STATE_SQLITE_PATH: sharedStateDatabasePath,
    WORKSPACE_ROOT: sharedWorkspaceRoot,
  }, providerEnvFiles));
}

children.push(start("web", "web/server.mjs", {
  ...common,
  HOST: routerHost,
  WEB_PORT: String(webPort),
  ROUTER_URL: publicRouterUrl,
}));

process.stdout.write(`Starting multi-runtime locally with ${runtimeCount} Runtime Host(s).\n`);
process.stdout.write(`Router: http://${routerHost}:${routerPort}; Web: http://${routerHost}:${webPort}\n`);
process.stdout.write(`Shared workspace: ${sharedWorkspaceRoot}; shared state: ${sharedStateDatabasePath}\n`);

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill(signal);
  void rm(tempRoot, { recursive: true, force: true });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function start(label, entrypoint, environment, envFiles = []) {
  const envFileArgs = envFiles.flatMap((file) => ["--env-file", file]);
  const childEnvironment = { ...environment };
  const child = spawn(process.execPath, [...envFileArgs, entrypoint], {
    cwd: appRoot,
    env: childEnvironment,
    stdio: ["inherit", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.on("exit", (code, signal) => {
    if (!closing && code !== 0) {
      process.stderr.write(`[${label}] exited with ${signal ?? `code ${code}`}\n`);
      shutdown("SIGTERM");
      process.exitCode = code ?? 1;
    }
  });
  return child;
}

function parseRuntimeCount(args) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: npm run start:multi-runtime -- --runtimes <count>\n");
    process.stdout.write("       npm run start:multi-runtime -- -n <count>\n");
    process.exit(0);
  }
  const value = args.find((arg) => arg.startsWith("--runtimes=") || arg.startsWith("--runtime-count="))?.split("=", 2)[1]
    ?? valueAfter(args, "--runtimes")
    ?? valueAfter(args, "--runtime-count")
    ?? valueAfter(args, "-n")
    ?? process.env.RUNTIME_COUNT
    ?? "2";
  return positiveInteger(value, 2, 32, "runtime count");
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positiveInteger(value, fallback, maximum = 65_535, label = "value") {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

async function assertPortsAvailable(ports) {
  const conflicts = [];
  for (const port of ports) {
    if (!(await isPortAvailable(port.host, port.port))) conflicts.push(`${port.label} ${port.host}:${port.port}`);
  }
  if (conflicts.length > 0) {
    throw new Error([
      `Port(s) already in use: ${conflicts.join(", ")}`,
      "Set WEB_PORT, PORT, or RUNTIME_BASE_PORT to unused ports and retry.",
    ].join(" "));
  }
}

function isPortAvailable(host, port) {
  return new Promise((resolveAvailability) => {
    const probe = createServer();
    probe.once("error", (error) => {
      // Sandboxed environments may deny bind probes with EPERM/EACCES. Only
      // EADDRINUSE is authoritative evidence that another process owns it.
      resolveAvailability(error?.code !== "EADDRINUSE");
    });
    probe.listen(port, host, () => probe.close(() => resolveAvailability(true)));
  });
}

async function waitForRouterHealth(routerUrl, timeoutMs = 30_000) {
  const healthUrl = new URL("/healthz", `${routerUrl.replace(/\/$/, "")}/`);
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Router did not become healthy within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
