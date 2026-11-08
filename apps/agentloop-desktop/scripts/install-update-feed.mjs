// Run on the update host after copying a signed envelope and installer to a
// private staging directory. The signing private key is never needed here.
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyDesktopFeed } from '../distribution/update-feed.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--root', '--feed', '--installer', '--public-key', '--base-url'].includes(args[i]) || !args[i + 1] || options[args[i]] !== undefined) throw new Error('Invalid install argument');
  options[args[i]] = args[i + 1];
}
for (const name of ['--root', '--feed', '--installer', '--public-key', '--base-url']) if (!options[name]) throw new Error(`Missing ${name}`);
const root = options['--root'], publicKey = await readFile(options['--public-key']);
const verifyEnvelope = (bytes, now) => {
  const envelope = JSON.parse(bytes.toString('utf8'));
  return verifyDesktopFeed(Buffer.from(envelope.payload, 'base64'), Buffer.from(envelope.signature, 'base64'), publicKey, now);
};
const fileHash = async path => { const h = createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex'); };
const feedBytes = await readFile(options['--feed']);
if (feedBytes.length > 1024 * 1024) throw new Error('Feed too large');
const feed = verifyEnvelope(feedBytes);
if (feed.releases.length !== 1) throw new Error('Expected one release per feed');
const release = feed.releases[0];
if (release.platform !== 'mac' || !release.chunks) throw new Error('Expected a macOS release with chunks');
const base = new URL(options['--base-url']);
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Invalid public base URL');
if (release.url !== new URL(`/downloads/desktop/${release.channel}-${release.arch}/${release.sequence}/desktop.pkg`, base).href) throw new Error('Installer URL does not match publication path');
if ((await stat(options['--installer'])).size !== release.size || await fileHash(options['--installer']) !== release.sha256) throw new Error('Installer does not match feed');
await mkdir(root, { recursive: true, mode: 0o755 });
const lock = join(root, '.publish-lock');
await mkdir(lock); // An existing lock requires operator investigation.
try {
  const feedPath = join(root, `${release.channel}-${release.arch}.json`);
  let previous;
  try {
    const oldBytes = await readFile(feedPath), envelope = JSON.parse(oldBytes.toString('utf8'));
    const oldPayload = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
    previous = verifyEnvelope(oldBytes, Date.parse(oldPayload.generatedAt)).releases[0];
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && (release.sequence < previous.sequence || (release.sequence === previous.sequence && (release.sha256 !== previous.sha256 || release.version !== previous.version)))) throw new Error('Release sequence cannot be reused or decreased');
  const channelDir = join(root, `${release.channel}-${release.arch}`);
  await mkdir(channelDir, { recursive: true, mode: 0o755 });
  await chmod(channelDir, 0o755);
  const directory = join(channelDir, String(release.sequence));
  try { await mkdir(directory, { mode: 0o755 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await chmod(directory, 0o755);
  const installerPath = join(directory, 'desktop.pkg');
  try { await copyFile(options['--installer'], installerPath, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if ((await stat(installerPath)).size !== release.size || await fileHash(installerPath) !== release.sha256) throw new Error('Immutable installer path already contains different bytes');
  await chmod(installerPath, 0o644);
  const temporary = join(root, `.feed-${randomUUID()}`);
  try { await writeFile(temporary, feedBytes, { flag: 'wx', mode: 0o644 }); await chmod(temporary, 0o644); await rename(temporary, feedPath); }
  finally { await rm(temporary, { force: true }); }
} finally { await rm(lock, { recursive: true, force: true }); }
