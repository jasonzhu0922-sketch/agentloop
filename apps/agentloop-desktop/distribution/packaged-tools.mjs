import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Host-owned paths, never sourced from browser settings or inherited Python state. */
export async function packagedToolEnvironment(root, config, inherited = process.env, platform = process.platform) {
  const windows = platform === 'win32';
  const pythonRoot = join(root, 'runtime-python');
  const pythonExecutable = windows ? 'python.exe' : 'bin/python3.12';
  const toolsDirectory = windows ? 'Scripts' : 'bin';
  const marker = JSON.parse(await readFile(join(pythonRoot, 'agentloop-runtime-python.json'), 'utf8'));
  if (marker.schema !== 'agentloop.packagedRuntimePython/v1' || marker.pythonVersion !== '3.12'
    || marker.pythonExecutable !== pythonExecutable || marker.toolsDirectory !== toolsDirectory
    || config.python?.pythonExecutable !== `runtime-python/${pythonExecutable}`
    || !config.python?.version?.startsWith('3.12.') || !Array.isArray(config.python?.requiredModules)) {
    throw new Error('desktop_packaged_python_manifest_invalid');
  }
  const python = join(pythonRoot, pythonExecutable);
  await access(python);
  await access(join(root, 'runtime/bin', windows ? 'node.exe' : 'node'));
  return {
    PATH: [join(root, 'runtime/bin'), join(pythonRoot, toolsDirectory), pythonRoot, inherited.PATH ?? inherited.Path ?? ''].filter(Boolean).join(windows ? ';' : ':'),
    NODE_PATH: join(root, 'node_modules'),
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    // Explicitly neutralize host interpreter settings for MCP subprocesses as well.
    PYTHONHOME: '', PYTHONPATH: '', PYTHONUSERBASE: '', VIRTUAL_ENV: '',
    RUNTIME_PYTHON: python,
  };
}

export async function verifyPackagedPython(root, config, environment) {
  // Isolated imports prove modules belong to the packaged prefix, even on a
  // developer machine with global/user Python packages installed.
  const probe = `import importlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
assert pathlib.Path(sys.prefix).resolve() == root
assert sys.version.split()[0] == sys.argv[2]
for name in json.loads(sys.argv[3]):
 module = importlib.import_module(name)
 assert pathlib.Path(module.__file__).resolve().is_relative_to(root), name
import importlib.metadata
assert importlib.metadata.version('markitdown') == '0.1.7'
`;
  await execute(environment.RUNTIME_PYTHON, ['-I', '-B', '-c', probe, join(root, 'runtime-python'), config.python.version, JSON.stringify(config.python.requiredModules)], { env: { ...process.env, ...environment }, timeout: 30000 });
}
