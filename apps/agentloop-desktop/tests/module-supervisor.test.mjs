import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inventoryDesktopModules } from '../scripts/desktop-modules.mjs';
import { startModuleSupervisor } from '../distribution/module-supervisor.mjs';

const waitFor = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('supervisor event timeout'); };

test('supervisor entry executes when invoked through a symlinked path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-supervisor-entry-')); t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'supervisor.mjs'); await symlink(new URL('../distribution/module-supervisor.mjs', import.meta.url).pathname, entry);
  const run = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: { ...process.env, AGENTLOOP_DESKTOP_DATA_DIR: '' } });
  assert.equal(run.status, 1); assert.match(run.stdout, /startup-error/);
});

// Online updates may change the product version or only advance the sequence.
for (const releaseVersion of ['0.2.0', '0.1.0']) {
test(`trusted supervisor preserves active version and sequence through update/recovery (${releaseVersion})`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-supervisor-')); t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'base'), next = join(root, 'next'), dataRoot = join(root, 'data');
  for (const path of [base, next]) {
    await mkdir(join(path, 'runtime/bin'), { recursive: true }); await mkdir(join(path, 'runtime-python'), { recursive: true });
    await writeFile(join(path, 'runtime/bin/node'), 'node'); await writeFile(join(path, 'runtime-python/python'), 'python');
    await writeFile(join(path, 'backend.mjs'), 'same backend');
  }
  await writeFile(join(base, 'app.js'), 'old'); await writeFile(join(next, 'app.js'), 'new version');
  const oldManifest = await inventoryDesktopModules(base), nextManifest = await inventoryDesktopModules(next);
  await writeFile(join(base, 'desktop-modules.json'), JSON.stringify(oldManifest));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const runtimeConfig = { python: { schema: 'agentloop.packagedRuntimePython/v1', pythonVersion: '3.12', pythonExecutable: 'runtime-python/bin/python3.12', version: '3.12.8', requiredModules: [] }, node: { version: '26.0.0' }, turnDefaults: {} };
  const update = { platform: 'mac', arch: 'arm64', channel: 'production', sequence: 1, feedUrl: 'https://updates.example/feed', publicKey };
  await writeFile(join(base, 'desktop-config.json'), JSON.stringify({ ...runtimeConfig, update, version: '0.1.0', accountServiceUrl: 'https://accounts.example' }));
  const release = { schema: 'agentloop.desktop.module-release/v1', platform: 'mac', arch: 'arm64', channel: 'production', sequence: 2, version: releaseVersion, minimumBootstrap: 1, dataCompatibility: 'backward-compatible', generatedAt: new Date(Date.now()-1000).toISOString(), expiresAt: new Date(Date.now()+86400000).toISOString(), objectBaseUrl: 'https://updates.example/objects/', runtimeConfig, modules: nextManifest };
  const bytes = Buffer.from(JSON.stringify(release)); const envelope = { payload: bytes.toString('base64'), signature: sign(null, bytes, privateKey).toString('base64') };
  const events = [], roots = []; let downloads = 0, closeAttempts = 0, failCandidate = true;
  function fakeSpawn(_executable, _args, options) {
    const p = new EventEmitter(); p.stdout = new PassThrough(); roots.push(options.cwd);
    const send = message => p.stdout.write(`AGENTLOOP_DESKTOP:${JSON.stringify(message)}\n`);
    p.stdin = new Writable({ write(_data, _encoding, done) {
      closeAttempts++;
      if (closeAttempts === 1) send({ type: 'close-refused' });
      else if (closeAttempts === 2) { p.stdout.end(); setImmediate(() => p.emit('close', 1)); }
      else { send({ type: 'closed' }); setImmediate(() => { p.stdout.end(); p.emit('close', 0); }); }
      done();
    } });
    p.kill = () => { p.stdout.end(); p.emit('close', 1); };
    setImmediate(async () => {
      if (options.cwd !== base && failCandidate) { failCandidate = false; p.stdout.end(); p.emit('close', 1); }
      else {
        const config = JSON.parse(await readFile(join(options.cwd, 'desktop-config.json'), 'utf8'));
        send({ type: 'ready', origin: 'http://127.0.0.1:1234', version: config.version, updateSequence: config.update?.sequence });
      }
    });
    return p;
  }
  const supervisor = await startModuleSupervisor({ resources: base, dataRoot, emit: m => events.push(m), spawnProcess: fakeSpawn,
    fetchFeed: async () => new Response(JSON.stringify(envelope)), fetchObject: async () => { downloads++; return new Response('new version'); } });
  await waitFor(() => events.some(e => e.type === 'ready'));
  assert.equal(events.find(e => e.type === 'ready').version, '0.1.0');
  assert.equal(events.find(e => e.type === 'ready').updateSequence, 1);
  await supervisor.check(); assert.ok(events.some(e => e.type === 'update-available'));
  await supervisor.download(); assert.equal(downloads, 1); assert.ok(events.some(e => e.type === 'update-staged'));
  assert.equal(events.filter(e => e.type === 'ready').at(-1).updateSequence, 1);
  supervisor.apply(); await waitFor(() => events.some(e => e.type === 'update-busy'));
  assert.equal(supervisor.state.active.sequence, 1); assert.equal(roots.length, 1);
  supervisor.apply(); await waitFor(() => events.some(e => e.type === 'update-error') && events.filter(e => e.type === 'ready').length === 2);
  assert.equal(supervisor.state.active.sequence, 1); assert.equal(roots.length, 2);
  supervisor.apply(); await waitFor(() => events.some(e => e.type === 'update-rolled-back') && events.filter(e => e.type === 'ready').length === 3);
  assert.equal(supervisor.state.active.sequence, 1); assert.equal(roots.length, 4);
  assert.equal(events.filter(e => e.type === 'ready').at(-1).updateSequence, 1);
  supervisor.apply(); await waitFor(() => events.some(e => e.type === 'update-installed'));
  assert.equal(supervisor.state.active.sequence, 2); assert.equal(roots.length, 5);
  assert.equal(events.filter(e => e.type === 'ready').at(-1).version, releaseVersion);
  assert.equal(events.filter(e => e.type === 'ready').at(-1).updateSequence, 2);
  assert.equal(await readFile(join(roots[4], 'app.js'), 'utf8'), 'new version');
  supervisor.close(); await waitFor(() => events.some(e => e.type === 'supervisor-closed'));
});
}
