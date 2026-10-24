import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

export const LOCAL_MARKITDOWN_VERSION = "0.1.7";
const DEFAULT_PIP_INDEX_URL = "https://mirrors.aliyun.com/pypi/simple/";
const BASELINE_COMMANDS = "markitdown,pandoc,pdftoppm,pdftotext,pdfinfo,qpdf,gs,tesseract,ffmpeg,unzip,zip";
const BASELINE_PYTHON_MODULES = "anthropic,defusedxml,imageio,lxml,mcp,numpy,openpyxl,pandas,pdf2image,pdfplumber,PIL,pymysql,pypdf,pytesseract,reportlab";
const BASELINE_NODE_MODULES = "docx,pptxgenjs,react,react-dom,react-icons,sharp,@zhujun/agentloop-plan-template";

export function localRuntimeToolsRoot(appRoot, environment = process.env) {
  return resolve(appRoot, environment.RUNTIME_TOOLS_ROOT ?? "./data/local/runtime-tools");
}

export function localRuntimeToolsBin(toolsRoot) {
  return join(toolsRoot, process.platform === "win32" ? "Scripts" : "bin");
}

export function localRuntimePythonExecutable(toolsRoot, environment = process.env) {
  if (environment.RUNTIME_PYTHON !== undefined && environment.RUNTIME_PYTHON.trim() !== "") return environment.RUNTIME_PYTHON;
  return join(localRuntimeToolsBin(toolsRoot), process.platform === "win32" ? "python.exe" : "python");
}

export function localRuntimeToolsEnvironment(environment, toolsBin, toolsRoot) {
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  return {
    ...environment,
    PATH: [toolsBin, toolsRoot, environment.PATH].filter((value) => value?.length > 0).join(pathSeparator),
  };
}

export function localRuntimeMarkitdownExecutable(toolsRoot) {
  const toolsBin = localRuntimeToolsBin(toolsRoot);
  return join(toolsBin, process.platform === "win32" ? "markitdown.exe" : "markitdown");
}

export function localRuntimeHostEnvironment(environment, toolsBin) {
  return {
    ...localRuntimeToolsEnvironment(environment, toolsBin, resolve(toolsBin, "..")),
    RUNTIME_REQUIRED_COMMANDS: environment.RUNTIME_REQUIRED_COMMANDS ?? BASELINE_COMMANDS,
    RUNTIME_REQUIRED_PYTHON_MODULES: environment.RUNTIME_REQUIRED_PYTHON_MODULES ?? BASELINE_PYTHON_MODULES,
    RUNTIME_REQUIRED_NODE_MODULES: environment.RUNTIME_REQUIRED_NODE_MODULES ?? BASELINE_NODE_MODULES,
  };
}

export function requiredLocalRuntimePythonModules(environment = process.env) {
  return [...new Set((environment.RUNTIME_REQUIRED_PYTHON_MODULES ?? BASELINE_PYTHON_MODULES)
    .split(",")
    .map((module) => module.trim())
    .filter((module) => module.length > 0))];
}

export async function ensureLocalRuntimeTools({ appRoot, environment = process.env } = {}) {
  if (appRoot === undefined) throw new Error("appRoot is required to provision local Runtime tools");
  const toolsRoot = localRuntimeToolsRoot(appRoot, environment);
  const toolsBin = localRuntimeToolsBin(toolsRoot);
  const runtimeEnvironment = localRuntimeToolsEnvironment(environment, toolsBin, toolsRoot);
  const packaged = environment.RUNTIME_PACKAGED_PYTHON_ROOT !== undefined;
  const python = environment.RUNTIME_PYTHON ?? "python3";
  const markitdown = localRuntimeMarkitdownExecutable(toolsRoot, environment);
  const pip = join(toolsBin, process.platform === "win32" ? "pip.exe" : "pip");
  const runtimePython = localRuntimePythonExecutable(toolsRoot, environment);
  const requiredPythonModules = requiredLocalRuntimePythonModules(environment);
  const hasRequiredPythonModules = (await Promise.all(
    requiredPythonModules.map((module) => hasRequiredPythonModule(runtimePython, module, runtimeEnvironment)),
  )).every(Boolean);
  if (!existsSync(markitdown) || !(await hasRequiredMarkitdownVersion(markitdown, runtimeEnvironment)) || !hasRequiredPythonModules) {
    if (packaged) throw new Error("Packaged Runtime Python baseline is incomplete; rebuild the local package");
    if (!existsSync(pip)) await run(python, ["-m", "venv", toolsRoot], "create local Runtime Python environment", runtimeEnvironment);
    await run(pip, [
      "install",
      "--no-cache-dir",
      "--index-url",
      environment.PIP_INDEX_URL ?? DEFAULT_PIP_INDEX_URL,
      "-r",
      join(appRoot, "requirements.txt"),
    ], "install Runtime Python requirements", runtimeEnvironment);
  }
  await run(markitdown, ["--version"], "verify local markitdown", runtimeEnvironment);
  await assertRequiredPythonModules(runtimePython, requiredPythonModules, runtimeEnvironment);
  return toolsBin;
}

async function assertRequiredPythonModules(python, modules, environment) {
  for (const module of modules) {
    await run(
      python,
      ["-c", "import importlib, sys; importlib.import_module(sys.argv[1])", module],
      `verify local Runtime Python module ${module}`,
      environment,
    );
  }
}

async function hasRequiredPythonModule(python, module, environment) {
  try {
    await execFileAsync(python, ["-c", "import importlib, sys; importlib.import_module(sys.argv[1])", module], { encoding: "utf8", env: environment });
    return true;
  } catch {
    return false;
  }
}

async function hasRequiredMarkitdownVersion(markitdown, environment) {
  try {
    const { stdout } = await execFileAsync(markitdown, ["--version"], {
      encoding: "utf8",
      env: environment,
    });
    return stdout.trim() === `markitdown ${LOCAL_MARKITDOWN_VERSION}`;
  } catch {
    return false;
  }
}

async function run(command, args, action, environment) {
  try {
    await execFileAsync(command, args, {
      encoding: "utf8",
      env: environment,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to ${action}: ${detail}`);
  }
}
