import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readlink, symlink, chmod } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

const moduleName = path => path === 'runtime' || path.startsWith('runtime/') ? 'node' : path === 'runtime-python' || path.startsWith('runtime-python/') ? 'python' : 'desktop';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Validate the signed manifest before using any of its paths. */
export function validateModuleManifest(manifest) {
  if (!manifest || manifest.schema !== 'agentloop.desktop.modules/v1' || !Array.isArray(manifest.modules) || manifest.modules.length !== 3) throw new Error('desktop_module_manifest_invalid');
  const names = new Set(), paths = new Map(), objects = new Map();
  for (const module of manifest.modules) {
    if (!module || !['desktop', 'node', 'python'].includes(module.name) || names.has(module.name) || !Array.isArray(module.files) || sha(JSON.stringify(module.files)) !== module.sha256) throw new Error('desktop_module_manifest_invalid');
    names.add(module.name);
    for (const file of module.files) {
      const path = file?.path;
      if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || posix.isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..') || moduleName(path) !== module.name || paths.has(path) || ['desktop-config.json', 'desktop-modules.json'].includes(path)) throw new Error('desktop_module_path_invalid');
      if (!['file', 'directory', 'symlink'].includes(file.type)) throw new Error('desktop_module_manifest_invalid');
      if (file.type === 'file') {
        if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.executable !== 'boolean' || (objects.has(file.sha256) && objects.get(file.sha256) !== file.size)) throw new Error('desktop_module_manifest_invalid');
        objects.set(file.sha256, file.size);
      }
      if (file.type === 'symlink') {
        if (typeof file.target !== 'string' || file.target.includes('\\') || file.target.includes('\0') || posix.isAbsolute(file.target)) throw new Error('desktop_module_symlink_invalid');
        const resolved = posix.normalize(posix.join(posix.dirname(path), file.target));
        if (resolved === '..' || resolved.startsWith('../') || moduleName(resolved) !== module.name) throw new Error('desktop_module_symlink_invalid');
      }
      paths.set(path, file);
    }
  }
  for (const path of paths.keys()) {
    let parent = posix.dirname(path);
    while (parent !== '.') {
      if (paths.get(parent)?.type !== 'directory') throw new Error('desktop_module_parent_invalid');
      parent = posix.dirname(parent);
    }
  }
  return paths;
}

async function verifyFile(path, file) {
  const hash = createHash('sha256'); let size = 0;
  for await (const part of createReadStream(path)) { size += part.length; if (size > file.size) throw new Error('desktop_module_object_invalid'); hash.update(part); }
  if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error('desktop_module_object_invalid');
}

/** Re-check every executable input before a stored release is started. */
export async function verifyDesktopModuleTree(root, manifest) {
  const expected = validateModuleManifest(manifest), seen = new Set();
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('desktop_module_object_invalid');
  async function visit(path) {
    if (path === 'desktop-config.json' || path === 'desktop-modules.json') return;
    const entry = expected.get(path);
    if (!entry) throw new Error('desktop_module_unexpected_file');
    const full = join(root, ...path.split('/')), info = await lstat(full);
    seen.add(path);
    if (entry.type === 'directory') {
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('desktop_module_object_invalid');
      for (const name of await readdir(full)) await visit(`${path}/${name}`);
    } else if (entry.type === 'file') {
      if (!info.isFile() || info.isSymbolicLink() || Boolean(info.mode & 0o111) !== entry.executable) throw new Error('desktop_module_object_invalid');
      await verifyFile(full, entry);
    } else if (!info.isSymbolicLink() || await readlink(full) !== entry.target) throw new Error('desktop_module_object_invalid');
  }
  for (const name of await readdir(root)) await visit(name);
  if (seen.size !== expected.size) throw new Error('desktop_module_object_missing');
}

/** Assemble in a new directory. Activation is a separate, trusted operation. */
export async function stageDesktopModules({ currentRoot, currentManifest, nextManifest, stagingRoot, objectBaseUrl, fetchObject = fetch, signal, onProgress = () => {} }) {
  const current = validateModuleManifest(currentManifest), next = validateModuleManifest(nextManifest);
  const url = new URL(objectBaseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) throw new Error('desktop_module_url_invalid');
  const available = new Map();
  for (const [path, file] of current) if (file.type === 'file' && !available.has(file.sha256)) available.set(file.sha256, { root: currentRoot, path });
  const required = new Map();
  for (const file of next.values()) if (file.type === 'file' && !available.has(file.sha256)) required.set(file.sha256, file.size);
  const totalBytes = [...required.values()].reduce((sum, size) => sum + size, 0);
  await mkdir(stagingRoot); let downloadedBytes = 0, completedFiles = 0;
  const totalFiles = [...next.values()].filter(file => file.type === 'file').length;
  onProgress({ downloadedBytes, totalBytes, completedFiles, totalFiles });
  for (const [path, file] of [...next].filter(([, f]) => f.type === 'directory').sort(([a], [b]) => a.split('/').length - b.split('/').length)) await mkdir(join(stagingRoot, ...path.split('/')));
  for (const [path, file] of next) {
    signal?.throwIfAborted();
    if (file.type !== 'file') continue;
    const target = join(stagingRoot, ...path.split('/')), local = available.get(file.sha256);
    if (local) await copyFile(join(local.root, ...local.path.split('/')), target);
    else {
      const response = await fetchObject(new URL(file.sha256, url), { redirect: 'error', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(120000)]) });
      if (!response.ok || !response.body) throw new Error('desktop_module_download_failed');
      let size = 0;
      const limit = new Transform({ transform(chunk, _encoding, done) {
        size += chunk.length;
        onProgress({ downloadedBytes: downloadedBytes + size, totalBytes, completedFiles, totalFiles });
        done(size > file.size ? new Error('desktop_module_object_invalid') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(target, { flags: 'wx', mode: 0o600 }), ...(signal ? [{ signal }] : []));
      downloadedBytes += size;
    }
    await verifyFile(target, file);
    await chmod(target, file.executable ? 0o755 : 0o644);
    available.set(file.sha256, { root: stagingRoot, path });
    completedFiles++;
    onProgress({ downloadedBytes, totalBytes, completedFiles, totalFiles });
  }
  for (const [path, file] of next) if (file.type === 'symlink') await symlink(file.target, join(stagingRoot, ...path.split('/')));
  return { downloadedBytes };
}
