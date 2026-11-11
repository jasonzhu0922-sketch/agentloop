import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';

export const desktopBootstrapVersion = 3;

export function nativeUpdateRequired(config, release) {
  return release.minimumBootstrap > desktopBootstrapVersion || config.update.nativeHostSha256 !== release.nativeHostSha256;
}

export async function verifyNativeInstaller(path, installer) {
  if ((await stat(path)).size !== installer.size) throw new Error('desktop_installer_invalid');
  const hash = createHash('sha256'); let magic = Buffer.alloc(0);
  for await (const bytes of createReadStream(path)) {
    if (magic.length < 4) magic = Buffer.concat([magic, bytes]).subarray(0, 4);
    hash.update(bytes);
  }
  if (magic.toString() !== 'xar!' || hash.digest('hex') !== installer.sha256) throw new Error('desktop_installer_invalid');
}

/** A PKG is executable input: its URL, length and digest all come from the signed release. */
export async function downloadNativeInstaller({ installer, path, fetchInstaller = fetch, signal, onProgress = () => {}, onVerifying = () => {} }) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await verifyNativeInstaller(path, installer); onProgress(installer.size, installer.size); return path; }
  catch (error) {
    if (error.message === 'desktop_installer_invalid') await rm(path);
    else if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetchInstaller(installer.url, { redirect: 'error', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(30 * 60 * 1000)]) });
  if (!response.ok || !response.body) throw new Error('desktop_installer_download_failed');
  const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', 0o600);
  let downloaded = 0;
  try {
    for await (const bytes of response.body) {
      signal?.throwIfAborted(); downloaded += bytes.length;
      if (downloaded > installer.size) throw new Error('desktop_installer_invalid');
      await file.writeFile(bytes); onProgress(downloaded, installer.size);
    }
    signal?.throwIfAborted(); await file.sync(); await file.close();
    onVerifying(); await verifyNativeInstaller(temporary, installer);
    await rename(temporary, path); return path;
  } finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
}

/** macOS owns privilege prompts, installation progress and the package transaction. */
export function openNativeInstaller(path) {
  return new Promise((resolve, reject) => execFile('/usr/bin/open', ['-a', '/System/Library/CoreServices/Installer.app', path], error => error ? reject(new Error('desktop_installer_open_failed')) : resolve()));
}
