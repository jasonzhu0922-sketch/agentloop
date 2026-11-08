// Build a signed feed for a single immutable installer. Publish the installer
// and resulting envelope to HTTPS hosting only after reviewing both files.
import { createHash } from 'node:crypto';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { signDesktopFeed, verifyDesktopFeed } from '../distribution/update-feed.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--installer', '--url', '--version', '--sequence', '--channel', '--arch', '--private-key', '--public-key', '--output', '--expires-at'].includes(args[i]) || !args[i + 1] || options[args[i]] !== undefined) throw new Error('Invalid publish argument');
  options[args[i]] = args[i + 1];
}
for (const name of ['--installer', '--url', '--version', '--sequence', '--channel', '--arch', '--private-key', '--public-key', '--output', '--expires-at']) if (!options[name]) throw new Error(`Missing ${name}`);
const size = (await stat(options['--installer'])).size;
if (!options['--installer'].endsWith('.pkg') || size < 4) throw new Error('A macOS PKG installer is required');
const handle = await open(options['--installer'], 'r'), chunks = [], hash = createHash('sha256');
try {
  const magic = Buffer.alloc(4);
  if ((await handle.read(magic, 0, 4, 0)).bytesRead !== 4 || magic.toString() !== 'xar!') throw new Error('Invalid PKG installer');
  let offset = 0;
  while (offset < size) {
    const buffer = Buffer.alloc(Math.min(4 * 1024 * 1024, size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead !== buffer.length) throw new Error('Installer changed while reading');
    chunks.push({ sha256: createHash('sha256').update(buffer).digest('hex'), size: bytesRead }); hash.update(buffer); offset += bytesRead;
  }
} finally { await handle.close(); }
const feed = { schema: 'agentloop.desktop.update-feed/v1', generatedAt: new Date().toISOString(), expiresAt: options['--expires-at'], releases: [{ platform: 'mac', arch: options['--arch'], channel: options['--channel'], sequence: Number(options['--sequence']), version: options['--version'], size, sha256: hash.digest('hex'), url: options['--url'], chunks }] };
const payload = Buffer.from(JSON.stringify(feed));
const signature = signDesktopFeed(payload, await readFile(options['--private-key']));
verifyDesktopFeed(payload, signature, await readFile(options['--public-key']));
await writeFile(options['--output'], JSON.stringify({ payload: payload.toString('base64'), signature: signature.toString('base64') }) + '\n', { flag: 'wx', mode: 0o600 });
