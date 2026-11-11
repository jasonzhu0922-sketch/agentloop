import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadNativeInstaller, nativeUpdateRequired, verifyNativeInstaller } from '../distribution/native-update.mjs';
import { startModuleSupervisor } from '../distribution/module-supervisor.mjs';
import { inventoryDesktopModules } from '../scripts/desktop-modules.mjs';
import { nativeHostIdentity, nativeHostInputFiles } from '../scripts/native-host-identity.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pkg = Buffer.from('xar!native-tray-and-supervisor-v2');
const installer = { url: 'https://updates.example/downloads/desktop/production-arm64/desktop-2.pkg', size: pkg.length, sha256: digest(pkg) };
const waitFor = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('update event timeout'); };
async function temp(t) { const root = await mkdtemp(join(tmpdir(), 'desktop-native-update-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('native identity changes for the tray, trusted supervisor and toolchain, independently of backend code and sequence', async t => {
  const root = await temp(t), config = { version: '1.0.0', node: { version: '26.0.0' }, nativeToolchain: { swift: '6.2', sdk: '26' }, update: { sequence: 1 } };
  for (const path of nativeHostInputFiles) {
    const target = join(root, path); await mkdir(dirname(target), { recursive: true });
    await copyFile(new URL('../' + path, import.meta.url), target);
  }
  const first = await nativeHostIdentity(root, config);
  await writeFile(join(root, 'distribution/backend.mjs'), 'new backend'); config.update.sequence = 2;
  assert.equal(await nativeHostIdentity(root, config), first);
  const tray = join(root, 'distribution/macos/DesktopTray.swift'); await writeFile(tray, 'new version menu');
  const second = await nativeHostIdentity(root, config); assert.notEqual(second, first);
  await writeFile(join(root, 'distribution/module-supervisor.mjs'), 'new bootstrap');
  const third = await nativeHostIdentity(root, config); assert.notEqual(third, second);
  config.nativeToolchain.sdk = '27'; assert.notEqual(await nativeHostIdentity(root, config), third);
  assert.equal(nativeUpdateRequired({ update: { nativeHostSha256: first } }, { nativeHostSha256: first, minimumBootstrap: 3 }), false);
  assert.equal(nativeUpdateRequired({ update: { nativeHostSha256: first } }, { nativeHostSha256: first, minimumBootstrap: 4 }), true);
});

test('a product version upgrade preserves native identity and selects module updates', async t => {
  const f = await supervisorFixture(t), buildRoot = join(f.root, 'native-build');
  for (const path of nativeHostInputFiles) {
    const target = join(buildRoot, path); await mkdir(dirname(target), { recursive: true });
    await copyFile(new URL('../' + path, import.meta.url), target);
  }
  f.config.version = '0.1.8';
  f.config.update.nativeHostSha256 = await nativeHostIdentity(buildRoot, f.config);
  f.release.version = '0.1.9';
  f.release.nativeHostSha256 = await nativeHostIdentity(buildRoot, { ...f.config, version: f.release.version });
  assert.equal(f.release.nativeHostSha256, f.config.update.nativeHostSha256);
  await writeFile(f.configPath, JSON.stringify(f.config));
  const s = await f.start(); t.after(() => s.close());
  await waitFor(() => f.events.some(e => e.type === 'ready'));
  await s.check();
  assert.equal(f.events.at(-1).type, 'update-available');
  assert.equal(f.events.at(-1).version, '0.1.9');
  assert.equal(f.events.at(-1).mode, 'module');
  assert.equal(f.opened.length, 0);
  s.close(); await waitFor(() => f.events.some(e => e.type === 'supervisor-closed'));
});

test('native package download reports real bytes, verifies the signed digest and rechecks cached installers', async t => {
  const root = await temp(t), path = join(root, 'desktop.pkg'), progress = []; let calls = 0, verifying = false;
  await downloadNativeInstaller({ installer, path, fetchInstaller: async (url, options) => {
    calls++; assert.equal(url, installer.url); assert.equal(options.redirect, 'error');
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(pkg.subarray(0, 8)); controller.enqueue(pkg.subarray(8)); controller.close(); } }));
  }, onProgress: (bytes, total) => progress.push([bytes, total]), onVerifying: () => { verifying = true; } });
  assert.equal(verifying, true); assert.deepEqual(progress, [[8, pkg.length], [pkg.length, pkg.length]]);
  await verifyNativeInstaller(path, installer);
  await downloadNativeInstaller({ installer, path, fetchInstaller: () => { throw new Error('should use verified cache'); } });
  await writeFile(path, Buffer.alloc(pkg.length));
  await assert.rejects(verifyNativeInstaller(path, installer), /installer_invalid/);
  await downloadNativeInstaller({ installer, path, fetchInstaller: async () => { calls++; return new Response(pkg); } });
  assert.equal(calls, 2); assert.deepEqual(await readFile(path), pkg);
});

test('corrupt, truncated, oversized, redirected and cancelled installer downloads never become installable', async t => {
  const root = await temp(t);
  for (const [name, response] of [
    ['corrupt', () => new Response(Buffer.alloc(pkg.length))],
    ['truncated', () => new Response(pkg.subarray(0, 8))],
    ['oversized', () => new Response(Buffer.concat([pkg, Buffer.from('extra')]))],
    ['redirected', () => new Response(null, { status: 302 })],
  ]) {
    await assert.rejects(downloadNativeInstaller({ installer, path: join(root, name + '.pkg'), fetchInstaller: async () => response() }));
  }
  const controller = new AbortController();
  await assert.rejects(downloadNativeInstaller({ installer, path: join(root, 'cancelled.pkg'), signal: controller.signal,
    fetchInstaller: async () => new Response(pkg), onProgress: () => controller.abort() }), { name: 'AbortError' });
  assert.deepEqual(await readdir(root), []);
});

async function supervisorFixture(t, { failOpen = false, minimumBootstrap = 3, installerFetch } = {}) {
  const root = await temp(t), resources = join(root, 'app'), dataRoot = join(root, 'runtime-data'), events = [], opened = [], children = [];
  await mkdir(resources);
  await writeFile(join(resources, 'backend.mjs'), 'backend');
  const modules = await inventoryDesktopModules(resources); await writeFile(join(resources, 'desktop-modules.json'), JSON.stringify(modules));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const runtimeConfig = { python: { schema: 'agentloop.packagedRuntimePython/v1', pythonVersion: '3.12', pythonExecutable: 'runtime-python/bin/python3.12', version: '3.12.8', requiredModules: [] }, node: { version: '26.0.0' }, turnDefaults: {} };
  const config = { ...runtimeConfig, version: '1.0.0', update: { platform: 'mac', arch: 'arm64', channel: 'production', sequence: 1, nativeHostSha256: 'a'.repeat(64), publicKey, feedUrl: 'https://updates.example/desktop-updates/v2/production-arm64.json' } };
  const release = { schema: 'agentloop.desktop.module-release/v2', platform: 'mac', arch: 'arm64', channel: 'production', sequence: 2, version: '1.0.0', nativeHostSha256: 'b'.repeat(64), installer, minimumBootstrap, dataCompatibility: 'backward-compatible', generatedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), objectBaseUrl: 'https://updates.example/objects/', runtimeConfig, modules };
  const configPath = join(resources, 'desktop-config.json'); await writeFile(configPath, JSON.stringify(config));
  let readyEnabled = true;
  const fakeSpawn = () => {
    const p = new EventEmitter(); p.stdout = new PassThrough(); p.closeRequests = 0; children.push(p);
    p.stdin = new Writable({ write(_bytes, _encoding, done) {
      p.closeRequests++;
      p.stdout.write('AGENTLOOP_DESKTOP:{"type":"closed"}\n');
      setImmediate(() => { p.stdout.end(); p.emit('close', 0); }); done();
    } });
    setImmediate(async () => { if (!readyEnabled) return; const current = JSON.parse(await readFile(configPath)); p.stdout.write(`AGENTLOOP_DESKTOP:${JSON.stringify({ type: 'ready', origin: 'http://127.0.0.1:1234', version: current.version, updateSequence: current.update.sequence })}\n`); });
    return p;
  };
  const start = async () => startModuleSupervisor({ resources, dataRoot, emit: message => events.push(message), spawnProcess: fakeSpawn,
    fetchFeed: async () => { const payload = Buffer.from(JSON.stringify(release)); return new Response(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') })); },
    fetchInstaller: installerFetch ?? (async () => new Response(pkg)), fetchObject: () => { throw new Error('native update must not activate backend modules'); },
    openInstaller: async path => { if (failOpen) throw new Error('launch failed'); opened.push(path); },
  });
  return { root, resources, config, configPath, release, events, opened, children, start, setReady: value => { readyEnabled = value; } };
}

test('a changed native host installs the full PKG; success requires the newly installed baseline to report ready', async t => {
  const f = await supervisorFixture(t), supervisor = await f.start();
  await waitFor(() => f.events.some(e => e.type === 'ready'));
  await supervisor.check(); assert.equal(f.events.at(-1).mode, 'installer');
  await supervisor.download(); assert.equal(f.events.at(-1).type, 'update-staged');
  assert.equal(supervisor.state.active.sequence, 1);
  await supervisor.apply();
  assert.equal(f.opened.length, 1); assert.equal(f.children[0].closeRequests, 0, 'the system installer owns the final busy-run gate');
  assert.equal(supervisor.state.active.sequence, 1, 'opening Installer is not an installation commit');
  assert.equal(f.events.some(e => e.type === 'update-installed'), false);
  supervisor.close(); await waitFor(() => f.events.some(e => e.type === 'supervisor-closed'));
  // Simulate cancellation/relaunch: the old host remains usable, with an explicit retry.
  f.events.length = 0; const retry = await f.start();
  await waitFor(() => f.events.some(e => e.type === 'update-install-pending'));
  assert.equal(f.events.some(e => e.type === 'update-installed'), false);
  retry.close(); await waitFor(() => f.events.some(e => e.type === 'supervisor-closed'));
  // Simulate the complete PKG replacing both the tray and the supervisor.
  f.config.update.sequence = 2; f.config.update.nativeHostSha256 = f.release.nativeHostSha256;
  await writeFile(f.configPath, JSON.stringify(f.config)); f.events.length = 0; f.setReady(false);
  const installed = await f.start();
  assert.equal(f.events.some(e => e.type === 'update-installed'), false);
  const last = f.children.at(-1);
  last.stdout.write('AGENTLOOP_DESKTOP:{"type":"ready","origin":"http://127.0.0.1:1234","version":"1.0.0","updateSequence":2}\n');
  await waitFor(() => f.events.some(e => e.type === 'update-installed'));
  assert.deepEqual(f.events.map(e => e.type), ['ready', 'update-installed']);
  assert.equal(installed.state.active.kind, 'baseline'); assert.equal(installed.state.active.sequence, 2);
  installed.close(); await waitFor(() => f.events.some(e => e.type === 'supervisor-closed'));
});

test('failure to launch Installer preserves the running app and exposes a retry without a success receipt', async t => {
  const f = await supervisorFixture(t, { failOpen: true }), s = await f.start();
  await waitFor(() => f.events.some(e => e.type === 'ready')); await s.check(); await s.download(); await s.apply();
  assert.equal(f.events.at(-1).type, 'update-error'); assert.equal(f.events.at(-1).phase, 'install');
  assert.equal(f.children[0].closeRequests, 0); assert.equal(s.state.active.sequence, 1);
  await assert.rejects(readFile(join(f.root, 'desktop-updates/native-installation.json')), { code: 'ENOENT' });
  assert.equal(f.events.some(e => e.type === 'update-installed'), false);
  s.close(); await waitFor(() => f.events.some(e => e.type === 'supervisor-closed'));
});

test('native packages are rechecked before opening; staging cannot bypass replay protection', async t => {
  const f = await supervisorFixture(t), s = await f.start();
  await waitFor(() => f.events.some(e => e.type === 'ready')); await s.check(); await s.download();
  const path = join(f.root, 'desktop-updates/installers/2/desktop.pkg'); await writeFile(path, Buffer.alloc(pkg.length));
  await s.apply(); assert.equal(f.opened.length, 0); assert.equal(f.events.at(-1).type, 'update-error');
  await s.download(); f.release.sequence = 3; f.release.installer = { ...installer, url: installer.url.replace('desktop-2.pkg', 'desktop-3.pkg') };
  await s.check(); await s.apply();
  assert.equal(f.opened.length, 0); assert.equal(s.state.active.sequence, 1);
  s.close(); await waitFor(() => f.events.some(e => e.type === 'supervisor-closed'));
});

test('a newer bootstrap protocol routes through Installer even when the native fingerprint is unchanged', async t => {
  const f = await supervisorFixture(t, { minimumBootstrap: 4 }); f.release.nativeHostSha256 = f.config.update.nativeHostSha256;
  f.release.runtimeConfig = { schema: 'future-runtime' }; f.release.modules = { schema: 'future-modules' };
  const s = await f.start(); await waitFor(() => f.events.some(e => e.type === 'ready'));
  await s.check(); assert.equal(f.events.at(-1).mode, 'installer'); await s.download(); await s.apply();
  assert.equal(f.opened.length, 1); assert.equal(s.state.active.sequence, 1);
  s.close(); await waitFor(() => f.events.some(e => e.type === 'supervisor-closed'));
});

test('a native release cannot replace already staged content under the same sequence, even with a valid signature', async t => {
  const f = await supervisorFixture(t), s = await f.start();
  await waitFor(() => f.events.some(e => e.type === 'ready')); await s.check(); await s.download();
  const path = join(f.root, 'desktop-updates/installers/2/release.json'), original = await readFile(path);
  f.release.version = '1.0.1'; await s.check(); await s.download();
  assert.equal(f.events.at(-1).type, 'update-error'); assert.deepEqual(await readFile(path), original);
  assert.equal(s.state.active.sequence, 1); assert.equal(f.opened.length, 0);
  s.close(); await waitFor(() => f.events.some(e => e.type === 'supervisor-closed'));
});

test('cancelling a live download preserves the running version and reports cancellation distinctly from failure', async t => {
  let fetching = false;
  const f = await supervisorFixture(t, { installerFetch: async (_url, options) => {
    fetching = true;
    await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const s = await f.start(); await waitFor(() => f.events.some(e => e.type === 'ready')); await s.check();
  const pending = s.download(); await waitFor(() => fetching); s.cancelDownload(); await pending;
  assert.equal(f.events.at(-1).type, 'update-cancelled');
  assert.equal(f.events.some(e => ['update-staged', 'update-installed', 'update-error'].includes(e.type)), false);
  assert.equal(s.state.active.sequence, 1); assert.equal(f.children[0].closeRequests, 0);
  s.close(); await waitFor(() => f.events.some(e => e.type === 'supervisor-closed'));
});
