import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyModuleRelease } from '../distribution/module-release.mjs';

const args = process.argv.slice(2), values = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--root', '--feed', '--objects', '--public-key', '--base-url', '--bootstrap'].includes(args[i]) || !args[i + 1] || values[args[i]] !== undefined) throw new Error('Invalid module publication argument');
  values[args[i]] = args[i + 1];
}
for (const name of ['--root', '--feed', '--objects', '--public-key', '--base-url', '--bootstrap']) if (!values[name]) throw new Error(`Missing ${name}`);
const publicKey = await readFile(values['--public-key']);
function parseEnvelope(data, old = false) {
  if (data.length > 8 * 1024 * 1024) throw new Error('desktop_module_release_too_large');
  const envelope = JSON.parse(data.toString('utf8'));
  const payload = Buffer.from(envelope.payload, 'base64'), candidate = JSON.parse(payload.toString('utf8'));
  const target = { platform: candidate.platform, arch: candidate.arch, channel: candidate.channel, bootstrap: Number(values['--bootstrap']) };
  return verifyModuleRelease(payload, Buffer.from(envelope.signature, 'base64'), publicKey, target, old ? Date.parse(candidate.generatedAt) : Date.now());
}
async function checkObject(path, file) {
  if ((await stat(path)).size !== file.size) throw new Error('desktop_module_object_invalid');
  const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes);
  if (hash.digest('hex') !== file.sha256) throw new Error('desktop_module_object_invalid');
}
const bytes = await readFile(values['--feed']), release = parseEnvelope(bytes);
if (release.platform !== 'mac' || !['arm64', 'x64'].includes(release.arch) || !['local', 'production'].includes(release.channel)) throw new Error('desktop_module_target_invalid');
const expectedBase = new URL(values['--base-url']);
if (expectedBase.protocol !== 'https:' || expectedBase.username || expectedBase.password || expectedBase.search || expectedBase.hash || expectedBase.pathname !== '/' || release.objectBaseUrl !== new URL('/desktop-updates/objects/', expectedBase).href) throw new Error('desktop_module_url_invalid');
const root = values['--root'], objectRoot = join(root, 'objects');
await mkdir(root, { recursive: true, mode: 0o755 });
const lock = join(root, '.publish-lock'); await mkdir(lock);
try {
  const feedPath = join(root, `${release.channel}-${release.arch}.json`);
  let old;
  try { old = parseEnvelope(await readFile(feedPath), true); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (old && (old.platform !== release.platform || old.arch !== release.arch || old.channel !== release.channel)) throw new Error('desktop_module_target_invalid');
  const immutable = value => JSON.stringify({ platform: value.platform, arch: value.arch, channel: value.channel, sequence: value.sequence, version: value.version, minimumBootstrap: value.minimumBootstrap, dataCompatibility: value.dataCompatibility, objectBaseUrl: value.objectBaseUrl, runtimeConfig: value.runtimeConfig, modules: value.modules });
  if (old && (release.sequence < old.sequence || (release.sequence === old.sequence && immutable(release) !== immutable(old)))) throw new Error('desktop_module_release_sequence_invalid');
  await mkdir(objectRoot, { recursive: true, mode: 0o755 }); await chmod(objectRoot, 0o755);
  const seen = new Set();
  for (const module of release.modules.modules) for (const file of module.files) {
    if (file.type !== 'file' || seen.has(file.sha256)) continue;
    seen.add(file.sha256);
    const target = join(objectRoot, file.sha256);
    try { await checkObject(target, file); continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = join(objectRoot, `.staging-${randomUUID()}`);
    try {
      await copyFile(join(values['--objects'], file.sha256), temporary, constants.COPYFILE_EXCL);
      await checkObject(temporary, file); await chmod(temporary, 0o644); await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  const temporary = join(root, `.feed-${randomUUID()}`);
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 }); await chmod(temporary, 0o644); await rename(temporary, feedPath); }
  finally { await rm(temporary, { force: true }); }
} finally { await rm(lock, { recursive: true, force: true }); }
