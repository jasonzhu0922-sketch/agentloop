import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

export const LOCAL_MARKITDOWN_VERSION = "0.1.7";
const DEFAULT_PIP_INDEX_URL = "https://mirrors.aliyun.com/pypi/simple/";

export function localRuntimeToolsRoot(appRoot, environment = process.env) {
  return resolve(appRoot, environment.RUNTIME_TOOLS_ROOT ?? "./data/local/runtime-tools");
}

export function localRuntimeToolsBin(toolsRoot) {
  return join(toolsRoot, process.platform === "win32" ? "Scripts" : "bin");
}

export function localRuntimeHostEnvironment(environment, toolsBin) {
  return {
    ...environment,
    PATH: [toolsBin, environment.PATH].filter((value) => value?.length > 0).join(":"),
    RUNTIME_REQUIRED_COMMANDS: environment.RUNTIME_REQUIRED_COMMANDS ?? "markitdown",
  };
}

export async function ensureLocalRuntimeTools({ appRoot, environment = process.env } = {}) {
  if (appRoot === undefined) throw new Error("appRoot is required to provision local Runtime tools");
  const toolsRoot = localRuntimeToolsRoot(appRoot, environment);
  const toolsBin = localRuntimeToolsBin(toolsRoot);
  const python = environment.RUNTIME_PYTHON ?? "python3";
  const markitdown = join(toolsBin, process.platform === "win32" ? "markitdown.exe" : "markitdown");
  const pip = join(toolsBin, process.platform === "win32" ? "pip.exe" : "pip");
  if (!existsSync(markitdown) || !(await hasRequiredMarkitdownVersion(markitdown))) {
    if (!existsSync(pip)) await run(python, ["-m", "venv", toolsRoot], "create local Runtime Python environment");
    await run(pip, [
      "install",
      "--no-cache-dir",
      "--index-url",
      environment.PIP_INDEX_URL ?? DEFAULT_PIP_INDEX_URL,
      `markitdown==${LOCAL_MARKITDOWN_VERSION}`,
    ], `install markitdown ${LOCAL_MARKITDOWN_VERSION}`);
  }
  await run(markitdown, ["--version"], "verify local markitdown");
  return toolsBin;
}

async function hasRequiredMarkitdownVersion(markitdown) {
  try {
    const { stdout } = await execFileAsync(markitdown, ["--version"], { encoding: "utf8" });
    return stdout.trim() === `markitdown ${LOCAL_MARKITDOWN_VERSION}`;
  } catch {
    return false;
  }
}

async function run(command, args, action) {
  try {
    await execFileAsync(command, args, { encoding: "utf8" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to ${action}: ${detail}`);
  }
}
