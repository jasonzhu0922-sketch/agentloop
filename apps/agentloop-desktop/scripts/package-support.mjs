import { cp, mkdir, readFile, readdir, realpath, writeFile, access } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';

export async function packagedTurnDefaults(path) {
  let content;
  try { content = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const env = parseEnv(content), result = {};
  for (const [name, property, max] of [['PLANNING_MAX_TURNS', 'planningMaxTurns', 64], ['STEP_MAX_TURNS', 'stepMaxTurns', 256]]) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error(`desktop_${name.toLowerCase()}_invalid`);
    result[property] = Number(value);
  }
  return result;
}

export async function packagedSearchDefaults(path) {
  let content;
  try { content = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const env = parseEnv(content);
  if (env.WEB_SEARCH_DISABLED === '1' || env.WEB_SEARCH_DISABLED !== '0') return undefined;
  const provider = env.WEB_SEARCH_PROVIDER;
  if (provider !== undefined && !['bocha', 'baidu', 'bing'].includes(provider)) throw new Error('Desktop packaged search provider is invalid');
  let endpoint;
  if (env.WEB_SEARCH_ENDPOINT) {
    endpoint = new URL(env.WEB_SEARCH_ENDPOINT);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Desktop packaged search endpoint must be a credential-free HTTPS URL');
  }
  // Credentials are deliberately not required at package time. If a legacy
  // environment still supplies one, it is migrated into the account vault on
  // first launch; otherwise the user configures it from Desktop Settings.
  if (!env.WEB_SEARCH_API_KEY) return undefined;
  return { ...(provider === undefined ? {} : { searchProvider: provider }), ...(endpoint === undefined ? {} : { searchEndpoint: endpoint.href }), searchApiKey: env.WEB_SEARCH_API_KEY };
}

export function packageOptions(args, platform = process.platform, arch = process.arch) {
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--platform', '--channel', '--account-service', '--arch', '--target'].includes(key) || values[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid packaging argument: ${key}`);
    values[key] = args[++index];
  }
  const targetPlatform = values['--platform'] ?? (platform === 'darwin' ? 'mac' : 'win');
  if (!['mac', 'win'].includes(targetPlatform) || (targetPlatform === 'mac' ? 'darwin' : 'win32') !== platform) throw new Error('Build macOS packages on macOS and Windows packages on Windows.');
  const targetArch = values['--arch'] ?? arch;
  if (!['arm64', 'x64'].includes(targetArch) || targetArch !== arch) throw new Error('Build on a machine matching the target architecture.');
  const channel = values['--channel'] ?? 'production';
  if (!['local', 'production'].includes(channel)) throw new Error('Channel must be local or production.');
  const rawUrl = values['--account-service'] ?? (channel === 'local' ? 'http://127.0.0.1:8795' : undefined);
  if (!rawUrl) throw new Error('Production packages require --account-service https://your-account-service');
  const url = new URL(rawUrl);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search || /[?#]/.test(rawUrl) || (url.protocol !== 'https:' && !(channel === 'local' && loopback && url.protocol === 'http:')) || (channel === 'production' && loopback)) throw new Error('Account Service must use HTTPS; only local packages allow loopback HTTP.');
  const target = values['--target'] ?? (targetPlatform === 'mac' ? 'pkg' : 'zip');
  if (!(targetPlatform === 'mac' ? ['pkg', 'dmg', 'zip', 'dir'] : ['zip', 'dir']).includes(target)) throw new Error('Unsupported package target.');
  return { platform: targetPlatform, arch: targetArch, channel, accountServiceUrl: url.href.replace(/\/+$/, ''), target,
    productName: channel === 'local' ? 'AgentLoop Desktop Local' : 'AgentLoop Desktop',
    dataDirectoryName: channel === 'local' ? 'AgentLoop Desktop Local' : 'AgentLoop Desktop',
    appId: channel === 'local' ? 'com.agentloop.desktop.local' : 'com.agentloop.desktop' };
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function dependencyDirectory(name, from) {
  let current = from;
  while (true) {
    const candidate = join(current, 'node_modules', name);
    if (await exists(join(candidate, 'package.json'))) return realpath(candidate);
    const parent = dirname(current); if (parent === current) throw new Error(`Missing installed dependency: ${name}`);
    current = parent;
  }
}

/** Preserve the installed dependency topology (including nested versions),
 * while copying only published workspace assets. No workspace configs/data. */
export async function copyRuntimeDependencies(repositoryRoot, destination, roots) {
  repositoryRoot = await realpath(repositoryRoot);
  const workspaceRoots = new Map();
  for (const directory of await readdir(join(repositoryRoot, 'packages'))) {
    const source = join(repositoryRoot, 'packages', directory);
    if (await exists(join(source, 'package.json'))) workspaceRoots.set(await realpath(source), JSON.parse(await readFile(join(source, 'package.json'), 'utf8')));
  }
  const sourceModules = join(repositoryRoot, 'node_modules');
  const copied = new Set();
  const inventory = [];
  function targetFor(source) {
    const workspace = workspaceRoots.get(source);
    if (workspace) return join(destination, 'node_modules', workspace.name);
    if (source.startsWith(`${sourceModules}${sep}`)) return join(destination, 'node_modules', relative(sourceModules, source));
    for (const [root, pkg] of workspaceRoots) {
      if (source.startsWith(`${join(root, 'node_modules')}${sep}`)) return join(destination, 'node_modules', pkg.name, relative(root, source));
    }
    throw new Error(`Dependency is outside the repository: ${source}`);
  }
  async function copy(source) {
    if (copied.has(source)) return;
    copied.add(source);
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const target = targetFor(source);
    await mkdir(target, { recursive: true });
    if (workspaceRoots.has(source)) {
      for (const file of ['package.json', 'dist', 'skills', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
        if (await exists(join(source, file))) await cp(join(source, file), join(target, file), { recursive: true, dereference: true,
          filter: path => !path.split(sep).some(part => ['__pycache__', '.DS_Store', '.env'].includes(part)) });
      }
      if (!await exists(join(target, 'dist'))) throw new Error(`Build workspace first: ${manifest.name}`);
    } else {
      await cp(source, target, { recursive: true, dereference: true, filter: path => path === source || !relative(source, path).split(sep).some(part => ['node_modules', '.git', '.DS_Store'].includes(part)) });
    }
    inventory.push({ name: manifest.name, version: manifest.version, path: relative(destination, target).split(sep).join('/') });
    for (const name of Object.keys(manifest.dependencies ?? {})) await copy(await dependencyDirectory(name, source));
    for (const name of Object.keys({ ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
      let dependency;
      try { dependency = await dependencyDirectory(name, source); } catch (error) {
        if (!manifest.optionalDependencies?.[name] && !manifest.peerDependenciesMeta?.[name]?.optional) throw error;
      }
      if (dependency) await copy(dependency);
    }
  }
  for (const name of roots) await copy(await dependencyDirectory(name, repositoryRoot));
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(join(destination, 'dependencies.json'), `${JSON.stringify(inventory, null, 2)}\n`);
  return inventory;
}
