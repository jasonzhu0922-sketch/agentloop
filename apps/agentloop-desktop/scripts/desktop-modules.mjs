import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const excluded = new Set(['desktop-config.json', 'desktop-modules.json']);
const moduleFor = path => path === 'runtime' || path.startsWith('runtime/') ? 'node' : path === 'runtime-python' || path.startsWith('runtime-python/') ? 'python' : 'desktop';

async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest('hex');
}

/** Deterministic content inventory; never includes device config or timestamps. */
export async function inventoryDesktopModules(root) {
  const groups = { desktop: [], node: [], python: [] };
  async function visit(relative) {
    if (excluded.has(relative)) return;
    const file = join(root, ...relative.split('/'));
    const info = await lstat(file);
    const entries = groups[moduleFor(relative)];
    if (info.isSymbolicLink()) {
      const target = await readlink(file);
      const resolved = posix.normalize(posix.join(posix.dirname(relative), target));
      if (posix.isAbsolute(target) || resolved === '..' || resolved.startsWith('../') || moduleFor(resolved) !== moduleFor(relative)) throw new Error(`desktop_module_symlink_invalid: ${relative}`);
      entries.push({ path: relative, type: 'symlink', target });
    } else if (info.isDirectory()) {
      entries.push({ path: relative, type: 'directory' });
      for (const name of (await readdir(file)).sort()) await visit(`${relative}/${name}`);
    } else if (info.isFile()) {
      entries.push({ path: relative, type: 'file', size: info.size, executable: Boolean(info.mode & 0o111), sha256: await fileDigest(file) });
    } else throw new Error(`desktop_module_file_type_invalid: ${relative}`);
  }
  for (const name of (await readdir(root)).sort()) await visit(name);
  return { schema: 'agentloop.desktop.modules/v1', modules: Object.entries(groups).map(([name, files]) => ({ name, sha256: sha256(JSON.stringify(files)), files })) };
}

/** Calculate transfer from content identities, not paths or compressed PKGs. */
export function planDesktopModuleTransfer(current, next) {
  if (current.schema !== 'agentloop.desktop.modules/v1' || next.schema !== 'agentloop.desktop.modules/v1') throw new Error('desktop_module_manifest_invalid');
  const installed = new Map(current.modules.flatMap(module => module.files.filter(file => file.type === 'file').map(file => [file.sha256, file.size])));
  const required = new Map();
  for (const module of next.modules) {
    for (const file of module.files) {
      if (file.type !== 'file') continue;
      if (installed.has(file.sha256) && installed.get(file.sha256) !== file.size) throw new Error('desktop_module_digest_size_mismatch');
      if (!installed.has(file.sha256)) {
        if (required.has(file.sha256) && required.get(file.sha256) !== file.size) throw new Error('desktop_module_digest_size_mismatch');
        required.set(file.sha256, file.size);
      }
    }
  }
  return { changedModules: next.modules.filter(module => !current.modules.some(previous => previous.name === module.name && previous.sha256 === module.sha256)).map(module => module.name),
    objects: [...required].map(([sha256, size]) => ({ sha256, size })), downloadBytes: [...required.values()].reduce((sum, size) => sum + size, 0) };
}
