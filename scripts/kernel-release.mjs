import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultChannel = join(repositoryRoot, '.releases/kernel');
const packagePath = 'node_modules/@zhujun/agentloop';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' }, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const digest = content => createHash('sha256').update(content).digest('hex');

async function withChannelLock(channelRoot, operation) {
  await fs.mkdir(channelRoot, { recursive: true });
  const lock = join(channelRoot, '.publish-lock');
  try { await fs.mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Kernel channel is locked: ${lock}. Wait for the publisher; inspect a stale lock before removing it.`);
    throw error;
  }
  try { return await operation(); } finally { await fs.rm(lock, { recursive: true, force: true }); }
}

export async function readChannel(channelRoot = defaultChannel) {
  const releaseRoot = await fs.realpath(join(channelRoot, 'current'));
  const manifest = JSON.parse(await fs.readFile(join(releaseRoot, 'agentloop-release.json'), 'utf8'));
  return { ...manifest, releaseRoot, packageRoot: join(releaseRoot, packagePath) };
}

async function switchCurrent(channelRoot, releaseRoot) {
  // Rename replaces the symlink atomically; a running process retains its
  // realpath-resolved immutable release while the next process resolves current.
  const temporary = join(channelRoot, `.current-${randomUUID()}`);
  try {
    await fs.symlink(relative(channelRoot, releaseRoot), temporary, 'dir');
    await fs.rename(temporary, join(channelRoot, 'current'));
  } finally { await fs.rm(temporary, { force: true }); }
}

async function prepareChannelPackage(channelRoot, sourcePackage) {
  // npm realpaths directory dependencies. A dependency pointing at the current
  // symlink would therefore be pinned to one release by npm install/ci.
  // Keep this package root stable and route its exports through current instead.
  const proxy = join(channelRoot, 'package');
  await fs.mkdir(proxy, { recursive: true });
  try { await fs.symlink(`../current/${packagePath}`, join(proxy, 'current'), 'dir'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const bin = typeof sourcePackage.bin === 'string' ? sourcePackage.bin : Object.values(sourcePackage.bin ?? {});
  const binPaths = typeof bin === 'string' ? [bin] : bin;
  for (const name of new Set([...(sourcePackage.files ?? []), ...binPaths].map(path => path.replace(/^\.\//, '').split('/')[0]))) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) || name === 'package.json') continue;
    try { await fs.symlink(`current/${name}`, join(proxy, name)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const route = value => typeof value === 'string' && value.startsWith('./') ? `./current/${value.slice(2)}`
    : Array.isArray(value) ? value.map(route)
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, route(child)])) : value;
  const temporary = join(proxy, `.package-${randomUUID()}.json`);
  const routedBin = typeof sourcePackage.bin === 'string' ? `./current/${sourcePackage.bin.replace(/^\.\//, '')}`
    : Object.fromEntries(Object.entries(sourcePackage.bin ?? {}).map(([name, path]) => [name, `./current/${path.replace(/^\.\//, '')}`]));
  await fs.writeFile(temporary, JSON.stringify({ name: sourcePackage.name, version: '0.0.0-local-channel', private: true,
    type: 'module', exports: route(sourcePackage.exports), bin: routedBin,
    ...(sourcePackage.engines === undefined ? {} : { engines: sourcePackage.engines }),
    description: 'Local AgentLoop release channel; exported package.json identifies the loaded release' }, null, 2) + '\n');
  await fs.rename(temporary, join(proxy, 'package.json'));
}

export async function publishKernel({ packageRoot = join(repositoryRoot, 'packages/agentloop'), channelRoot = defaultChannel, build = true, offline = true } = {}) {
  packageRoot = resolve(packageRoot); channelRoot = resolve(channelRoot);
  return withChannelLock(channelRoot, async () => {
    if (build) run('npm', ['run', 'build', '--prefix', packageRoot], repositoryRoot);
    const staging = join(channelRoot, `.staging-${randomUUID()}`);
    await fs.mkdir(staging);
    try {
      const packed = JSON.parse(run('npm', ['pack', packageRoot, '--json', '--ignore-scripts', '--pack-destination', staging], repositoryRoot))[0];
      const artifactPath = join(staging, packed.filename);
      const artifactSha256 = digest(await fs.readFile(artifactPath));
      const sourcePackage = JSON.parse(await fs.readFile(join(packageRoot, 'package.json'), 'utf8'));
      if (sourcePackage.name !== '@zhujun/agentloop') throw new Error('Release source must be @zhujun/agentloop');
      const sourceLock = packageRoot === join(repositoryRoot, 'packages/agentloop')
        ? JSON.parse(await fs.readFile(join(repositoryRoot, 'package-lock.json'), 'utf8')) : undefined;
      const dependencyLockSha256 = sourceLock === undefined ? undefined : digest(JSON.stringify(sourceLock));
      const releaseId = `${sourcePackage.version}-${digest(JSON.stringify([artifactSha256, dependencyLockSha256 ?? null])).slice(0, 16)}`;
      const releaseRoot = join(channelRoot, 'releases', releaseId);
      try {
        const existing = JSON.parse(await fs.readFile(join(releaseRoot, 'agentloop-release.json'), 'utf8'));
        if (existing.artifactSha256 !== artifactSha256) throw new Error(`Release collision: ${releaseId}`);
        await prepareChannelPackage(channelRoot, sourcePackage);
        await switchCurrent(channelRoot, releaseRoot);
        return readChannel(channelRoot);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const peers = Object.fromEntries(Object.entries(sourcePackage.peerDependencies ?? {}).map(([name, version]) =>
        [name, sourceLock?.packages?.[`node_modules/${name}`]?.version ?? version]));
      const installation = { name: 'agentloop-kernel-release', private: true, type: 'module',
        dependencies: { '@zhujun/agentloop': `file:${packed.filename}`, ...peers } };
      await fs.writeFile(join(staging, 'package.json'), JSON.stringify(installation, null, 2) + '\n');
      if (sourceLock !== undefined) {
        // Reuse the tested workspace's resolved versions. Resolving broad ranges
        // afresh can select uncached transitive versions during offline publish.
        const packages = Object.fromEntries(Object.entries(sourceLock.packages).filter(([path, item]) => path.startsWith('node_modules/') && !item.link));
        packages['node_modules/@zhujun/agentloop'] = { version: sourcePackage.version, resolved: `file:${packed.filename}`, integrity: packed.integrity,
          dependencies: sourcePackage.dependencies, peerDependencies: sourcePackage.peerDependencies,
          peerDependenciesMeta: sourcePackage.peerDependenciesMeta, engines: sourcePackage.engines, bin: sourcePackage.bin };
        await fs.writeFile(join(staging, 'package-lock.json'), JSON.stringify({ name: installation.name, lockfileVersion: 3, requires: true,
          packages: { '': installation, ...packages } }, null, 2) + '\n');
      }
      // Install an independent dependency tree; never resolve through the source
      // workspace or share a mutable consumer node_modules directory.
      // Local shared releases include the declared host peers as well: after
      // realpath resolution they cannot borrow drivers from a consumer project.
      run('npm', ['install', ...(offline ? ['--offline'] : []), '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], staging);
      const runtimePeers = JSON.parse(run(process.execPath, ['--input-type=module', '-e', `
        import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';
        const req=createRequire(process.cwd()+'/package.json');
        const packageRoot=process.cwd()+'/${packagePath}';
        const pkg=JSON.parse(readFileSync(packageRoot+'/package.json'));
        for(const name of Object.keys({...pkg.dependencies,...pkg.peerDependencies})) {
          if(!req.resolve(name).startsWith(process.cwd()+'/')) throw new Error('Dependency escaped release: '+name);
        }
        console.log(JSON.stringify(Object.fromEntries(Object.keys(pkg.peerDependencies??{}).map(name=>[name,req(name+'/package.json').version]))));
      `], staging));
      run(process.execPath, ['--input-type=module', '-e', "const kernel = await import('@zhujun/agentloop'); if (Object.keys(kernel).length === 0) throw new Error('Empty kernel exports');"], staging);
      const manifest = { schema: 'agentloop.kernelRelease/v1', releaseId, version: sourcePackage.version, artifactSha256,
        artifact: packed.filename, createdAt: new Date().toISOString(), packagePath, runtimePeers,
        ...(dependencyLockSha256 === undefined ? {} : { dependencyLockSha256 }),
        installationLockSha256: digest(await fs.readFile(join(staging, 'package-lock.json'))) };
      await fs.writeFile(join(staging, 'agentloop-release.json'), JSON.stringify(manifest, null, 2) + '\n');
      await fs.mkdir(dirname(releaseRoot), { recursive: true });
      await fs.rename(staging, releaseRoot);
      await prepareChannelPackage(channelRoot, sourcePackage);
      await switchCurrent(channelRoot, releaseRoot);
      return readChannel(channelRoot);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  });
}

export async function activateKernel(releaseId, channelRoot = defaultChannel) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(releaseId)) throw new Error('Invalid release ID');
  return withChannelLock(channelRoot, async () => {
    const releaseRoot = join(channelRoot, 'releases', releaseId);
    const manifest = JSON.parse(await fs.readFile(join(releaseRoot, 'agentloop-release.json'), 'utf8'));
    if (manifest.releaseId !== releaseId) throw new Error('Release identity mismatch');
    run(process.execPath, ['--input-type=module', '-e', "await import('@zhujun/agentloop')"], releaseRoot);
    await prepareChannelPackage(channelRoot, JSON.parse(await fs.readFile(join(releaseRoot, packagePath, 'package.json'), 'utf8')));
    await switchCurrent(channelRoot, releaseRoot);
    return readChannel(channelRoot);
  });
}

export async function bindKernelConsumer(consumerRoot, channelRoot = defaultChannel) {
  consumerRoot = resolve(consumerRoot); channelRoot = resolve(channelRoot);
  const release = await readChannel(channelRoot);
  const dependencyPath = relative(consumerRoot, join(channelRoot, 'package')).split('\\').join('/');
  const specifier = `file:${dependencyPath.startsWith('.') ? '' : './'}${dependencyPath}`;
  // npm owns package.json, lockfile and the link. Keeping install-links=false in
  // this project makes npm ci recreate the channel link rather than copy a snapshot.
  const npmrc = join(consumerRoot, '.npmrc');
  let config = '';
  try { config = await fs.readFile(npmrc, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const next = config.replace(/^install-links\s*=.*(?:\r?\n|$)/gm, '');
  await fs.writeFile(npmrc, `${next.trimEnd()}${next.trim().length ? '\n' : ''}install-links=false\n`);
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--install-links=false', '--save', specifier], consumerRoot);
  const actual = JSON.parse(run(process.execPath, ['--input-type=module', '-e', "import {fileURLToPath} from 'node:url'; console.log(JSON.stringify(fileURLToPath(import.meta.resolve('@zhujun/agentloop/package.json'))))"], consumerRoot));
  if (actual !== join(release.packageRoot, 'package.json')) throw new Error(`Consumer resolves ${actual}, expected ${release.packageRoot}`);
  return { consumerRoot, specifier, releaseId: release.releaseId, packageRoot: dirname(actual) };
}

async function main() {
  const [command = 'status', ...args] = process.argv.slice(2);
  if (command === 'publish') console.log(JSON.stringify(await publishKernel({ offline: !args.includes('--online') }), null, 2));
  else if (command === 'status') console.log(JSON.stringify(await readChannel(), null, 2));
  else if (command === 'activate' && args[0]) console.log(JSON.stringify(await activateKernel(args[0]), null, 2));
  else if (command === 'bind' && args.length) {
    for (const consumer of args) console.log(JSON.stringify(await bindKernelConsumer(consumer), null, 2));
  } else throw new Error('Usage: kernel-release.mjs publish [--online] | status | activate <releaseId> | bind <project...>');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
