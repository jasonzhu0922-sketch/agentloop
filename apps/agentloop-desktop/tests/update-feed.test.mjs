import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { signDesktopFeed, verifyDesktopFeed, selectDesktopRelease } from '../distribution/update-feed.mjs';
import { checkDesktopUpdate, downloadDesktopUpdate } from '../distribution/update-client.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const now = Date.parse('2026-11-07T00:00:00Z');
const release = { platform: 'mac', arch: 'arm64', channel: 'production', sequence: 2, version: '0.1.2', sha256: 'a'.repeat(64), size: 20, url: 'https://updates.example/desktop.pkg' };
function bytes(releases = [release], expiresAt = '2026-11-08T00:00:00Z') { return Buffer.from(JSON.stringify({ schema: 'agentloop.desktop.update-feed/v1', generatedAt: '2026-11-06T00:00:00Z', expiresAt, releases })); }
function verified(data) { return verifyDesktopFeed(data, signDesktopFeed(data, privateKey), publicKey, now); }

test('signed feed selects only newer releases for the exact installed target', () => {
  const feed = verified(bytes([release, { ...release, sequence: 3, channel: 'local' }, { ...release, sequence: 1 }]));
  assert.equal(selectDesktopRelease(feed, release, 1).sequence, 2);
  assert.equal(selectDesktopRelease(feed, release, 2), undefined);
});
test('client verifies signed feed, rejects replay, and reuses verified chunks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-update-')); t.after(() => rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const content = Buffer.from('abcdefghijkl'), hash = b => createHash('sha256').update(b).digest('hex');
  const chunks = [content.subarray(0, 6), content.subarray(6)].map(b => ({ sha256: hash(b), size: b.length }));
  const candidate = { ...release, size: content.length, sha256: hash(content), chunks };
  let feed = { schema: 'agentloop.desktop.update-feed/v1', generatedAt: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), releases: [candidate] };
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('feed.json')) { const data = Buffer.from(JSON.stringify(feed)); return new Response(JSON.stringify({ payload: data.toString('base64'), signature: signDesktopFeed(data, privateKey).toString('base64') })); }
    requests++; const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.range); const start = Number(match[1]), end = Number(match[2]);
    return new Response(content.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${content.length}` } });
  };
  const config = { feedUrl: 'https://updates.example/feed.json', publicKey, platform: 'mac', arch: 'arm64', channel: 'production', sequence: 1 };
  const found = await checkDesktopUpdate(config, root); assert.equal(found.sequence, 2);
  const path = await downloadDesktopUpdate(found, root); assert.deepEqual(await readFile(path), content); assert.equal(requests, 2);
  await downloadDesktopUpdate(found, root); assert.equal(requests, 2);
  feed = { ...feed, releases: [{ ...candidate, sequence: 1 }] };
  await assert.rejects(checkDesktopUpdate(config, root), /replay/);
});
test('corrupt downloaded chunk never creates an installer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-update-corrupt-')); t.after(() => rm(root, { recursive: true, force: true }));
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const expected = Buffer.from('expected');
  const badRelease = { ...release, size: expected.length, sha256: createHash('sha256').update(expected).digest('hex'), chunks: [{ size: expected.length, sha256: createHash('sha256').update(expected).digest('hex') }] };
  globalThis.fetch = async () => new Response(Buffer.from('tampered'), { status: 206, headers: { 'content-range': `bytes 0-7/8` } });
  await assert.rejects(downloadDesktopUpdate(badRelease, root), /chunk_invalid/);
  await assert.rejects(readFile(join(root, 'updates', 'desktop-2.pkg')), { code: 'ENOENT' });
});
test('publication signs installer and refuses replacing an existing sequence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-publish-')); t.after(() => rm(root, { recursive: true, force: true }));
  const priv = join(root, 'private.pem'), pub = join(root, 'public.pem'), pkg = join(root, 'input.pkg'), feed = join(root, 'feed.json'), dest = join(root, 'public');
  await writeFile(priv, privateKey); await writeFile(pub, publicKey); await writeFile(pkg, 'xar!original package');
  const run = (script, args) => spawnSync(process.execPath, [new URL(`../scripts/${script}`, import.meta.url).pathname, ...args], { encoding: 'utf8' });
  const publish = (sequence, output) => run('publish-update.mjs', ['--installer', pkg, '--url', `https://updates.example/downloads/desktop/production-arm64/${sequence}/desktop.pkg`, '--version', '1.0.0', '--sequence', String(sequence), '--channel', 'production', '--arch', 'arm64', '--private-key', priv, '--public-key', pub, '--expires-at', new Date(Date.now() + 86400000).toISOString(), '--output', output]);
  const install = input => run('install-update-feed.mjs', ['--root', dest, '--feed', input, '--installer', pkg, '--public-key', pub, '--base-url', 'https://updates.example']);
  assert.equal(publish(2, feed).status, 0); assert.equal(install(feed).status, 0);
  assert.equal((await readFile(join(dest, 'production-arm64', '2', 'desktop.pkg'))).toString(), 'xar!original package');
  await writeFile(pkg, 'xar!replacement'); const other = join(root, 'other.json'); assert.equal(publish(2, other).status, 0);
  assert.notEqual(install(other).status, 0);
  assert.equal((await readFile(join(dest, 'production-arm64', '2', 'desktop.pkg'))).toString(), 'xar!original package');
});
test('rejects tampering, wrong key, expired feed, invalid URL and duplicate sequence', () => {
  const data = bytes(), signature = signDesktopFeed(data, privateKey);
  assert.throws(() => verifyDesktopFeed(Buffer.concat([data, Buffer.from(' ')]), signature, publicKey, now), /signature/);
  const other = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  assert.throws(() => verifyDesktopFeed(data, signature, other.publicKey, now), /signature/);
  assert.throws(() => verified(bytes([release], '2026-11-06T23:00:00Z')), /expired/);
  assert.throws(() => verified(bytes([{ ...release, url: 'http://updates.example/a' }])), /url_invalid/);
  assert.throws(() => verified(bytes([release, release])), /duplicate/);
});
