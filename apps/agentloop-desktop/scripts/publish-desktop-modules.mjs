import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inventoryDesktopModules } from './desktop-modules.mjs';

async function digest(path) { const hash = createHash('sha256'); for await (const part of createReadStream(path)) hash.update(part); return hash.digest('hex'); }

/** Publish verified, content-addressed objects; never copy the excluded config. */
export async function publishDesktopModuleObjects(root, destination) {
  const inventory = await inventoryDesktopModules(root);
  const packaged = JSON.parse(await readFile(join(root, 'desktop-modules.json'), 'utf8'));
  if (JSON.stringify(inventory) !== JSON.stringify(packaged)) throw new Error('desktop_module_baseline_mismatch');
  await mkdir(destination, { recursive: true, mode: 0o755 });
  const seen = new Set(); let bytes = 0, count = 0;
  for (const module of inventory.modules) for (const file of module.files) {
    if (file.type !== 'file' || seen.has(file.sha256)) continue;
    seen.add(file.sha256);
    const target = join(destination, file.sha256);
    try {
      if ((await stat(target)).size !== file.size || await digest(target) !== file.sha256) throw new Error('desktop_module_object_corrupt');
      continue;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = join(destination, `.staging-${randomUUID()}`);
    try {
      await copyFile(join(root, ...file.path.split('/')), temporary);
      if ((await stat(temporary)).size !== file.size || await digest(temporary) !== file.sha256) throw new Error('desktop_module_source_changed');
      await chmod(temporary, 0o644);
      await rename(temporary, target); bytes += file.size; count++;
    } finally { await rm(temporary, { force: true }); }
  }
  return { count, bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node publish-desktop-modules.mjs <packaged-resources> <objects-directory>');
  console.log(JSON.stringify(await publishDesktopModuleObjects(process.argv[2], process.argv[3])));
}
