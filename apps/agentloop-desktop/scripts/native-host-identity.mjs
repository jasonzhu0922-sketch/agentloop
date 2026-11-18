import { createHash } from 'node:crypto';
import { cp, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

// These execute from the installation, even when backend modules are replaced.
export const bootstrapFiles = ['module-supervisor.mjs', 'module-release.mjs', 'module-update-client.mjs', 'module-staging.mjs', 'module-state.mjs', 'native-update.mjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const resourcesFor = (application, config) => join(application, ...(config.platform === 'mac' ? ['Contents', 'Resources'] : ['Resources']));

async function unsignedExecutable(path) {
  // Bundle signatures include backend resource hashes. Work on a private copy
  // so neither the reference installation nor the new package is modified.
  const temporary = await mkdtemp(join(tmpdir(), 'agentloop-native-identity-'));
  try {
    const signature = spawnSync('/usr/bin/codesign', ['--display', '--entitlements', ':-', '--verbose=4', path]);
    if (signature.error) throw signature.error;
    if (signature.status !== 0 && !signature.stderr.toString().includes('code object is not signed at all')) throw new Error('desktop_native_signature_invalid');
    const flags = Number.parseInt(signature.stderr.toString().match(/flags=0x([a-f0-9]+)/i)?.[1] ?? '0', 16);
    const copy = join(temporary, 'executable');
    await cp(path, copy);
    execFileSync('/usr/bin/codesign', ['--remove-signature', copy], { stdio: 'pipe' });
    // Entitlements and hardened-runtime flags change host behavior. Ad-hoc and
    // linker-signing flags only describe how otherwise identical code was signed.
    return JSON.stringify({ code: digest(await readFile(copy)), entitlements: digest(signature.stdout), flags: flags & ~(0x2 | 0x20000) });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Fingerprint installed host content, never build scripts or modular resources. */
export async function nativeHostManifest(application, config) {
  const files = [], resources = resourcesFor(application, config);
  async function file(root, relative, transform) {
    const path = join(root, relative), info = await lstat(path);
    if (!info.isFile()) throw new Error(`desktop_native_file_invalid: ${relative}`);
    const bytes = transform ? await transform(path) : await readFile(path);
    files.push({ path: relative, executable: Boolean(info.mode & 0o111), sha256: digest(bytes) });
  }
  async function nativeTree(relative = '') {
    for (const name of (await readdir(join(application, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (path === 'Resources' || path === 'Contents/Resources' || path === 'Contents/_CodeSignature') continue;
      const info = await lstat(join(application, path));
      if (info.isDirectory()) await nativeTree(path);
      else if (path === 'Contents/Info.plist') await file(application, path, async value => {
        const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', value], { encoding: 'utf8' }));
        delete plist.CFBundleVersion; delete plist.CFBundleShortVersionString;
        return JSON.stringify(Object.fromEntries(Object.entries(plist).sort(([a], [b]) => a.localeCompare(b))));
      });
      else await file(application, path, config.platform === 'mac' && path.startsWith('Contents/MacOS/') ? unsignedExecutable : undefined);
    }
  }
  await nativeTree();
  for (const name of ['package.json', ...bootstrapFiles, config.platform === 'mac' ? 'runtime/bin/node' : 'runtime/bin/node.exe']) await file(resources, name);
  if (config.platform === 'mac') {
    for (const name of ['icon.png', 'icon.icns', 'status-icon.png']) await file(resources, name);
    for (const name of (await readdir(resources)).sort()) if (name.endsWith('.lproj')) await file(resources, `${name}/InfoPlist.strings`);
  }
  const { platform, arch, channel, appId, productName, displayName, dataDirectoryName, accountServiceUrl, update } = config;
  return { schema: 'agentloop.desktop.native-host-content/v1', platform, arch, channel, appId, productName, displayName, dataDirectoryName, accountServiceUrl,
    feedUrl: update?.feedUrl, publicKey: update?.publicKey, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Keep an installed compatibility identity only after proving content equality.
 * This also handles old installations whose identity hashed packaging scripts.
 * The reference is an explicit verified application artifact, never a hash override.
 */
export async function nativeHostIdentity(application, config, baselineApplication) {
  const contentSha256 = digest(JSON.stringify(await nativeHostManifest(application, config)));
  let baseline;
  if (baselineApplication) {
    const baselineConfig = JSON.parse(await readFile(join(resourcesFor(baselineApplication, config), 'desktop-config.json'), 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(baselineConfig.update?.nativeHostSha256)) throw new Error('desktop_native_baseline_invalid');
    baseline = { sequence: baselineConfig.update.sequence, nativeHostSha256: baselineConfig.update.nativeHostSha256,
      contentSha256: digest(JSON.stringify(await nativeHostManifest(baselineApplication, baselineConfig))) };
  }
  const reusedBaseline = baseline?.contentSha256 === contentSha256;
  return { schema: 'agentloop.desktop.native-host-verification/v1', contentSha256, baseline,
    reusedBaseline, nativeHostSha256: reusedBaseline ? baseline.nativeHostSha256 : contentSha256 };
}
