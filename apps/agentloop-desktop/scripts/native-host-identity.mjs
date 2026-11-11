import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// These execute from the installation, even when backend modules are replaced.
export const bootstrapFiles = ['module-supervisor.mjs', 'module-release.mjs', 'module-update-client.mjs', 'module-staging.mjs', 'module-state.mjs', 'native-update.mjs'];
export const nativeHostInputFiles = [
  'distribution/macos/DesktopTray.swift', 'distribution/macos/icon.icns', 'distribution/macos/status-icon.png', 'web/xuanwu-mascot-icon.png',
  'scripts/package-macos-installer.mjs', 'scripts/package-desktop.mjs', 'scripts/native-host-identity.mjs',
  ...bootstrapFiles.map(name => `distribution/${name}`),
];

/** Hash native build inputs; product versions and resource-dependent signatures do not require native installation. */
export async function nativeHostIdentity(appRoot, config) {
  const inputs = [];
  for (const path of nativeHostInputFiles) inputs.push([path, createHash('sha256').update(await readFile(join(appRoot, path))).digest('hex')]);
  const { platform, arch, channel, appId, productName, dataDirectoryName, accountServiceUrl, node, nativeToolchain, update } = config;
  return createHash('sha256').update(JSON.stringify({ inputs, platform, arch, channel, appId, productName, dataDirectoryName, accountServiceUrl, node, nativeToolchain, feedUrl: update?.feedUrl, publicKey: update?.publicKey })).digest('hex');
}
