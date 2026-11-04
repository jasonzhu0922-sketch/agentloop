import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Resolve developer-installed tools once, before entering the account sandbox.
 * Skill copies and conversation workspaces are outside the repository's module
 * ancestry; neither those directories nor a pyenv shim can discover these paths.
 */
export async function developmentToolEnvironment(inherited = process.env): Promise<Record<string, string>> {
  const kernel = createRequire(import.meta.resolve("@zhujun/agentloop/package.json"));
  const moduleRoots = new Set<string>();
  for (const name of ["jszip", "pptxgenjs", "docx"]) {
    let path = dirname(kernel.resolve(name));
    while (basename(path) !== "node_modules") {
      const parent = dirname(path);
      if (parent === path) throw new Error("desktop_development_modules_invalid");
      path = parent;
    }
    moduleRoots.add(await realpath(path));
  }
  // Execute the host's selected interpreter only to resolve its real executable.
  // The sandbox receives its installation bin, never the host's pyenv shim.
  const pythonEnvironment = { PATH: inherited.PATH, SystemRoot: inherited.SystemRoot,
    PYTHONHOME: "", PYTHONPATH: "", PYTHONUSERBASE: "", PYTHONNOUSERSITE: "1" };
  const { stdout } = await execute(inherited.RUNTIME_PYTHON || "python3", ["-I", "-B", "-c",
    "import json, sys; print(json.dumps(sys.executable))"], { env: pythonEnvironment, timeout: 10_000 });
  const selected: unknown = JSON.parse(stdout);
  if (typeof selected !== "string" || !isAbsolute(selected)) throw new Error("desktop_development_python_invalid");
  const python = await realpath(selected);
  return {
    PATH: [dirname(process.execPath), dirname(python), inherited.PATH ?? ""].filter(Boolean).join(delimiter),
    NODE_PATH: [...moduleRoots].join(delimiter), RUNTIME_PYTHON: python,
    PYTHONHOME: "", PYTHONPATH: "", PYTHONUSERBASE: "", VIRTUAL_ENV: "",
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
  };
}
