import { existsSync } from 'node:fs';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// Build-only reuse: Desktop and Local Agent must ship the same Python baseline.
import { preparePackagedPythonRuntime } from '../../agentloop-multi-runtime/scripts/package-local-agent-runtime.mjs';
import { requiredLocalRuntimePythonModules } from '../../agentloop-multi-runtime/scripts/local-runtime-tools.mjs';

function capture(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONHOME: '', PYTHONPATH: '' } });
  if (result.status !== 0) throw new Error(`Packaged Python validation failed: ${result.stderr?.trim() || result.error?.message || result.status}`);
  return result.stdout.trim();
}

export async function requiredPythonRoot(environment = process.env) {
  if (!environment.AGENTLOOP_PACKAGED_PYTHON_ROOT?.trim()) throw new Error('Python is mandatory: set AGENTLOOP_PACKAGED_PYTHON_ROOT to a relocatable Python 3.12 distribution, as for Local Agent.');
  const root = await realpath(resolve(environment.AGENTLOOP_PACKAGED_PYTHON_ROOT));
  if (existsSync(join(root, 'pyvenv.cfg'))) throw new Error('Use a standalone Python distribution, not a virtualenv.');
  const executable = join(root, process.platform === 'win32' ? 'python.exe' : 'bin/python3.12');
  const info = JSON.parse(capture(executable, ['-I', '-c', 'import json,sys,platform; print(json.dumps({"version":sys.version.split()[0],"prefix":sys.prefix,"base":sys.base_prefix,"arch":platform.machine()}))']));
  const expectedArch = process.arch === 'arm64' ? ['arm64', 'aarch64', 'ARM64'] : ['x86_64', 'AMD64', 'amd64'];
  if (!info.version.startsWith('3.12.') || await realpath(info.prefix) !== root || await realpath(info.base) !== root || !expectedArch.includes(info.arch)) throw new Error('Python must be a standalone 3.12 distribution matching the build architecture.');
  return root;
}

export async function packagePython(sourceRoot, destinationRoot, requirementsPath) {
  const marker = await preparePackagedPythonRuntime({ sourceRoot, destinationRoot, requirementsPath });
  const executable = join(destinationRoot, marker.pythonExecutable);
  const inventory = JSON.parse(capture(executable, ['-I', '-B', '-c', 'import json,sys,importlib.metadata as m; print(json.dumps({"version":sys.version.split()[0],"packages":sorted([{"name":d.metadata["Name"],"version":d.version} for d in m.distributions()], key=lambda d:d["name"].lower())}))']));
  await writeFile(join(destinationRoot, 'packages.json'), JSON.stringify(inventory.packages, null, 2) + '\n');
  return { ...marker, version: inventory.version, pythonExecutable: `runtime-python/${marker.pythonExecutable}`, requiredModules: [...requiredLocalRuntimePythonModules({}), 'markitdown'], requirementsSha256: createHash('sha256').update(await readFile(requirementsPath)).digest('hex') };
}
