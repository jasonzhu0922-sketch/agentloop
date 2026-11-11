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
import { desktopBootstrapVersion, nativeUpdateRequired, downloadNativeInstaller, verifyNativeInstaller, openNativeInstaller } from './native-update.mjs';

const prefix = 'AGENTLOOP_DESKTOP:';
const releaseIdentity = item => JSON.stringify({ sequence: item.sequence, version: item.version, platform: item.platform, arch: item.arch, channel: item.channel, nativeHostSha256: item.nativeHostSha256, installer: item.installer, minimumBootstrap: item.minimumBootstrap, dataCompatibility: item.dataCompatibility, objectBaseUrl: item.objectBaseUrl, runtimeConfig: item.runtimeConfig, modules: item.modules });
/** Runs from the signed installation, never from a downloaded payload. */
export async function startModuleSupervisor({ resources, dataRoot, emit = message => process.stdout.write(`${prefix}${JSON.stringify(message)}\n`), fetchFeed, fetchObject, fetchInstaller, openInstaller = openNativeInstaller, spawnProcess = spawn }) {
  const baseConfig = JSON.parse(await readFile(join(resources, 'desktop-config.json'), 'utf8'));
  const update = baseConfig.update;
  const enabled = update && update.platform === 'mac';
  // The Runtime claims an empty dataRoot on first start. Update bookkeeping is
  // a sibling, so it never changes the ownership check or the account data.
  const updateRoot = join(dirname(dataRoot), 'desktop-updates'), releases = join(updateRoot, 'releases');
  if (enabled && !/^[a-f0-9]{64}$/.test(update.nativeHostSha256)) throw new Error('desktop_native_host_identity_missing');
  const target = enabled ? { platform: update.platform, arch: update.arch, channel: update.channel, bootstrap: desktopBootstrapVersion } : undefined;
  const state = enabled ? await openModuleState(updateRoot, update.sequence) : undefined;
  if (enabled) await mkdir(releases, { recursive: true, mode: 0o700 });
  const baselineManifest = enabled ? JSON.parse(await readFile(join(resources, 'desktop-modules.json'), 'utf8')) : undefined;
  let activeRoot = resources, activeManifest = baselineManifest, child, ready = false, ending = false, pendingClose = null, closeAcknowledged = false, busy = false, available, staged, timer;
  let downloadAbort, firstReady = true;
  const installationReceipt = join(updateRoot, 'native-installation.json');

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

  async function readStoredRelease(folder, sequence) {
    const envelope = JSON.parse(await readFile(join(folder, 'release.json'), 'utf8'));
    const payload = Buffer.from(envelope.payload, 'base64'), object = JSON.parse(payload.toString('utf8'));
    const release = verifyModuleRelease(payload, Buffer.from(envelope.signature, 'base64'), update.publicKey, target, Date.parse(object.generatedAt));
    if (release.sequence !== sequence) throw new Error('desktop_update_state_invalid');
    return { release, envelope };
  }
  async function loadRelease(sequence) {
    const folder = join(releases, String(sequence));
    const { release } = await readStoredRelease(folder, sequence);
    if (nativeUpdateRequired(baseConfig, release)) throw new Error('desktop_native_installation_required');
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
  const releaseDetails = release => ({ version: release.version, sequence: release.sequence, mode: nativeUpdateRequired(baseConfig, release) ? 'installer' : 'module' });
  async function loadNativeRelease(sequence) {
    const folder = join(updateRoot, 'installers', String(sequence));
    const { release } = await readStoredRelease(folder, sequence);
    const path = join(folder, 'desktop.pkg'); await verifyNativeInstaller(path, release.installer);
    return { path, release };
  }
  async function recoverInstallation(message) {
    if (!enabled) return;
    let receipt;
    try { receipt = JSON.parse(await readFile(installationReceipt, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1 || !/^[a-f0-9]{64}$/.test(receipt.nativeHostSha256)) throw new Error('desktop_update_state_invalid');
    if (update.sequence === receipt.sequence && update.nativeHostSha256 !== receipt.nativeHostSha256) throw new Error('desktop_native_installation_identity_mismatch');
    if (update.sequence >= receipt.sequence) {
      await rm(installationReceipt);
      notify('update-installed', { version: message.version, sequence: message.updateSequence, mode: 'installer' });
    } else {
      const installed = await loadNativeRelease(receipt.sequence);
      staged = { sequence: receipt.sequence, mode: 'installer' };
      notify('update-install-pending', releaseDetails(installed.release));
    }
  }
  async function check(automatic = false) {
    if (busy) return;
    if (!enabled) { if (!automatic) notify('update-unavailable'); return; }
    busy = true;
    if (!automatic) notify('update-checking');
    try {
      const result = await checkModuleUpdate({ feedUrl: update.feedUrl, publicKey: update.publicKey, target, installedSequence: state.value.active.sequence, highestAcceptedSequence: state.value.highest, ...(fetchFeed ? { fetchFeed } : {}) });
      await state.observe(result.highestAcceptedSequence);
      available = result.release ? { release: result.release, envelope: result.envelope } : undefined;
      if (available) notify('update-available', releaseDetails(available.release)); else if (!automatic) notify('update-current');
    } catch (error) { available = undefined; console.error('Desktop update check failed:', error.message); if (!automatic) notify('update-error', { phase: 'check' }); }
    finally { busy = false; }
  }
  async function download() {
    if (!enabled || busy || !available) return;
    busy = true; let work; downloadAbort = new AbortController();
    const signal = downloadAbort.signal;
    let lastProgress = 0;
    const onProgress = progress => {
      const now = Date.now();
      const complete = Number.isInteger(progress.totalFiles) ? progress.completedFiles === progress.totalFiles : progress.downloadedBytes === progress.totalBytes;
      if (now - lastProgress < 200 && !complete) return;
      lastProgress = now; notify('update-progress', progress);
    };
    try {
      notify('update-downloading', releaseDetails(available.release));
      if (nativeUpdateRequired(baseConfig, available.release)) {
        const { release, envelope } = available, folder = join(updateRoot, 'installers', String(release.sequence));
        try {
          const existing = await readStoredRelease(folder, release.sequence);
          if (releaseIdentity(existing.release) !== releaseIdentity(release)) throw new Error('desktop_update_sequence_conflict');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await downloadNativeInstaller({ installer: release.installer, path: join(folder, 'desktop.pkg'), signal, ...(fetchInstaller ? { fetchInstaller } : {}), onProgress: (downloadedBytes, totalBytes) => onProgress({ downloadedBytes, totalBytes }), onVerifying: () => notify('update-verifying') });
        signal.throwIfAborted();
        await writeMetadata(folder, 'release.json', envelope);
        staged = { sequence: release.sequence, mode: 'installer' };
        notify('update-staged', releaseDetails(release)); return;
      }
      const { release, envelope } = available, final = join(releases, String(release.sequence));
      try {
        const existing = await loadRelease(release.sequence);
        if (releaseIdentity(existing.release) !== releaseIdentity(release)) throw new Error('desktop_update_sequence_conflict');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        work = await mkdtemp(join(releases, '.stage-'));
        const result = await stageDesktopModules({ currentRoot: activeRoot, currentManifest: activeManifest, nextManifest: release.modules, stagingRoot: join(work, 'payload'), objectBaseUrl: release.objectBaseUrl, signal, onProgress, ...(fetchObject ? { fetchObject } : {}) });
        const nextConfig = releaseConfig(release);
        await writeFile(join(work, 'payload', 'desktop-config.json'), JSON.stringify(nextConfig), { mode: 0o600, flag: 'wx' });
        await writeFile(join(work, 'payload', 'desktop-modules.json'), JSON.stringify(release.modules), { mode: 0o600, flag: 'wx' });
        await writeFile(join(work, 'release.json'), JSON.stringify(envelope), { mode: 0o600, flag: 'wx' });
        notify('update-verifying'); signal.throwIfAborted(); await verifyDesktopModuleTree(join(work, 'payload'), release.modules); signal.throwIfAborted();
        await rename(work, final); work = undefined;
        console.error(`Desktop update staged: downloaded ${result.downloadedBytes} bytes`);
      }
      staged = { sequence: release.sequence, mode: 'module' }; notify('update-staged', releaseDetails(release));
    } catch (error) {
      if (signal.aborted) notify('update-cancelled');
      else { console.error('Desktop update download failed:', error.message); notify('update-error', { phase: 'download' }); }
    }
    finally { if (work) await rm(work, { recursive: true, force: true }); downloadAbort = undefined; busy = false; }
  }
  async function launch(root, candidate = undefined) {
    ready = false;
    const executable = join(root, 'runtime', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
    const args = process.platform === 'darwin' ? ['--use-system-ca', join(root, 'backend.mjs')] : [join(root, 'backend.mjs')];
    const next = spawnProcess(executable, args, { cwd: root, env: { ...process.env, AGENTLOOP_DESKTOP_DATA_DIR: dataRoot, AGENTLOOP_DESKTOP_SUPERVISED: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
    child = next;
    next.stdin.on('error', error => { console.error('Desktop backend command failed:', error.message); });
    const messages = createInterface({ input: next.stdout });
    let handling = Promise.resolve();
    messages.on('line', line => {
      if (!line.startsWith(prefix)) return;
      handling = handling.then(async () => {
        let message; try { message = JSON.parse(line.slice(prefix.length)); } catch { return; }
        if (message.type === 'ready') {
          if (candidate) { await state.commit(candidate.sequence); activeRoot = root; activeManifest = candidate.modules; staged = undefined; }
          ready = true; clearTimeout(timer); emit(message);
          if (firstReady) { firstReady = false; try { await recoverInstallation(message); } catch (error) { console.error('Desktop installation recovery failed:', error.message); notify('update-error', { phase: 'install' }); } }
          if (candidate) notify('update-installed', { version: candidate.version, sequence: candidate.sequence, mode: 'module' });
        } else if (message.type === 'closed' && pendingClose) { closeAcknowledged = true; emit(message); }
        else if (message.type === 'close-refused' && pendingClose === 'update') { pendingClose = null; closeAcknowledged = false; notify('update-busy'); }
        else if (message.type === 'close-refused' && pendingClose === 'quit') { ending = false; pendingClose = null; emit(message); }
        else emit(message);
      }).catch(error => { console.error('Desktop update supervisor failed:', error.message); next.kill('SIGTERM'); });
    });
    if (candidate) timer = setTimeout(() => { if (!ready) next.kill('SIGTERM'); }, 60000);
    next.once('error', error => console.error('Desktop backend launch failed:', error.message));
    next.once('close', code => { void handling.then(async () => {
      clearTimeout(timer); messages.close(); if (child !== next) return; child = undefined;
      if (ending) { notify('supervisor-closed'); return; }
      if (pendingClose === 'update') {
        pendingClose = null;
        if (!closeAcknowledged || code !== 0) { closeAcknowledged = false; notify('update-error'); await launch(activeRoot); return; }
        closeAcknowledged = false;
        try { const nextRelease = await loadRelease(staged.sequence); await state.begin(staged.sequence); await launch(nextRelease.root, nextRelease.release); }
        catch (error) { console.error('Desktop activation failed:', error.message); if (state.value.pending) await state.abort(state.value.pending.sequence); notify('update-error'); await launch(activeRoot); }
      } else if (candidate && !ready) {
        await state.abort(candidate.sequence); notify('update-rolled-back'); await launch(activeRoot);
      } else notify('backend-stopped');
    }).catch(error => { console.error('Desktop supervisor recovery failed:', error.message); notify('startup-error'); }); });
  }
  await launch(activeRoot);
  return {
    check, download,
    cancelDownload() { downloadAbort?.abort(); },
    async apply() {
      if (!staged || busy || pendingClose || !child || !ready || ending) return;
      if (staged.sequence !== state.value.highest || staged.sequence <= state.value.active.sequence) { notify('update-error', { phase: 'check' }); return; }
      if (staged.mode === 'installer') {
        busy = true;
        try {
          const { path, release } = await loadNativeRelease(staged.sequence);
          await writeMetadata(updateRoot, 'native-installation.json', { sequence: release.sequence, nativeHostSha256: release.nativeHostSha256 });
          notify('update-installing', releaseDetails(release));
          try { await openInstaller(path); } catch (error) { await rm(installationReceipt, { force: true }); throw error; }
        } catch (error) { console.error('Desktop installer launch failed:', error.message); notify('update-error', { phase: 'install' }); }
        finally { busy = false; }
        return;
      }
      notify('update-restarting'); closeAcknowledged = false; pendingClose = 'update'; child.stdin.write('close\n');
    },
    close() { if (ending) return; downloadAbort?.abort(); if (!child) { notify('supervisor-closed'); return; } closeAcknowledged = false; ending = true; pendingClose = 'quit'; child.stdin.write('close\n'); },
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
    commands.on('line', line => { if (line === 'close') supervisor.close(); else if (line === 'check-update') void supervisor.check(); else if (line === 'download-update') void supervisor.download(); else if (line === 'cancel-update-download') supervisor.cancelDownload(); else if (line === 'apply-update') void supervisor.apply(); });
    commands.on('close', () => supervisor.close());
    process.on('SIGTERM', () => supervisor.close()); process.on('SIGINT', () => supervisor.close());
    setTimeout(() => void supervisor.check(true), 30000).unref(); setInterval(() => void supervisor.check(true), 21600000).unref();
  } catch (error) { console.error('Desktop supervisor startup failed:', error.message); process.stdout.write(`${prefix}${JSON.stringify({ type: 'startup-error' })}\n`); process.exit(1); }
}
