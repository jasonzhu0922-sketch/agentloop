import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageOptions, copyRuntimeDependencies, packagedTurnDefaults, packagedSearchDefaults, packagedUpdateConfig } from '../scripts/package-support.mjs';
import { generateKeyPairSync } from 'node:crypto';

test('update package configuration requires a separately supplied Ed25519 trust root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-update-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { publicKey } = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const key = join(root, 'public.pem'); await writeFile(key, publicKey);
  const env = { AGENTLOOP_DESKTOP_UPDATE_URL: 'https://example.com/feed', AGENTLOOP_DESKTOP_UPDATE_PUBLIC_KEY_FILE: key, AGENTLOOP_DESKTOP_UPDATE_SEQUENCE: '7' };
  assert.equal((await packagedUpdateConfig(env)).sequence, 7);
  assert.equal(await packagedUpdateConfig({}), undefined);
  await assert.rejects(packagedUpdateConfig({ ...env, AGENTLOOP_DESKTOP_UPDATE_URL: 'http://example.com/feed' }), /HTTPS/);
  await assert.rejects(packagedUpdateConfig({ ...env, AGENTLOOP_DESKTOP_UPDATE_SEQUENCE: '0' }), /positive sequence/);
});

test('package accepts optional search defaults and does not accept insecure endpoints', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-search-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, '.env');
  await writeFile(path, 'WEB_SEARCH_DISABLED=0\nWEB_SEARCH_PROVIDER=bocha\nWEB_SEARCH_ENDPOINT=https://search.example/v1\nWEB_SEARCH_API_KEY=example\n');
  assert.deepEqual(await packagedSearchDefaults(path), { searchProvider: 'bocha', searchEndpoint: 'https://search.example/v1', searchApiKey: 'example' });
  await writeFile(path, 'WEB_SEARCH_DISABLED=0\nWEB_SEARCH_PROVIDER=bocha\nWEB_SEARCH_ENDPOINT=http://search.example/v1\nWEB_SEARCH_API_KEY=example\n');
  await assert.rejects(packagedSearchDefaults(path), /HTTPS/);
  await writeFile(path, 'WEB_SEARCH_DISABLED=0\nWEB_SEARCH_PROVIDER=bocha\n');
  assert.equal(await packagedSearchDefaults(path), undefined);
});

test('package snapshots only validated turn limits from Desktop environment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-turn-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, '.env');
  assert.deepEqual(await packagedTurnDefaults(path), {});
  await writeFile(path, 'PLANNING_MAX_TURNS=8\nSTEP_MAX_TURNS=64\nWEB_SEARCH_API_KEY=private\n');
  assert.deepEqual(await packagedTurnDefaults(path), { planningMaxTurns: 8, stepMaxTurns: 64 });
  await writeFile(path, 'PLANNING_MAX_TURNS=65\n');
  await assert.rejects(packagedTurnDefaults(path), /planning_max_turns_invalid/);
});

test('macOS tray starts Node with system trust and preserves a configured CA bundle', async () => {
  const tray = await readFile(new URL('../distribution/macos/DesktopTray.swift', import.meta.url), 'utf8');
  assert.match(tray, /environment\["NODE_EXTRA_CA_CERTS"\] \?\? ""\)\.isEmpty/);
  assert.match(tray, /isReadableFile\(atPath: "\/etc\/ssl\/cert\.pem"\)/);
  assert.match(tray, /environment\["NODE_EXTRA_CA_CERTS"\] = "\/etc\/ssl\/cert\.pem"/);
  assert.match(tray, /child\.arguments = \["--use-system-ca",/);
  assert.match(tray, /status-icon\.png/);
  assert.match(tray, /image\.isTemplate = true/);
});

test('local and production packages keep endpoints and identities distinct', () => {
  const local = packageOptions(['--platform', 'mac', '--channel', 'local'], 'darwin', 'arm64');
  assert.equal(local.target, 'pkg');
  assert.equal(packageOptions(['--channel', 'local', '--target', 'dmg'], 'darwin', 'arm64').target, 'dmg');
  assert.equal(local.accountServiceUrl, 'http://127.0.0.1:8795');
  const production = packageOptions(['--platform', 'win', '--account-service', 'https://accounts.example.com'], 'win32', 'x64');
  assert.notEqual(local.appId, production.appId);
  assert.equal(production.displayName, '玄武');
  assert.equal(production.dataDirectoryName, 'AgentLoop Desktop');
  assert.equal(production.productName, 'AgentLoop Desktop'); // Windows package identity is unchanged.
  assert.equal(packageOptions(['--account-service', 'https://accounts.example.com'], 'darwin', 'arm64').productName, '玄武');
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
