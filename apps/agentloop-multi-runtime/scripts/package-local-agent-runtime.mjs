import { chmod, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const PACKAGED_NODE_MAJOR = 26;
export const PACKAGED_PYTHON_MAJOR_MINOR = "3.12";

export function packagedRuntimePythonManifestPath(platformName = process.platform) {
  const executable = platformName === "win32" ? "python.exe" : "bin/python3.12";
  return `runtime-python/${executable}`;
}

/** Node's CLI prefixes the semantic version with `v`, while release manifests do not. */
export function normalizePackagedNodeVersion(output) {
  return output.trim().replace(/^v/, "");
}

/**
 * Copy a standalone Python runtime and install the locked Runtime baseline into
 * that same prefix.  The installer must never need pip or a host Python after
 * this step: the copied prefix owns both the interpreter and site-packages.
 */
export async function preparePackagedPythonRuntime({ sourceRoot, destinationRoot, requirementsPath, pipIndexUrl = process.env.PIP_INDEX_URL } = {}) {
  if (sourceRoot === undefined || destinationRoot === undefined || requirementsPath === undefined) {
    throw new Error("sourceRoot, destinationRoot, and requirementsPath are required");
  }
  const source = resolve(sourceRoot);
  const destination = resolve(destinationRoot);
  const python = process.platform === "win32"
    ? join(destination, "python.exe")
    : join(destination, "bin", "python3.12");
  await cp(source, destination, { recursive: true, dereference: true });
  const version = runCapture(python, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"]);
  if (version !== PACKAGED_PYTHON_MAJOR_MINOR) throw new Error(`Packaged Python must be ${PACKAGED_PYTHON_MAJOR_MINOR}; got ${version}`);
  const pipArgs = ["-m", "pip", "install", "--prefix", destination, "--no-cache-dir"];
  if (pipIndexUrl !== undefined && pipIndexUrl.trim() !== "") pipArgs.push("--index-url", pipIndexUrl);
  pipArgs.push("-r", resolve(requirementsPath));
  run(python, pipArgs, { action: "install packaged Runtime Python requirements" });
  const probe = "import importlib, sys; [importlib.import_module(name) for name in sys.argv[1:]]";
  await removeBundledFfmpeg(destination);
  await prunePackagedPythonRuntime(destination);
  run(python, ["-c", probe, "anthropic", "defusedxml", "imageio", "lxml", "mcp", "numpy", "openpyxl", "pandas", "pdf2image", "pdfplumber", "PIL", "pymysql", "pypdf", "pytesseract", "reportlab"], { action: "verify packaged Runtime Python modules after pruning" });
  await ensurePythonCommandAliases(destination, python);
  if (process.platform !== "win32") {
    const markitdown = join(destination, "bin", "markitdown");
    await writeFile(markitdown, "#!/bin/sh\nset -eu\nexec \"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)/python3.12\" -m markitdown \"$@\"\n", "utf8");
    await chmod(markitdown, 0o755);
  } else {
    // pip's generated Windows launcher reads the first line of its adjacent
    // `markitdown-script.py`. Make that shebang resolve beside the launcher,
    // and place the package interpreter beside it, so the whole prefix can be
    // moved from the build staging directory to Program Files.
    const script = join(destination, "Scripts", "markitdown-script.py");
    const scriptSource = await readFile(script, "utf8");
    const scriptLines = scriptSource.split(/\r?\n/);
    scriptLines[0] = "#!python.exe";
    await writeFile(script, scriptLines.join("\r\n"), "utf8");
    await cp(python, join(destination, "Scripts", "python.exe"));
    for (const entry of await readdir(destination)) {
      if (entry.toLowerCase().endsWith(".dll")) await cp(join(destination, entry), join(destination, "Scripts", entry));
    }
  }
  const markitdown = join(destination, process.platform === "win32" ? "Scripts/markitdown.exe" : "bin/markitdown");
  run(markitdown, ["--version"], { action: "verify packaged markitdown" });
  // Import and CLI probes can recreate bytecode after the first pruning pass.
  await prunePackagedPythonRuntime(destination);
  const marker = {
    schema: "agentloop.packagedRuntimePython/v1",
    pythonVersion: PACKAGED_PYTHON_MAJOR_MINOR,
    pythonExecutable: process.platform === "win32" ? "python.exe" : "bin/python3.12",
    toolsDirectory: process.platform === "win32" ? "Scripts" : "bin",
  };
  await writeFile(join(destination, "agentloop-runtime-python.json"), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return marker;
}

/** Keep the default Local Agent package free of a second platform FFmpeg binary. */
async function removeBundledFfmpeg(destination) {
  const sitePackages = process.platform === "win32"
    ? join(destination, "Lib", "site-packages")
    : join(destination, "lib", "python3.12", "site-packages");
  const binaries = join(sitePackages, "imageio_ffmpeg", "binaries");
  for (const name of await readdir(binaries).catch(() => [])) {
    if (name.startsWith("ffmpeg-")) await rm(join(binaries, name), { force: true });
  }
}

/** Remove build-time Python artifacts that are never imported by the installed Runtime. */
export async function prunePackagedPythonRuntime(destination) {
  const sitePackages = process.platform === "win32"
    ? join(destination, "Lib", "site-packages")
    : join(destination, "lib", "python3.12", "site-packages");
  const pending = [resolve(destination)];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__" || entry.name === "test" || entry.name === "tests") {
          await rm(path, { recursive: true, force: true });
        } else if (directory === sitePackages && (entry.name === "pip" || (entry.name.startsWith("pip-") && entry.name.endsWith(".dist-info")))) {
          await rm(path, { recursive: true, force: true });
        } else {
          pending.push(path);
        }
      } else if (entry.name.endsWith(".pyc")) {
        await rm(path, { force: true });
      } else if (directory === sitePackages && entry.name.startsWith("pip-") && entry.name.endsWith(".dist-info")) {
        await rm(path, { recursive: true, force: true });
      }
    }
  }
}

async function ensurePythonCommandAliases(destination, python) {
  if (process.platform === "win32") {
    const alias = join(destination, "python3.exe");
    if (!existsSync(alias)) await cp(python, alias);
    return;
  }
  const bin = join(destination, "bin");
  for (const name of ["python3", "python"]) {
    const alias = join(bin, name);
    if (!existsSync(alias)) await symlink("python3.12", alias);
  }
}

/** Copy the Node modules used by Skill-owned node scripts, without shipping dev dependencies. */
export async function copyPackagedNodeModules({ repositoryRoot, destinationRoot } = {}) {
  if (repositoryRoot === undefined || destinationRoot === undefined) throw new Error("repositoryRoot and destinationRoot are required");
  const sourceRoot = resolve(repositoryRoot, "node_modules");
  const targetRoot = resolve(destinationRoot, "node_modules");
  await mkdir(targetRoot, { recursive: true });
  const queue = ["docx", "pptxgenjs", "jszip"];
  const copied = new Set();
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || name.startsWith("@types/")) continue;
    const source = resolvePackageDirectory(name, sourceRoot);
    if (copied.has(source)) continue;
    copied.add(source);
    const target = join(targetRoot, name);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, dereference: true });
    const packageJson = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    for (const dependency of Object.keys({ ...packageJson.dependencies, ...packageJson.optionalDependencies })) {
      if (!dependency.startsWith("@types/")) queue.push(dependency);
    }
  }
  return [...copied].map((source) => relative(sourceRoot, source)).sort();
}

/** Copy only credential-free templates needed to initialize device-owned configuration. */
export async function copyPackagedAgentRuntimeSupportFiles({ appRoot, destinationRoot } = {}) {
  if (appRoot === undefined || destinationRoot === undefined) throw new Error("appRoot and destinationRoot are required");
  const sourceRoot = resolve(appRoot, "local-agent-runtime");
  const targetRoot = resolve(destinationRoot, "agent-loop-runtime");
  await mkdir(join(targetRoot, "config"), { recursive: true });
  for (const relativePath of [
    ".env.example",
    "config/llm-providers.example.json",
    "config/mcp-servers.json",
  ]) {
    await cp(join(sourceRoot, relativePath), join(targetRoot, relativePath));
  }
}

function resolvePackageDirectory(name, sourceRoot) {
  const candidate = join(sourceRoot, name);
  if (existsDirectory(candidate)) return candidate;
  throw new Error(`Required packaged Node module is not installed: ${name}`);
}

function existsDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function run(command, args, { action, environment = process.env } = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: environment,
  });
  if (result.status !== 0) throw new Error(`Unable to ${action ?? command}: ${result.status ?? "signal"}`);
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Unable to inspect packaged Python: ${result.stderr?.trim() || (result.status ?? "signal")}`);
  return result.stdout.trim();
}
