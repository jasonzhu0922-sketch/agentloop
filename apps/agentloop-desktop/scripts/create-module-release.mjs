import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inventoryDesktopModules } from './desktop-modules.mjs';
import { signDesktopFeed } from '../distribution/update-feed.mjs';
import { verifyModuleRelease } from '../distribution/module-release.mjs';

const args = process.argv.slice(2), values = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--resources', '--private-key', '--public-key', '--object-base-url', '--expires-at', '--minimum-bootstrap', '--data-compatibility', '--output'].includes(args[i]) || !args[i + 1] || values[args[i]] !== undefined) throw new Error('Invalid module release argument');
  values[args[i]] = args[i + 1];
}
for (const name of ['--resources', '--private-key', '--public-key', '--object-base-url', '--expires-at', '--minimum-bootstrap', '--data-compatibility', '--output']) if (!values[name]) throw new Error(`Missing ${name}`);
const root = values['--resources'];
const config = JSON.parse(await readFile(join(root, 'desktop-config.json'), 'utf8'));
if (!config.update || !Number.isSafeInteger(config.update.sequence)) throw new Error('Packaged update configuration required');
const modules = await inventoryDesktopModules(root);
if (JSON.stringify(modules) !== JSON.stringify(JSON.parse(await readFile(join(root, 'desktop-modules.json'), 'utf8')))) throw new Error('desktop_module_baseline_mismatch');
const release = { schema: 'agentloop.desktop.module-release/v1', platform: config.platform, arch: config.arch, channel: config.channel, sequence: config.update.sequence, version: config.version,
  minimumBootstrap: Number(values['--minimum-bootstrap']), dataCompatibility: values['--data-compatibility'], generatedAt: new Date().toISOString(), expiresAt: values['--expires-at'], objectBaseUrl: values['--object-base-url'], runtimeConfig: { python: config.python, node: config.node, turnDefaults: config.turnDefaults }, modules };
const payload = Buffer.from(JSON.stringify(release));
const signature = signDesktopFeed(payload, await readFile(values['--private-key']));
verifyModuleRelease(payload, signature, await readFile(values['--public-key']), { platform: config.platform, arch: config.arch, channel: config.channel, bootstrap: release.minimumBootstrap });
await writeFile(values['--output'], JSON.stringify({ payload: payload.toString('base64'), signature: signature.toString('base64') }) + '\n', { flag: 'wx', mode: 0o600 });
