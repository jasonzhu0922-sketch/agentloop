import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packagedPythonRequirementsProbe } from '../../agentloop-multi-runtime/scripts/packaged-python-requirements.mjs';

// Use real importlib.metadata resolution with small installed-distribution
// fixtures. No pip, network, database or production account is required.
async function fixture(t, requirements, distributions) {
  const root = await mkdtemp(join(tmpdir(), 'packaged-python-requirements-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const site = join(root, 'site-packages');
  await mkdir(site);
  for (const [name, version, metadata = ''] of distributions) {
    const path = join(site, `${name}-${version}.dist-info`);
    await mkdir(path);
    await writeFile(join(path, 'METADATA'), `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n${metadata}\n`);
  }
  const path = join(root, 'requirements.txt');
  await writeFile(path, requirements);
  return (prefix = root) => spawnSync(process.env.AGENTLOOP_TEST_PYTHON ?? 'python3', ['-I', '-B', '-c',
    `import sys; sys.path.insert(0, sys.argv.pop(3)); exec(${JSON.stringify(packagedPythonRequirementsProbe)})`, path, prefix, site],
  { encoding: 'utf8', timeout: 30000 });
}

test('package requirements follow selected extras, transitive dependencies, markers and cycles', async t => {
  const run = await fixture(t, '# installed baseline\nclient[binary]>=1,<2\n', [
    ['client', '1.2', 'Provides-Extra: binary\nRequires-Dist: driver>=2; extra == "binary"\nRequires-Dist: absent; python_version < "3.0"'],
    ['driver', '2.3', 'Requires-Dist: client>=1'],
  ]);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /requirements verified/);
});

test('an installed top-level distribution cannot hide a missing binary extra', async t => {
  const run = await fixture(t, 'client[binary]>=1\n', [
    ['client', '1.2', 'Provides-Extra: binary\nRequires-Dist: missing_driver==1.2; extra == "binary"'],
  ]);
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /client\[binary\]>=1: missing packaged dependency missing_driver==1.2/);
});

test('package requirements reject incompatible versions and misspelled extras', async t => {
  for (const [requirement, diagnostic] of [['client>=2', /requires a different version; packaged 1.2/], ['client[typo]', /has no extras/]]) {
    const run = await fixture(t, requirement, [['client', '1.2']]);
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, diagnostic);
  }
});

test('package requirements reject dependencies supplied by an external prefix', async t => {
  const run = await fixture(t, 'client>=1\n', [['client', '1.2']]);
  const result = run(join(tmpdir(), 'another-python-prefix'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /client resolved outside packaged Python/);
});

test('package requirements reject missing root dependencies even if import inventory omitted them', async t => {
  const run = await fixture(t, 'newly_declared_dependency>=1\n', []);
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requirements.txt:1: missing packaged dependency newly_declared_dependency>=1/);
});
