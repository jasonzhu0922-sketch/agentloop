import { createPublicKey, verify } from 'node:crypto';
import { validateModuleManifest } from './module-staging.mjs';

/** Verify a whole release, including the exact compatible module set. */
export function verifyModuleRelease(payload, signature, publicKey, target, now = Date.now()) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, payload, key, signature)) throw new Error('desktop_module_signature_invalid');
  const release = JSON.parse(Buffer.from(payload).toString('utf8'));
  if (!release || release.schema !== 'agentloop.desktop.module-release/v2' || !Number.isSafeInteger(target.bootstrap) || target.bootstrap < 1 || release.platform !== target.platform || release.arch !== target.arch || release.channel !== target.channel || !Number.isSafeInteger(release.sequence) || release.sequence < 1 || !Number.isSafeInteger(release.minimumBootstrap) || release.minimumBootstrap < 3 || !/^\d+\.\d+\.\d+$/.test(release.version) || release.dataCompatibility !== 'backward-compatible') throw new Error('desktop_module_release_incompatible');
  const runtime = release.runtimeConfig, python = runtime?.python;
  if (release.minimumBootstrap <= target.bootstrap && (!runtime || !python || python.schema !== 'agentloop.packagedRuntimePython/v1' || python.pythonVersion !== '3.12' || typeof python.version !== 'string' || !python.version.startsWith('3.12.') || typeof python.pythonExecutable !== 'string' || !Array.isArray(python.requiredModules) || python.requiredModules.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_]+$/.test(name)) || !runtime.node || typeof runtime.node.version !== 'string' || !runtime.turnDefaults || typeof runtime.turnDefaults !== 'object' || Array.isArray(runtime.turnDefaults))) throw new Error('desktop_module_runtime_invalid');
  const generated = Date.parse(release.generatedAt), expires = Date.parse(release.expiresAt);
  if (!Number.isFinite(generated) || !Number.isFinite(expires) || generated > now || expires <= now || expires <= generated) throw new Error('desktop_module_release_expired');
  let base; try { base = new URL(release.objectBaseUrl); } catch { throw new Error('desktop_module_url_invalid'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) throw new Error('desktop_module_url_invalid');
  const installer = release.installer;
  if (!/^[a-f0-9]{64}$/.test(release.nativeHostSha256) || !installer || !/^[a-f0-9]{64}$/.test(installer.sha256) || !Number.isSafeInteger(installer.size) || installer.size < 4 || installer.size > 2 * 1024 ** 3) throw new Error('desktop_installer_descriptor_invalid');
  if (installer.url !== new URL(`/downloads/desktop/${release.channel}-${release.arch}/desktop-${release.sequence}.pkg`, base.origin).href) throw new Error('desktop_installer_url_invalid');
  // A future bootstrap's payload need not be interpretable by this host: only
  // its signed full installer can be used, never its incompatible modules.
  if (release.minimumBootstrap <= target.bootstrap) validateModuleManifest(release.modules);
  return release;
}
