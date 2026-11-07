import { cp, mkdir, mkdtemp, readFile, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { build as bundle } from 'esbuild';
import { packageOptions, copyRuntimeDependencies, packagedTurnDefaults, packagedSearchDefaults } from './package-support.mjs';
import { writeMacInstallerFiles } from './package-macos-installer.mjs';
import { requiredPythonRoot, packagePython } from './package-python.mjs';
import { packagedToolEnvironment, verifyPackagedPython } from '../distribution/packaged-tools.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(appRoot, '../..');
const options = packageOptions(process.argv.slice(2));
const manifest = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
const nodeVersion = '26.0.0';
// Required before building anything; never silently emit a Node-only package.
const pythonSourceRoot = await requiredPythonRoot();
const searchDefaults = await packagedSearchDefaults(join(appRoot, '.env'));
const pythonRequirements = join(repositoryRoot, 'apps/agentloop-multi-runtime/requirements.local-agent.txt');
const output = join(appRoot, 'release', `${options.channel}-${options.platform}-${options.arch}`);
const cache = join(appRoot, 'release', 'cache');
await mkdir(output, { recursive: true });
await mkdir(cache, { recursive: true });
const staging = await mkdtemp(join(output, '.staging-'));
function run(command, args, cwd = repositoryRoot) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
function npm(args) {
  // npm.cmd requires a shell on Windows. Invoke npm's JS entry directly instead.
  if (!process.env.npm_execpath) throw new Error('Run this script through npm run package:desktop:mac or package:desktop:win.');
  run(process.execPath, [process.env.npm_execpath, ...args]);
}
async function download(url, path) {
  if (existsSync(path)) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}
async function nodeRuntime(destination) {
  const platform = options.platform === 'mac' ? 'darwin' : 'win';
  const base = `node-v${nodeVersion}-${platform}-${options.arch}`;
  const archiveName = `${base}.${platform === 'win' ? 'zip' : 'tar.gz'}`;
  const archive = join(cache, archiveName);
  const sums = join(cache, `node-v${nodeVersion}-SHASUMS256.txt`);
  await download(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`, sums);
  await download(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, archive);
  const expected = (await readFile(sums, 'utf8')).split(/\r?\n/).find(line => line.trim().split(/\s+/)[1] === archiveName)?.split(/\s+/)[0];
  const actual = createHash('sha256').update(await readFile(archive)).digest('hex');
  if (!expected || expected !== actual) { await rm(archive, { force: true }); throw new Error('Node archive SHA-256 mismatch; retry to download again.'); }
  const unpack = join(staging, 'node-unpack'); await mkdir(unpack);
  if (platform === 'win') {
    const script = join(staging, 'expand-node.ps1');
    await writeFile(script, 'param([string]$Archive, [string]$Destination)\n$ErrorActionPreference = "Stop"\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination\n');
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, archive, unpack]);
  } else run('/usr/bin/tar', ['-xzf', archive, '-C', unpack]);
  await mkdir(join(destination, 'bin'), { recursive: true });
  const executable = join(destination, 'bin', platform === 'win' ? 'node.exe' : 'node');
  await cp(join(unpack, base, platform === 'win' ? 'node.exe' : 'bin/node'), executable);
  if (platform !== 'win') await chmod(executable, 0o755);
  await cp(join(unpack, base, 'LICENSE'), join(destination, 'LICENSE'));
  run(executable, ['-e', `if(process.versions.node!==${JSON.stringify(nodeVersion)}||process.arch!==${JSON.stringify(options.arch)})process.exit(1);require('node:sqlite');console.log('Packaged Node verified:',process.version,process.arch)`]);
  return { version: nodeVersion, archive: archiveName, sha256: actual };
}
try {
  for (const workspace of ['@zhujun/agentloop', '@zhujun/agentloop-identity', '@zhujun/agentloop-artifact-preview', '@zhujun/agentloop-skills', '@zhujun/agentloop-memory', '@zhujun/agentloop-connector-sdk', '@zhujun/connector-feishu', '@zhujun/connector-126-mail', '@zhujun/connector-wps', '@zhujun/agentloop-local-runtime', 'agentloop-desktop']) npm(['run', 'build', '--workspace', workspace]);
  const backend = join(staging, 'desktop');
  await mkdir(backend);
  await cp(join(appRoot, 'distribution/backend.mjs'), join(backend, 'backend.mjs'));
  await cp(join(appRoot, 'distribution/packaged-tools.mjs'), join(backend, 'packaged-tools.mjs'));
  await writeFile(join(backend, 'package.json'), '{"private":true,"type":"module"}\n');
  await cp(join(appRoot, 'dist'), join(backend, 'dist'), { recursive: true });
  await cp(join(appRoot, 'web'), join(backend, 'web'), { recursive: true });
  await bundle({ stdin: { contents: 'export { renderMarkdown, artifactPreviewMode, renderBlobPreview, renderStructuredPreview, updateArtifactPreviewMarkup } from "@zhujun/agentloop-artifact-preview";', resolveDir: appRoot, loader: 'js' }, bundle: true, format: 'esm', platform: 'browser', minify: true, outfile: join(backend, 'web/markdown.js') });
  await cp(join(repositoryRoot, 'packages/agentloop-artifact-preview/markdown.css'), join(backend, 'web/markdown.css'));
  await copyRuntimeDependencies(repositoryRoot, backend, ['@zhujun/agentloop', '@zhujun/agentloop-identity', '@zhujun/agentloop-local-runtime', '@zhujun/connector-feishu', '@zhujun/connector-126-mail', '@zhujun/connector-wps']);
  const node = await nodeRuntime(join(backend, 'runtime'));
  const python = await packagePython(pythonSourceRoot, join(backend, 'runtime-python'), pythonRequirements);
  await cp(pythonRequirements, join(backend, 'requirements.txt'));
  await cp(join(repositoryRoot, 'LICENSE'), join(backend, 'LICENSE'));
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' });
  const turnDefaults = await packagedTurnDefaults(join(appRoot, '.env'));
  const config = { schema: 'agentloop.desktop.package/v1', version: manifest.version, ...options, node, python, turnDefaults, searchDefaults, sourceCommit: git.status === 0 ? git.stdout.trim() : null, sourceDirty: status.status === 0 ? Boolean(status.stdout.trim()) : null, builtAt: new Date().toISOString() };
  await writeFile(join(backend, 'desktop-config.json'), `${JSON.stringify(config, null, 2)}\n`);
  await verifyPackagedPython(backend, config, await packagedToolEnvironment(backend, config));
  const artifactName = `AgentLoop-Desktop-${manifest.version}-${options.channel}-${options.platform}-${options.arch}`;
  if (options.platform === 'mac') {
    const application = join(staging, `${options.productName}.app`);
    const contents = join(application, 'Contents');
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await cp(backend, join(contents, 'Resources'), { recursive: true });
    await cp(join(appRoot, 'web/xuanwu-mascot-icon.png'), join(contents, 'Resources/icon.png'));
    await cp(join(appRoot, 'distribution/macos/icon.icns'), join(contents, 'Resources/icon.icns'));
    run('/usr/bin/swiftc', ['-parse-as-library', '-O', '-module-cache-path', join(cache, 'swift-modules'), '-target', `${options.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`, join(appRoot, 'distribution/macos/DesktopTray.swift'), '-framework', 'AppKit', '-o', join(contents, 'MacOS/AgentLoop Desktop')]);
    await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>AgentLoop Desktop</string>
<key>CFBundleIdentifier</key><string>${options.appId}</string>
<key>CFBundleName</key><string>${options.productName}</string>
<key>CFBundleDisplayName</key><string>${options.productName}</string>
<key>CFBundleVersion</key><string>${manifest.version}</string>
<key>CFBundleShortVersionString</key><string>${manifest.version}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
    run('/usr/bin/codesign', ['--force', '--sign', '-', join(contents, 'Resources/runtime/bin/node')]);
    run('/usr/bin/codesign', ['--force', '--sign', '-', application]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
    const finalApp = join(output, `${options.productName}.app`);
    await rm(finalApp, { recursive: true, force: true });
    await cp(application, finalApp, { recursive: true });
    if (options.target === 'pkg') {
      const payload = join(staging, 'installer-payload');
      await mkdir(join(payload, 'Applications'), { recursive: true });
      await cp(application, join(payload, 'Applications', `${options.productName}.app`), { recursive: true });
      const installer = await writeMacInstallerFiles(join(staging, 'installer'), options);
      run('/usr/bin/pkgbuild', ['--root', payload, '--scripts', installer.scripts, '--component-plist', installer.components, '--identifier', `${options.appId}.installer`, '--version', manifest.version, '--ownership', 'recommended', '--install-location', '/', join(output, `${artifactName}.pkg`)]);
    } else if (options.target === 'dmg') {
      const imageRoot = join(staging, 'image'); await mkdir(imageRoot);
      await cp(application, join(imageRoot, `${options.productName}.app`), { recursive: true });
      await symlink('/Applications', join(imageRoot, 'Applications'));
      run('/usr/bin/hdiutil', ['create', '-volname', options.productName, '-srcfolder', imageRoot, '-ov', '-format', 'UDZO', join(output, `${artifactName}.dmg`)]);
    } else if (options.target === 'zip') run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', application, join(output, `${artifactName}.zip`)]);
  } else {
    const source = join(staging, 'tray-source');
    const payload = join(staging, options.productName);
    await cp(join(appRoot, 'distribution/windows'), source, { recursive: true });
    run('dotnet', ['publish', join(source, 'DesktopTray.csproj'), '-c', 'Release', '-r', `win-${options.arch}`, '--self-contained', 'true', '-p:PublishSingleFile=true', '-p:DebugType=None', '-o', payload]);
    await cp(backend, join(payload, 'Resources'), { recursive: true });
    const finalPayload = join(output, options.productName);
    await rm(finalPayload, { recursive: true, force: true });
    await cp(payload, finalPayload, { recursive: true });
    if (options.target === 'zip') {
      const script = join(staging, 'compress.ps1');
      await writeFile(script, 'param([string]$Source, [string]$Destination)\n$ErrorActionPreference = "Stop"\nCompress-Archive -LiteralPath $Source -DestinationPath $Destination -Force\n');
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, payload, join(output, `${artifactName}.zip`)]);
    }
  }
  await writeFile(join(output, 'desktop-config.json'), `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Desktop package ready: ${output}\nAccount Service: ${options.accountServiceUrl}`);
} finally { await rm(staging, { recursive: true, force: true }); }
