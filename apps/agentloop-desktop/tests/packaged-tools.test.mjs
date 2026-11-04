import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packagedToolEnvironment } from '../distribution/packaged-tools.mjs';
import { requiredPythonRoot } from '../scripts/package-python.mjs';

test('packaging requires standalone Python; missing payload never falls back to host Python', async () => {
  await assert.rejects(requiredPythonRoot({}), /Python is mandatory/);
  const root = await mkdtemp(join(tmpdir(), 'desktop-python-required-'));
  try {
    await assert.rejects(packagedToolEnvironment(root, {}), { code: 'ENOENT' });
    await writeFile(join(root, 'pyvenv.cfg'), 'home = /host/python');
    await assert.rejects(requiredPythonRoot({ AGENTLOOP_PACKAGED_PYTHON_ROOT: root }), /not a virtualenv/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const platform of ['darwin', 'win32']) test(`packaged ${platform} tools override host paths without inheriting Python configuration`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-tools-'));
  try {
    const windows = platform === 'win32';
    const executable = windows ? 'python.exe' : 'bin/python3.12';
    await mkdir(join(root, 'runtime-python/bin'), { recursive: true });
    await mkdir(join(root, 'runtime/bin'), { recursive: true });
    await writeFile(join(root, 'runtime-python', executable), '');
    await writeFile(join(root, 'runtime/bin', windows ? 'node.exe' : 'node'), '');
    const marker = { schema: 'agentloop.packagedRuntimePython/v1', pythonVersion: '3.12', pythonExecutable: executable, toolsDirectory: windows ? 'Scripts' : 'bin' };
    await writeFile(join(root, 'runtime-python/agentloop-runtime-python.json'), JSON.stringify(marker));
    const config = { python: { version: '3.12.8', pythonExecutable: `runtime-python/${executable}`, requiredModules: ['openpyxl'] } };
    const env = await packagedToolEnvironment(root, config, { PATH: '/host/bin', PYTHONHOME: '/host/python', NODE_PATH: '/host/modules', SECRET_VALUE: 'do-not-forward' }, platform);
    assert.equal(env.PATH.split(windows ? ';' : ':')[0], join(root, 'runtime/bin'));
    assert.equal(env.NODE_PATH, join(root, 'node_modules'));
    assert.equal(env.PYTHONHOME, ''); assert.equal(env.PYTHONPATH, ''); assert.equal(env.PYTHONNOUSERSITE, '1');
    assert.equal(env.SECRET_VALUE, undefined);
    await rm(join(root, 'runtime-python', executable));
    await assert.rejects(packagedToolEnvironment(root, config, { PATH: '/host/bin' }, platform), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
