import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

// The signature covers the exact serialized bytes, not a re-serialized object.
// Keys must be provisioned independently of the feed.
export function signDesktopFeed(bytes, privateKey) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('desktop_update_key_invalid');
  return sign(null, bytes, key);
}

export function verifyDesktopFeed(bytes, signature, publicKey, now = Date.now()) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, signature)) throw new Error('desktop_update_signature_invalid');
  const feed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (!feed || feed.schema !== 'agentloop.desktop.update-feed/v1' || !Array.isArray(feed.releases)) throw new Error('desktop_update_feed_invalid');
  const generated = Date.parse(feed.generatedAt), expires = Date.parse(feed.expiresAt);
  if (!Number.isFinite(generated) || !Number.isFinite(expires) || generated > now || expires <= now || expires <= generated) throw new Error('desktop_update_feed_expired');
  const identities = new Set();
  for (const release of feed.releases) {
    if (!release || !['mac', 'win'].includes(release.platform) || !['arm64', 'x64'].includes(release.arch) || !['local', 'production'].includes(release.channel) || !Number.isSafeInteger(release.sequence) || release.sequence < 1 || typeof release.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(release.version) || !/^[a-f0-9]{64}$/.test(release.sha256) || !Number.isSafeInteger(release.size) || release.size < 1) throw new Error('desktop_update_release_invalid');
    let url; try { url = new URL(release.url); } catch { throw new Error('desktop_update_url_invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('desktop_update_url_invalid');
    if (release.chunks !== undefined) {
      if (!Array.isArray(release.chunks) || !release.chunks.length || release.chunks.length > 16384 || release.chunks.some(chunk => !chunk || !/^[a-f0-9]{64}$/.test(chunk.sha256) || !Number.isSafeInteger(chunk.size) || chunk.size < 1 || chunk.size > 4 * 1024 * 1024) || release.chunks.reduce((sum, chunk) => sum + chunk.size, 0) !== release.size) throw new Error('desktop_update_chunks_invalid');
    }
    const identity = `${release.platform}/${release.arch}/${release.channel}/${release.sequence}`;
    if (identities.has(identity)) throw new Error('desktop_update_release_duplicate');
    identities.add(identity);
  }
  return feed;
}

export function selectDesktopRelease(feed, target, highestAcceptedSequence) {
  if (!Number.isSafeInteger(highestAcceptedSequence) || highestAcceptedSequence < 0) throw new Error('desktop_update_sequence_invalid');
  return feed.releases.filter(release => release.platform === target.platform && release.arch === target.arch && release.channel === target.channel && release.sequence > highestAcceptedSequence)
    .sort((a, b) => b.sequence - a.sequence)[0];
}
