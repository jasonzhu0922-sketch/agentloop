import { createPublicKey, verify } from 'node:crypto';
import { validateModuleManifest } from './module-staging.mjs';

/** Verify a whole release, including the exact compatible module set. */
export function verifyModuleRelease(payload, signature, publicKey, target, now = Date.now()) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, payload, key, signature)) throw new Error('desktop_module_signature_invalid');
  const release = JSON.parse(Buffer.from(payload).toString('utf8'));
  if (!release || release.schema !== 'agentloop.desktop.module-release/v1' || !Number.isSafeInteger(target.bootstrap) || target.bootstrap < 1 || release.platform !== target.platform || release.arch !== target.arch || release.channel !== target.channel || !Number.isSafeInteger(release.sequence) || release.sequence < 1 || !Number.isSafeInteger(release.minimumBootstrap) || release.minimumBootstrap < 1 || release.minimumBootstrap > target.bootstrap || !/^\d+\.\d+\.\d+$/.test(release.version) || release.dataCompatibility !== 'backward-compatible') throw new Error('desktop_module_release_incompatible');
  const runtime = release.runtimeConfig, python = runtime?.python;
  if (!runtime || !python || python.schema !== 'agentloop.packagedRuntimePython/v1' || python.pythonVersion !== '3.12' || typeof python.version !== 'string' || !python.version.startsWith('3.12.') || typeof python.pythonExecutable !== 'string' || !Array.isArray(python.requiredModules) || python.requiredModules.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_]+$/.test(name)) || !runtime.node || typeof runtime.node.version !== 'string' || !runtime.turnDefaults || typeof runtime.turnDefaults !== 'object' || Array.isArray(runtime.turnDefaults)) throw new Error('desktop_module_runtime_invalid');
  const generated = Date.parse(release.generatedAt), expires = Date.parse(release.expiresAt);
  if (!Number.isFinite(generated) || !Number.isFinite(expires) || generated > now || expires <= now || expires <= generated) throw new Error('desktop_module_release_expired');
  let base; try { base = new URL(release.objectBaseUrl); } catch { throw new Error('desktop_module_url_invalid'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) throw new Error('desktop_module_url_invalid');
  validateModuleManifest(release.modules);
  return release;
}
