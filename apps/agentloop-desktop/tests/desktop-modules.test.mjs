import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inventoryDesktopModules, planDesktopModuleTransfer } from '../scripts/desktop-modules.mjs';
import { publishDesktopModuleObjects } from '../scripts/publish-desktop-modules.mjs';
import { stageDesktopModules, validateModuleManifest, verifyDesktopModuleTree } from '../distribution/module-staging.mjs';
import { verifyModuleRelease } from '../distribution/module-release.mjs';
import { checkModuleUpdate } from '../distribution/module-update-client.mjs';
import { openModuleState } from '../distribution/module-state.mjs';

const runtimeConfig = { python: { schema: 'agentloop.packagedRuntimePython/v1', pythonVersion: '3.12', pythonExecutable: 'runtime-python/bin/python3.12', version: '3.12.8', requiredModules: [] }, node: { version: '26.0.0' }, turnDefaults: {} };

test('module identity tracks content and executable mode, independently of config and other modules', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-modules-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['runtime/bin', 'runtime-python/bin', 'web']) await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, 'runtime/bin/node'), 'node', { mode: 0o755 });
  await writeFile(join(root, 'runtime-python/bin/python'), 'python', { mode: 0o755 });
  await writeFile(join(root, 'web/index.html'), 'version 1');
  await writeFile(join(root, 'desktop-config.json'), 'secret');
  const identities = async () => Object.fromEntries((await inventoryDesktopModules(root)).modules.map(m => [m.name, m.sha256]));
  const first = await identities();
  const baseline = await inventoryDesktopModules(root);
  await writeFile(join(root, 'web/index.html'), 'version 2');
  await writeFile(join(root, 'desktop-config.json'), 'other secret');
  const second = await identities();
  const plan = planDesktopModuleTransfer(baseline, await inventoryDesktopModules(root));
  assert.deepEqual(plan.changedModules, ['desktop']);
  assert.equal(plan.downloadBytes, Buffer.byteLength('version 2'));
  assert.notEqual(second.desktop, first.desktop); assert.equal(second.node, first.node); assert.equal(second.python, first.python);
  assert.equal(JSON.stringify(await inventoryDesktopModules(root)).includes('secret'), false);
  await symlink('../../../../etc/passwd', join(root, 'web/escape'));
  await assert.rejects(inventoryDesktopModules(root), /symlink_invalid/);
});

test('publication reuses content objects and refuses a changed packaged baseline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-module-publish-')); t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, 'resources'), objects = join(root, 'objects'); await mkdir(resources);
  await writeFile(join(resources, 'app.js'), 'one'); await writeFile(join(resources, 'desktop-config.json'), 'private');
  const baseline = await inventoryDesktopModules(resources); await writeFile(join(resources, 'desktop-modules.json'), JSON.stringify(baseline));
  assert.deepEqual(await publishDesktopModuleObjects(resources, objects), { count: 1, bytes: 3 });
  assert.deepEqual(await publishDesktopModuleObjects(resources, objects), { count: 0, bytes: 0 });
  const [file] = await readdir(objects); assert.equal((await readFile(join(objects, file))).toString(), 'one');
  await writeFile(join(resources, 'app.js'), 'changed');
  await assert.rejects(publishDesktopModuleObjects(resources, objects), /baseline_mismatch/);
});

test('staging reuses the installed baseline and verifies only the changed download', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-module-stage-')); t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, 'current'), next = join(root, 'next'), staged = join(root, 'staged');
  for (const dir of [current, next]) {
    await mkdir(join(dir, 'runtime'), { recursive: true }); await mkdir(join(dir, 'runtime-python'), { recursive: true });
    await writeFile(join(dir, 'runtime', 'node'), 'node'); await writeFile(join(dir, 'runtime-python', 'python'), 'python');
  }
  await writeFile(join(current, 'app.js'), 'before'); await writeFile(join(next, 'app.js'), 'after');
  const oldManifest = await inventoryDesktopModules(current), newManifest = await inventoryDesktopModules(next);
  const app = newManifest.modules.find(m => m.name === 'desktop').files.find(f => f.path === 'app.js');
  let calls = 0;
  const result = await stageDesktopModules({ currentRoot: current, currentManifest: oldManifest, nextManifest: newManifest, stagingRoot: staged, objectBaseUrl: 'https://updates.example/objects/', fetchObject: async url => { calls++; assert.equal(url.pathname, `/objects/${app.sha256}`); return new Response('after'); } });
  assert.equal(calls, 1); assert.equal(result.downloadedBytes, 5);
  assert.equal(await readFile(join(staged, 'app.js'), 'utf8'), 'after');
  assert.equal(await readFile(join(staged, 'runtime-python', 'python'), 'utf8'), 'python');
  assert.deepEqual(await inventoryDesktopModules(staged), newManifest);
  await verifyDesktopModuleTree(staged, newManifest);
  await writeFile(join(staged, 'unlisted.js'), 'unexpected');
  await assert.rejects(verifyDesktopModuleTree(staged, newManifest), /unexpected_file/);
  const invalid = structuredClone(newManifest); invalid.modules[0].files[0].path = '../escape';
  invalid.modules[0].sha256 = createHash('sha256').update(JSON.stringify(invalid.modules[0].files)).digest('hex');
  assert.throws(() => validateModuleManifest(invalid), /path_invalid/);
  await assert.rejects(stageDesktopModules({ currentRoot: current, currentManifest: oldManifest, nextManifest: newManifest, stagingRoot: join(root, 'corrupt'), objectBaseUrl: 'https://updates.example/objects/', fetchObject: async () => new Response('wrong') }), /object_invalid/);
});

test('update journal retains active version after interruption and rejects rollback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-update-journal-')); t.after(() => rm(root, { recursive: true, force: true }));
  let state = await openModuleState(root, 1);
  await state.observe(2); await state.begin(2);
  state = await openModuleState(root, 1);
  assert.deepEqual(state.value.active, { kind: 'baseline', sequence: 1 });
  assert.equal(state.value.pending, null); assert.equal(state.value.highest, 2);
  await assert.rejects(state.observe(1), /replay/);
  await state.begin(2); await state.commit(2);
  assert.deepEqual((await openModuleState(root, 1)).value.active, { kind: 'module', sequence: 2 });
  assert.deepEqual((await openModuleState(root, 3)).value.active, { kind: 'baseline', sequence: 3 });
  await assert.rejects(openModuleState(root, 1), /baseline_downgrade/);
});

test('signed release binds exact target, bootstrap version and rollback-compatible data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-module-feed-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'app.js'), 'content');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const target = { platform: 'mac', arch: 'arm64', channel: 'production', bootstrap: 1 };
  const release = { schema: 'agentloop.desktop.module-release/v1', ...target, minimumBootstrap: 1, sequence: 2, version: '0.2.0', dataCompatibility: 'backward-compatible', generatedAt: new Date(Date.now()-1000).toISOString(), expiresAt: new Date(Date.now()+86400000).toISOString(), objectBaseUrl: 'https://updates.example/objects/', runtimeConfig, modules: await inventoryDesktopModules(root) };
  const verify = value => { const bytes = Buffer.from(JSON.stringify(value)); return verifyModuleRelease(bytes, sign(null, bytes, privateKey), publicKey, target); };
  assert.equal(verify(release).sequence, 2);
  assert.throws(() => verify({ ...release, minimumBootstrap: 2 }), /incompatible/);
  assert.throws(() => verify({ ...release, dataCompatibility: 'irreversible' }), /incompatible/);
  assert.throws(() => verify({ ...release, arch: 'x64' }), /incompatible/);
  assert.throws(() => verify({ ...release, objectBaseUrl: 'http://updates.example/objects/' }), /url_invalid/);
});

test('release publisher signs packaged module identity without publishing private configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-module-release-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const privatePath = join(root, 'private.pem'), publicPath = join(root, 'public.pem'), resources = join(root, 'resources'), output = join(root, 'release.json');
  await writeFile(privatePath, privateKey); await writeFile(publicPath, publicKey); await mkdir(resources);
  await writeFile(join(resources, 'app.js'), 'code');
  await writeFile(join(resources, 'desktop-config.json'), JSON.stringify({ platform: 'mac', arch: 'arm64', channel: 'production', version: '0.2.0', update: { sequence: 3 }, ...runtimeConfig, secret: 'private-example' }));
  await writeFile(join(resources, 'desktop-modules.json'), JSON.stringify(await inventoryDesktopModules(resources)));
  const result = spawnSync(process.execPath, [new URL('../scripts/create-module-release.mjs', import.meta.url).pathname, '--resources', resources, '--private-key', privatePath, '--public-key', publicPath, '--object-base-url', 'https://updates.example/desktop-updates/objects/', '--expires-at', new Date(Date.now()+86400000).toISOString(), '--minimum-bootstrap', '1', '--data-compatibility', 'backward-compatible', '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(await readFile(output, 'utf8')), payload = Buffer.from(envelope.payload, 'base64');
  assert.equal(payload.includes('private-example'), false);
  assert.equal(verifyModuleRelease(payload, Buffer.from(envelope.signature, 'base64'), publicKey, { platform: 'mac', arch: 'arm64', channel: 'production', bootstrap: 1 }).sequence, 3);
  const check = (installedSequence, highestAcceptedSequence) => checkModuleUpdate({ feedUrl: 'https://updates.example/feed', publicKey, target: { platform: 'mac', arch: 'arm64', channel: 'production', bootstrap: 1 }, installedSequence, highestAcceptedSequence, fetchFeed: async () => new Response(JSON.stringify(envelope)) });
  assert.equal((await check(2, 2)).release.sequence, 3);
  await assert.rejects(check(2, 4), /replay/);
  assert.equal((await check(3, 3)).release, undefined);
  const objects = join(root, 'objects'), publicRoot = join(root, 'published');
  await publishDesktopModuleObjects(resources, objects);
  const install = () => spawnSync(process.execPath, [new URL('../scripts/install-module-release.mjs', import.meta.url).pathname, '--root', publicRoot, '--feed', output, '--objects', objects, '--public-key', publicPath, '--base-url', 'https://updates.example', '--bootstrap', '1'], { encoding: 'utf8' });
  const installed = install(); assert.equal(installed.status, 0, installed.stderr);
  assert.equal(await readFile(join(publicRoot, 'production-arm64.json'), 'utf8'), await readFile(output, 'utf8'));
  assert.equal((await readdir(join(publicRoot, 'objects'))).length, 1);
  assert.equal(install().status, 0);
});
