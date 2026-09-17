import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

export const LOCAL_MARKITDOWN_VERSION = "0.1.7";
const DEFAULT_PIP_INDEX_URL = "https://mirrors.aliyun.com/pypi/simple/";
const BASELINE_COMMANDS = "markitdown,pandoc,pdftoppm,pdftotext,pdfinfo,qpdf,gs,tesseract,ffmpeg,unzip,zip";
const BASELINE_PYTHON_MODULES = "anthropic,defusedxml,imageio,lxml,mcp,numpy,openpyxl,pandas,pdf2image,pdfplumber,PIL,playwright,pymysql,pypdf,pytesseract,reportlab";
const BASELINE_NODE_MODULES = "docx,pptxgenjs,react,react-dom,react-icons,sharp";

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
  const python = environment.RUNTIME_PYTHON ?? "python3";
  const markitdown = join(toolsBin, process.platform === "win32" ? "markitdown.exe" : "markitdown");
  const pip = join(toolsBin, process.platform === "win32" ? "pip.exe" : "pip");
  const requiredPythonModules = requiredLocalRuntimePythonModules(environment);
  const hasRequiredPythonModules = (await Promise.all(
    requiredPythonModules.map((module) => hasRequiredPythonModule(toolsBin, module)),
  )).every(Boolean);
  if (!existsSync(markitdown) || !(await hasRequiredMarkitdownVersion(markitdown)) || !hasRequiredPythonModules) {
    if (!existsSync(pip)) await run(python, ["-m", "venv", toolsRoot], "create local Runtime Python environment");
    await run(pip, [
      "install",
      "--no-cache-dir",
      "--index-url",
      environment.PIP_INDEX_URL ?? DEFAULT_PIP_INDEX_URL,
      "-r",
      join(appRoot, "requirements.txt"),
    ], "install Runtime Python requirements");
  }
  await run(markitdown, ["--version"], "verify local markitdown");
  const runtimePython = join(toolsBin, process.platform === "win32" ? "python.exe" : "python");
  await assertRequiredPythonModules(runtimePython, requiredPythonModules);
  if (!(await hasPlaywrightChromium(runtimePython))) {
    await run(runtimePython, ["-m", "playwright", "install", "chromium"], "install local Runtime Chromium");
  }
  return toolsBin;
}

async function assertRequiredPythonModules(python, modules) {
  for (const module of modules) {
    await run(
      python,
      ["-c", "import importlib, sys; importlib.import_module(sys.argv[1])", module],
      `verify local Runtime Python module ${module}`,
    );
  }
}

async function hasRequiredPythonModule(toolsBin, module) {
  const python = join(toolsBin, process.platform === "win32" ? "python.exe" : "python");
  try {
    await execFileAsync(python, ["-c", "import importlib, sys; importlib.import_module(sys.argv[1])", module], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

async function hasPlaywrightChromium(python) {
  try {
    const { stdout } = await execFileAsync(python, ["-c", "from pathlib import Path\nfrom playwright.sync_api import sync_playwright\nwith sync_playwright() as p: print(p.chromium.executable_path)"], { encoding: "utf8" });
    return existsSync(stdout.trim());
  } catch {
    return false;
  }
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
