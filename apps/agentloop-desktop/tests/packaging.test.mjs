import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageOptions, copyRuntimeDependencies } from '../scripts/package-support.mjs';

test('local and production packages keep endpoints and identities distinct', () => {
  const local = packageOptions(['--platform', 'mac', '--channel', 'local'], 'darwin', 'arm64');
  assert.equal(local.target, 'pkg');
  assert.equal(packageOptions(['--channel', 'local', '--target', 'dmg'], 'darwin', 'arm64').target, 'dmg');
  assert.equal(local.accountServiceUrl, 'http://127.0.0.1:8795');
  const production = packageOptions(['--platform', 'win', '--account-service', 'https://accounts.example.com'], 'win32', 'x64');
  assert.notEqual(local.appId, production.appId);
  assert.notEqual(local.dataDirectoryName, production.dataDirectoryName);
  assert.equal(production.target, 'zip');
  for (const url of ['http://accounts.example.com', 'http://127.0.0.1:8795', 'https://127.0.0.1:8795', 'https://user:pass@example.com', 'https://example.com?token=secret']) {
    assert.throws(() => packageOptions(['--account-service', url], 'darwin', 'arm64'));
  }
  assert.throws(() => packageOptions([], 'darwin', 'arm64'), /require/);
  assert.throws(() => packageOptions(['--platform', 'win'], 'darwin', 'arm64'), /Windows/);
  assert.throws(() => packageOptions(['--channel', 'local', '--arch', 'x64'], 'darwin', 'arm64'), /architecture/);
  assert.throws(() => packageOptions(['--channel', 'local', '--unknown', 'value'], 'darwin', 'arm64'), /Invalid/);
});

test('dependency closure preserves nested versions and excludes workspace secrets and source files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-package-closure-'));
  try {
    const repo = join(root, 'repo'), output = join(root, 'output');
    const workspace = join(repo, 'packages/kernel');
    await mkdir(join(workspace, 'dist'), { recursive: true });
    await mkdir(join(workspace, 'config'));
    await writeFile(join(workspace, 'config/private.json'), 'do not ship');
    await writeFile(join(workspace, '.env'), 'do not ship');
    await writeFile(join(workspace, 'dist/index.js'), 'export const ready = true;');
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: '@test/kernel', version: '1.0.0', dependencies: { alpha: '1', shared: '2' } }));
    const { symlink } = await import('node:fs/promises');
    await mkdir(join(repo, 'node_modules/@test'), { recursive: true });
    await symlink(workspace, join(repo, 'node_modules/@test/kernel'), 'junction');
    for (const [path, name, version, dependencies] of [['alpha', 'alpha', '1', { shared: '1' }], ['alpha/node_modules/shared', 'shared', '1', {}], ['shared', 'shared', '2', {}]]) {
      const directory = join(repo, 'node_modules', path); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version, dependencies }));
    }
    await copyRuntimeDependencies(repo, output, ['@test/kernel']);
    assert.equal(JSON.parse(await readFile(join(output, 'node_modules/alpha/node_modules/shared/package.json'))).version, '1');
    assert.equal(JSON.parse(await readFile(join(output, 'node_modules/shared/package.json'))).version, '2');
    await access(join(output, 'node_modules/@test/kernel/dist/index.js'));
    await assert.rejects(access(join(output, 'node_modules/@test/kernel/.env')));
    await assert.rejects(access(join(output, 'node_modules/@test/kernel/config/private.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
