import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModuleUpdate } from './module-update-client.mjs';
import { verifyModuleRelease } from './module-release.mjs';
import { stageDesktopModules, verifyDesktopModuleTree } from './module-staging.mjs';
import { openModuleState } from './module-state.mjs';

const prefix = 'AGENTLOOP_DESKTOP:';
/** Runs from the signed installation, never from a downloaded payload. */
export async function startModuleSupervisor({ resources, dataRoot, emit = message => process.stdout.write(`${prefix}${JSON.stringify(message)}\n`), fetchFeed, fetchObject, spawnProcess = spawn }) {
  const baseConfig = JSON.parse(await readFile(join(resources, 'desktop-config.json'), 'utf8'));
  const update = baseConfig.update;
  const enabled = update && update.platform === 'mac';
  // The Runtime claims an empty dataRoot on first start. Update bookkeeping is
  // a sibling, so it never changes the ownership check or the account data.
  const updateRoot = join(dirname(dataRoot), 'desktop-updates'), releases = join(updateRoot, 'releases');
  const target = enabled ? { platform: update.platform, arch: update.arch, channel: update.channel, bootstrap: 1 } : undefined;
  const state = enabled ? await openModuleState(updateRoot, update.sequence) : undefined;
  if (enabled) await mkdir(releases, { recursive: true, mode: 0o700 });
  const baselineManifest = enabled ? JSON.parse(await readFile(join(resources, 'desktop-modules.json'), 'utf8')) : undefined;
  let activeRoot = resources, activeManifest = baselineManifest, child, ready = false, ending = false, pendingClose = null, busy = false, available, staged, timer;

  function releaseConfig(release) {
    return { ...baseConfig, ...release.runtimeConfig, version: release.version, update: { ...baseConfig.update, sequence: release.sequence } };
  }
  async function writeMetadata(root, name, value) {
    // Keep temporary metadata outside the verified tree so a crash cannot
    // leave an unlisted file that prevents recovery on the next startup.
    const temp = join(dirname(root), `.metadata-${randomUUID()}`);
    try { await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temp, join(root, name)); }
    finally { await rm(temp, { force: true }); }
  }

  async function loadRelease(sequence) {
    const folder = join(releases, String(sequence));
    const envelope = JSON.parse(await readFile(join(folder, 'release.json'), 'utf8'));
    const payload = Buffer.from(envelope.payload, 'base64'), object = JSON.parse(payload.toString('utf8'));
    const release = verifyModuleRelease(payload, Buffer.from(envelope.signature, 'base64'), update.publicKey, target, Date.parse(object.generatedAt));
    if (release.sequence !== sequence) throw new Error('desktop_update_state_invalid');
    const root = join(folder, 'payload');
    await verifyDesktopModuleTree(root, release.modules);
    // Config is excluded from public objects because it may contain local
    // credentials. Reconstruct it from the installed trust root plus signed
    // runtime metadata; never trust an existing writable copy.
    await writeMetadata(root, 'desktop-config.json', releaseConfig(release));
    await writeMetadata(root, 'desktop-modules.json', release.modules);
    return { root, release };
  }
  if (state?.value.active.kind === 'module') {
    const active = await loadRelease(state.value.active.sequence); activeRoot = active.root; activeManifest = active.release.modules;
  }
  function notify(type, extra = {}) { emit({ type, ...extra }); }
  async function check(automatic = false) {
    if (busy) return;
    if (!enabled) { if (!automatic) notify('update-unavailable'); return; }
    busy = true;
    try {
      const result = await checkModuleUpdate({ feedUrl: update.feedUrl, publicKey: update.publicKey, target, installedSequence: state.value.active.sequence, highestAcceptedSequence: state.value.highest, ...(fetchFeed ? { fetchFeed } : {}) });
      await state.observe(result.highestAcceptedSequence);
      available = result.release ? { release: result.release, envelope: result.envelope } : undefined;
      if (available) notify('update-available', { version: available.release.version }); else if (!automatic) notify('update-current');
    } catch (error) { available = undefined; console.error('Desktop update check failed:', error.message); if (!automatic) notify('update-error'); }
    finally { busy = false; }
  }
  async function download() {
    if (!enabled || busy || !available) return;
    busy = true; let work;
    try {
      notify('update-downloading');
      const { release, envelope } = available, final = join(releases, String(release.sequence));
      try {
        const existing = await loadRelease(release.sequence);
        const stable = item => JSON.stringify({ sequence: item.sequence, version: item.version, platform: item.platform, arch: item.arch, channel: item.channel, minimumBootstrap: item.minimumBootstrap, dataCompatibility: item.dataCompatibility, objectBaseUrl: item.objectBaseUrl, runtimeConfig: item.runtimeConfig, modules: item.modules });
        if (stable(existing.release) !== stable(release)) throw new Error('desktop_update_sequence_conflict');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        work = await mkdtemp(join(releases, '.stage-'));
        const result = await stageDesktopModules({ currentRoot: activeRoot, currentManifest: activeManifest, nextManifest: release.modules, stagingRoot: join(work, 'payload'), objectBaseUrl: release.objectBaseUrl, ...(fetchObject ? { fetchObject } : {}) });
        const nextConfig = releaseConfig(release);
        await writeFile(join(work, 'payload', 'desktop-config.json'), JSON.stringify(nextConfig), { mode: 0o600, flag: 'wx' });
        await writeFile(join(work, 'payload', 'desktop-modules.json'), JSON.stringify(release.modules), { mode: 0o600, flag: 'wx' });
        await writeFile(join(work, 'release.json'), JSON.stringify(envelope), { mode: 0o600, flag: 'wx' });
        await verifyDesktopModuleTree(join(work, 'payload'), release.modules);
        await rename(work, final); work = undefined;
        console.error(`Desktop update staged: downloaded ${result.downloadedBytes} bytes`);
      }
      staged = release.sequence; notify('update-staged', { version: release.version });
    } catch (error) { console.error('Desktop update download failed:', error.message); notify('update-error'); }
    finally { if (work) await rm(work, { recursive: true, force: true }); busy = false; }
  }
  async function launch(root, candidate = undefined) {
    ready = false;
    const executable = join(root, 'runtime', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
    const args = process.platform === 'darwin' ? ['--use-system-ca', join(root, 'backend.mjs')] : [join(root, 'backend.mjs')];
    const next = spawnProcess(executable, args, { cwd: root, env: { ...process.env, AGENTLOOP_DESKTOP_DATA_DIR: dataRoot, AGENTLOOP_DESKTOP_SUPERVISED: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
    child = next;
    const messages = createInterface({ input: next.stdout });
    let handling = Promise.resolve();
    messages.on('line', line => {
      if (!line.startsWith(prefix)) return;
      handling = handling.then(async () => {
        let message; try { message = JSON.parse(line.slice(prefix.length)); } catch { return; }
        if (message.type === 'ready') {
          if (candidate) { await state.commit(candidate.sequence); activeRoot = root; activeManifest = candidate.modules; staged = undefined; }
          ready = true; clearTimeout(timer); emit(message);
          if (candidate) notify('update-installed', { version: candidate.version });
        } else if (message.type === 'close-refused' && pendingClose === 'update') { pendingClose = null; notify('update-busy'); }
        else if (message.type === 'close-refused' && pendingClose === 'quit') { ending = false; pendingClose = null; emit(message); }
        else emit(message);
      }).catch(error => { console.error('Desktop update supervisor failed:', error.message); next.kill('SIGTERM'); });
    });
    if (candidate) timer = setTimeout(() => { if (!ready) next.kill('SIGTERM'); }, 60000);
    next.once('error', error => console.error('Desktop backend launch failed:', error.message));
    next.once('close', () => { void handling.then(async () => {
      clearTimeout(timer); messages.close(); if (child !== next) return; child = undefined;
      if (ending) { notify('supervisor-closed'); return; }
      if (pendingClose === 'update') {
        pendingClose = null;
        try { const nextRelease = await loadRelease(staged); await state.begin(staged); await launch(nextRelease.root, nextRelease.release); }
        catch (error) { console.error('Desktop activation failed:', error.message); if (state.value.pending) await state.abort(state.value.pending.sequence); notify('update-error'); await launch(activeRoot); }
      } else if (candidate && !ready) {
        await state.abort(candidate.sequence); notify('update-rolled-back'); await launch(activeRoot);
      } else notify('backend-stopped');
    }).catch(error => { console.error('Desktop supervisor recovery failed:', error.message); notify('startup-error'); }); });
  }
  await launch(activeRoot);
  return {
    check, download,
    apply() { if (!staged || busy || pendingClose || !child || !ready) return; pendingClose = 'update'; child.stdin.write('close\n'); },
    close() { if (ending) return; if (!child) { notify('supervisor-closed'); return; } ending = true; pendingClose = 'quit'; child.stdin.write('close\n'); },
    get state() { return state?.value; },
    get child() { return child; },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  let supervisor;
  try {
    const resources = dirname(fileURLToPath(import.meta.url));
    if (!process.env.AGENTLOOP_DESKTOP_DATA_DIR) throw new Error('desktop_data_directory_required');
    supervisor = await startModuleSupervisor({ resources, dataRoot: process.env.AGENTLOOP_DESKTOP_DATA_DIR, emit: message => { process.stdout.write(`${prefix}${JSON.stringify(message)}\n`); if (message.type === 'supervisor-closed') process.exit(0); if (message.type === 'backend-stopped') process.exit(1); } });
    const commands = createInterface({ input: process.stdin });
    commands.on('line', line => { if (line === 'close') supervisor.close(); else if (line === 'check-update') void supervisor.check(); else if (line === 'download-update') void supervisor.download(); else if (line === 'apply-update') supervisor.apply(); });
    commands.on('close', () => supervisor.close());
    process.on('SIGTERM', () => supervisor.close()); process.on('SIGINT', () => supervisor.close());
    setTimeout(() => void supervisor.check(true), 30000).unref(); setInterval(() => void supervisor.check(true), 21600000).unref();
  } catch (error) { console.error('Desktop supervisor startup failed:', error.message); process.stdout.write(`${prefix}${JSON.stringify({ type: 'startup-error' })}\n`); process.exit(1); }
}
