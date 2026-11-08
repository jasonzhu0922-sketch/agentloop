import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyModuleRelease } from './module-release.mjs';

// Highest accepted sequence is owned and persisted by the trusted Bootstrap.
export async function checkModuleUpdate({ feedUrl, publicKey, target, installedSequence, highestAcceptedSequence, fetchFeed = fetch }) {
  const url = new URL(feedUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('desktop_module_url_invalid');
  if (![installedSequence, highestAcceptedSequence].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('desktop_module_sequence_invalid');
  const response = await fetchFeed(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error('desktop_module_download_failed');
  const parts = []; let size = 0;
  for await (const part of response.body) { size += part.length; if (size > 8 * 1024 * 1024) throw new Error('desktop_module_release_too_large'); parts.push(part); }
  const envelope = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('desktop_module_envelope_invalid');
  const release = verifyModuleRelease(Buffer.from(envelope.payload, 'base64'), Buffer.from(envelope.signature, 'base64'), publicKey, target);
  if (release.sequence < Math.max(installedSequence, highestAcceptedSequence)) throw new Error('desktop_module_replay');
  return { release: release.sequence > installedSequence ? release : undefined, highestAcceptedSequence: Math.max(highestAcceptedSequence, release.sequence), envelope };
}

export async function readInstalledModuleManifest(resources) {
  return JSON.parse(await readFile(join(resources, 'desktop-modules.json'), 'utf8'));
}
