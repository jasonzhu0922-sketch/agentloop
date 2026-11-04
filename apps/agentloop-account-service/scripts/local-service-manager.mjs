import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const serviceDirectory = resolve(scriptDirectory, "..");
const dataDirectory = join(serviceDirectory, "data");
const statePath = join(dataDirectory, ".local-account-service.json");
const logPath = join(dataDirectory, "local-account-service.log");
const entryPath = join(serviceDirectory, "src", "main.ts");
export const LOCAL_ACCOUNT_HOST = "127.0.0.1";
export const LOCAL_ACCOUNT_PORT = 8795;

function mode(argumentsList) {
  if (argumentsList.length !== 1 || !["--foreground", "--background"].includes(argumentsList[0])) throw new Error("local_account_service_mode_invalid");
  return argumentsList[0] === "--foreground" ? "foreground" : "background";
}
function origin() { return `http://${LOCAL_ACCOUNT_HOST}:${LOCAL_ACCOUNT_PORT}`; }
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
async function readState() {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8"));
    if (!Number.isInteger(value?.pid) || value.pid < 1 || value.entry !== entryPath) throw new Error("local_account_service_state_invalid");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}
async function removeState(pid) {
  const state = await readState().catch(() => undefined);
  if (state?.pid === pid) await rm(statePath, { force: true });
}
function exists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === "ESRCH") return false; throw error; }
}
async function ownedProcess(pid) {
  if (process.platform === "win32") return false;
  try {
    const { stdout } = await execute("ps", ["-p", String(pid), "-o", "command="]);
    return stdout.includes(entryPath);
  } catch { return false; }
}
async function stopPrevious() {
  const state = await readState();
  if (state === undefined) return;
  if (!exists(state.pid)) { await removeState(state.pid); return; }
  if (!(await ownedProcess(state.pid))) throw new Error("local_account_service_restart_refuses_unowned_process");
  process.kill(state.pid, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!exists(state.pid)) { await removeState(state.pid); return; }
    await delay(100);
  }
  throw new Error("local_account_service_restart_timeout");
}
async function waitForHealthy(child) {
  // Give an address-in-use or database bootstrap failure a brief chance to
  // terminate before accepting a health response from this expected listener.
  await delay(150);
  if (child.exitCode !== null) throw new Error("local_account_service_start_failed");
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${origin()}/healthz`, { signal: AbortSignal.timeout(500) });
      if (child.exitCode === null && response.ok) return;
    } catch { /* The listener may still be opening. */ }
    if (child.exitCode !== null) throw new Error("local_account_service_start_failed");
    await delay(100);
  }
  throw new Error("local_account_service_health_timeout");
}
function childEnvironment() {
  return { ...process.env, ACCOUNT_SERVICE_HOST: LOCAL_ACCOUNT_HOST, ACCOUNT_SERVICE_PORT: String(LOCAL_ACCOUNT_PORT) };
}
function childArguments() { return [`--env-file-if-exists=${join(serviceDirectory, ".env")}`, entryPath]; }
async function launch(runMode) {
  const background = runMode === "background";
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await stopPrevious();
  let log;
  try {
    if (background) log = await open(logPath, "a", 0o600);
    const child = spawn(process.execPath, childArguments(), {
      cwd: serviceDirectory,
      detached: background,
      env: childEnvironment(),
      stdio: background ? ["ignore", log.fd, log.fd] : "inherit",
    });
    if (child.pid === undefined) throw new Error("local_account_service_start_failed");
    await writeFile(statePath, JSON.stringify({ pid: child.pid, entry: entryPath, startedAt: Date.now() }), { mode: 0o600 });
    if (background) {
      child.unref();
      try { await waitForHealthy(child); }
      catch (error) { child.kill("SIGTERM"); await removeState(child.pid); throw error; }
      console.log(`Account Service restarted: ${origin()} (logs: ${logPath})`);
      return;
    }
    child.once("exit", () => { void removeState(child.pid); });
    const stop = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    await once(child, "exit");
  } finally { await log?.close(); }
}

if (import.meta.main) void launch(mode(process.argv.slice(2))).catch(error => {
  const code = error instanceof Error ? error.message : "local_account_service_restart_failed";
  console.error(`Account Service local management failed: ${code}`);
  process.exitCode = 1;
});
