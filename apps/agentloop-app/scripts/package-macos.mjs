#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(appRoot, '../..')
const version = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')).version
const releaseRoot = resolve(process.env.AGENTLOOP_MAC_OUTPUT_DIR ?? join(appRoot, 'release/macos-arm64'))
const appName = 'AgentLoop.app'
const buildRoot = await mkdtemp(join(tmpdir(), 'agentloop-app-macos-'))
const application = join(releaseRoot, appName)
const resources = join(application, 'Contents/Resources')
const executable = join(application, 'Contents/MacOS/AgentLoop')
const identity = process.env.APPLE_CODESIGN_IDENTITY ?? '-'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The AgentLoop Mac package must be built on Apple Silicon macOS')
}
if (Number(process.versions.node.split('.')[0]) < 26) {
  throw new Error(`Node 26 or newer is required; found ${process.versions.node}`)
}

try {
  run('npm', ['run', 'build'], { cwd: repositoryRoot })
  await mkdir(releaseRoot, { recursive: true })
  await rm(application, { recursive: true, force: true })
  await mkdir(join(application, 'Contents/MacOS'), { recursive: true })
  await mkdir(resources, { recursive: true })
  await cp(join(repositoryRoot, 'assets/AgentLoop.icns'), join(resources, 'AgentLoop.icns'))

  const server = join(resources, 'server')
  const modules = join(server, 'node_modules')
  await cp(join(appRoot, 'src'), join(server, 'src'), { recursive: true })
  await writeFile(join(server, 'package.json'), '{"type":"module"}\n')
  await mkdir(join(server, 'config'), { recursive: true })
  await cp(join(appRoot, 'config/step-execution-strategy.json'), join(server, 'config/step-execution-strategy.json'))
  await cp(join(appRoot, 'web/dist'), join(resources, 'web'), { recursive: true })
  await cp(join(appRoot, 'config/llm-providers.example.json'), join(resources, 'llm-providers.example.json'))

  for (const name of ['agentloop', 'agentloop-skills', 'agentloop-plan-template']) {
    const source = join(repositoryRoot, 'packages', name)
    const target = join(modules, '@zhujun', name)
    await mkdir(target, { recursive: true })
    await cp(join(source, 'package.json'), join(target, 'package.json'))
    await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true })
    if (name === 'agentloop-skills') {
      await cp(join(source, 'skills'), join(target, 'skills'), { recursive: true })
    }
  }
  await copyDependencies(modules, ['docx', 'pptxgenjs', 'jszip'])

  const packagedNode = join(resources, 'node')
  await cp(process.execPath, packagedNode)
  await chmod(packagedNode, 0o755)
  run('/usr/bin/codesign', ['--remove-signature', packagedNode], { optional: true })
  const libraries = await bundleNodeLibraries(process.execPath, packagedNode, join(resources, 'lib'))

  run('/usr/bin/swiftc', [
    '-module-cache-path', join(buildRoot, 'swift-module-cache'),
    join(appRoot, 'distribution/macos/AgentLoopApp.swift'),
    '-framework', 'AppKit', '-framework', 'WebKit',
    '-o', executable,
  ])
  await writeFile(join(application, 'Contents/Info.plist'), infoPlist(version))
  for (const library of libraries) run('/usr/bin/codesign', ['--force', '--sign', identity, library])
  run('/usr/bin/codesign', ['--force', '--sign', identity, packagedNode])
  run('/usr/bin/codesign', ['--force', '--sign', identity, '--options', 'runtime', application])

  const dmg = join(releaseRoot, `AgentLoop-${version}-macos-arm64.dmg`)
  await rm(dmg, { force: true })
  run('/usr/bin/hdiutil', ['create', '-volname', 'AgentLoop', '-srcfolder', application, '-ov', '-format', 'UDZO', dmg])
  process.stdout.write(`Built ${application}\nBuilt ${dmg}\n`)
} finally {
  await rm(buildRoot, { recursive: true, force: true })
}

async function copyDependencies(destination, initial) {
  const sourceRoot = join(repositoryRoot, 'node_modules')
  const pending = [...initial]
  const copied = new Set()
  while (pending.length > 0) {
    const name = pending.shift()
    if (copied.has(name) || name.startsWith('@types/')) continue
    copied.add(name)
    const source = join(sourceRoot, name)
    if (!existsSync(source)) throw new Error(`Missing installed package: ${name}`)
    const target = join(destination, name)
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { recursive: true, dereference: true })
    const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    pending.push(...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}))
  }
}

async function bundleNodeLibraries(sourceBinary, packagedBinary, destination) {
  await mkdir(destination, { recursive: true })
  const pending = [{ source: sourceBinary, target: packagedBinary, root: true }]
  const copied = new Map()
  const processed = new Set()
  while (pending.length > 0) {
    const current = pending.shift()
    if (processed.has(current.source)) continue
    processed.add(current.source)
    for (const dependency of macDependencies(current.source)) {
      const source = resolveMacDependency(current.source, dependency)
      if (source === undefined) continue
      let target = copied.get(source)
      if (target === undefined) {
        target = join(destination, basename(source))
        if (existsSync(target)) throw new Error(`Duplicate runtime library name: ${basename(source)}`)
        await cp(source, target)
        await chmod(target, 0o755)
        run('/usr/bin/codesign', ['--remove-signature', target], { optional: true })
        run('/usr/bin/install_name_tool', ['-id', `@loader_path/${basename(target)}`, target])
        copied.set(source, target)
      }
      const replacement = current.root
        ? `@loader_path/lib/${basename(target)}`
        : `@loader_path/${basename(target)}`
      run('/usr/bin/install_name_tool', ['-change', dependency, replacement, current.target])
      pending.push({ source, target, root: false })
    }
  }
  return [...copied.values()]
}

function macDependencies(binary) {
  const result = spawnSync('/usr/bin/otool', ['-L', binary], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Cannot inspect macOS runtime: ${binary}`)
  return result.stdout.split('\n').slice(1).map((line) => line.trim().split(' ')[0]).filter(Boolean)
}

function resolveMacDependency(binary, dependency) {
  if (dependency.startsWith('/System/') || dependency.startsWith('/usr/lib/')) return undefined
  if (dependency.startsWith('/')) {
    if (!existsSync(dependency)) throw new Error(`Missing runtime library: ${dependency}`)
    return realpathSync(dependency)
  }
  if (!dependency.startsWith('@')) return undefined
  const name = basename(dependency)
  const output = spawnSync('/usr/bin/otool', ['-l', binary], { encoding: 'utf8' })
  const rpaths = output.stdout.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('path ')).map((line) => line.split(' ')[1])
  const prefixes = dependency.startsWith('@rpath/') ? rpaths : [dirname(dependency)]
  for (const prefix of prefixes) {
    const candidate = resolve(dirname(binary), prefix.replace('@loader_path', '.').replace('@executable_path', '.'), name)
    if (existsSync(candidate)) return realpathSync(candidate)
  }
  throw new Error(`Cannot resolve runtime library ${dependency} from ${binary}`)
}

function infoPlist(appVersion) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.agentloop.app</string>
<key>CFBundleName</key><string>AgentLoop</string>
<key>CFBundleDisplayName</key><string>AgentLoop</string>
<key>CFBundleExecutable</key><string>AgentLoop</string>
<key>CFBundleIconFile</key><string>AgentLoop.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${appVersion}</string>
<key>CFBundleVersion</key><string>${appVersion}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>\n`
}

function run(command, args, { cwd, optional = false } = {}) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (!optional && result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`)
}
