import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const COMMAND_NAME = /^[a-zA-Z0-9._-]+$/;
const PYTHON_MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NODE_MODULE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const runtimeRequire = createRequire(import.meta.url);
const COMMAND_VERSION_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  ffmpeg: ["-version"],
  pdfinfo: ["-v"],
  pdftoppm: ["-v"],
  pdftotext: ["-v"],
  unzip: ["-v"],
  zip: ["-v"],
};

/** The version probe must match the executable's CLI contract, not an assumption. */
export function runtimeCommandProbeArguments(command: string): readonly string[] {
  return COMMAND_VERSION_ARGUMENTS[command] ?? ["--version"];
}

/** `playwright install --list` reports installed browsers as absolute paths. */
export function hasRuntimePlaywrightChromium(output: string): boolean {
  return /(?:^|\n)\s*\S*chromium(?:[-_ ]|$)/.test(output);
}

export function requiredRuntimeCommands(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  const commands = raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  for (const command of commands) {
    if (!COMMAND_NAME.test(command)) throw new Error(`Invalid required Runtime command: ${command}`);
  }
  return [...new Set(commands)];
}

export function assertRequiredRuntimeCommands(commands: readonly string[]): void {
  for (const command of commands) {
    const result = spawnSync(command, runtimeCommandProbeArguments(command), {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.error !== undefined || result.status !== 0) {
      const detail = result.error?.message ?? (result.stderr.trim() || `exit status ${result.status ?? "unknown"}`);
      throw new Error(`Required Runtime command is unavailable: ${command} (${detail})`);
    }
  }
}

/**
 * Proves importability in the Python interpreter that a Host will actually
 * expose through PATH.  Checking only `python3 --version` would admit a Host
 * that can launch Python but cannot execute a configured Python-backed Skill.
 */
export function requiredRuntimePythonModules(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  const modules = raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  for (const module of modules) {
    if (!PYTHON_MODULE_NAME.test(module)) throw new Error(`Invalid required Runtime Python module: ${module}`);
  }
  return [...new Set(modules)];
}

export function assertRequiredRuntimePythonModules(modules: readonly string[], python = "python3"): void {
  for (const module of modules) {
    const result = spawnSync(python, ["-c", "import importlib, sys; importlib.import_module(sys.argv[1])", module], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.error !== undefined || result.status !== 0) {
      const detail = result.error?.message ?? (result.stderr.trim() || `exit status ${result.status ?? "unknown"}`);
      throw new Error(`Required Runtime Python module is unavailable: ${module} (${detail})`);
    }
  }
  if (modules.includes("playwright")) {
    const result = spawnSync(python, ["-m", "playwright", "install", "--list"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.error !== undefined || result.status !== 0 || !hasRuntimePlaywrightChromium(result.stdout)) {
      const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim() || `exit status ${result.status ?? "unknown"}`);
      throw new Error(`Required Runtime Playwright Chromium is unavailable (${detail})`);
    }
  }
}

/** Load declared Node packages before the Host becomes schedulable. */
export function requiredRuntimeNodeModules(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  const modules = raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  for (const module of modules) {
    if (!NODE_MODULE_NAME.test(module)) throw new Error(`Invalid required Runtime Node module: ${module}`);
  }
  return [...new Set(modules)];
}

export function assertRequiredRuntimeNodeModules(
  modules: readonly string[],
  loadModule: (module: string) => unknown = runtimeRequire,
): void {
  for (const module of modules) {
    try {
      loadModule(module);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Required Runtime Node module is unavailable: ${module} (${detail})`);
    }
  }
}
