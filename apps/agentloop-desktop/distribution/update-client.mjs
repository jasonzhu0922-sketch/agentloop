import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyDesktopFeed } from './update-feed.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function bounded(response, max) {
  if (!response.ok || !response.body) throw new Error('desktop_update_http_error');
  const parts = []; let size = 0;
  for await (const part of response.body) { size += part.length; if (size > max) throw new Error('desktop_update_response_too_large'); parts.push(part); }
  return Buffer.concat(parts);
}
function secureUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('desktop_update_url_invalid');
  return url;
}
async function get(url, options = {}) {
  secureUrl(url);
  return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(120000) });
}

export async function checkDesktopUpdate(config, dataRoot) {
  const response = await get(config.feedUrl);
  const envelope = JSON.parse((await bounded(response, 1024 * 1024)).toString('utf8'));
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('desktop_update_envelope_invalid');
  const feed = verifyDesktopFeed(Buffer.from(envelope.payload, 'base64'), Buffer.from(envelope.signature, 'base64'), config.publicKey);
  const candidates = feed.releases.filter(r => r.platform === config.platform && r.arch === config.arch && r.channel === config.channel).sort((a, b) => b.sequence - a.sequence);
  const latest = candidates[0];
  if (!latest) return undefined;
  const statePath = join(dataRoot, 'update-highest-sequence');
  let previous = 0;
  try { const value = await readFile(statePath, 'utf8'); if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('desktop_update_state_invalid'); previous = Number(value); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (latest.sequence < Math.max(config.sequence, previous)) throw new Error('desktop_update_replay');
  if (latest.sequence > previous) {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const temp = `${statePath}.${randomUUID()}`;
    try { await writeFile(temp, String(latest.sequence), { mode: 0o600, flag: 'wx' }); await rename(temp, statePath); } finally { await rm(temp, { force: true }); }
  }
  return latest.sequence > config.sequence ? latest : undefined;
}

// Assemble a signed chunk list from cached, hash-checked chunks or bounded Range
// requests. The complete installer is hashed again before it becomes visible.
export async function downloadDesktopUpdate(release, dataRoot) {
  if (release.platform !== 'mac' || !Array.isArray(release.chunks)) throw new Error('desktop_update_installation_unsupported');
  const dir = join(dataRoot, 'updates'), cache = join(dir, 'chunks');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const path = join(dir, `desktop-${release.sequence}.pkg`), temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600); let offset = 0;
  const total = createHash('sha256');
  try {
    for (const chunk of release.chunks) {
      const cached = join(cache, chunk.sha256); let bytes;
      try { bytes = await readFile(cached); if (bytes.length !== chunk.size || digest(bytes) !== chunk.sha256) bytes = undefined; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!bytes) {
        const response = await get(release.url, { headers: { range: `bytes=${offset}-${offset + chunk.size - 1}` } });
        if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${offset}-${offset + chunk.size - 1}/${release.size}`) throw new Error('desktop_update_range_invalid');
        bytes = await bounded(response, chunk.size);
        if (bytes.length !== chunk.size || digest(bytes) !== chunk.sha256) throw new Error('desktop_update_chunk_invalid');
        const temp = `${cached}.${randomUUID()}`;
        try { await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' }); await rename(temp, cached); } finally { await rm(temp, { force: true }); }
      }
      await file.writeFile(bytes); total.update(bytes); offset += bytes.length;
    }
    await file.sync(); await file.close();
    if (offset !== release.size || total.digest('hex') !== release.sha256) throw new Error('desktop_update_installer_invalid');
    await rename(temporary, path); return path;
  } catch (error) { await file.close().catch(() => {}); await rm(temporary, { force: true }); throw error; }
}
