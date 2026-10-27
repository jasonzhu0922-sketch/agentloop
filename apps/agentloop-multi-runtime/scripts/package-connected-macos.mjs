#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = resolve(appRoot, '../..')
const routerUrl = process.env.AGENTLOOP_ROUTER_URL_TEST ?? 'http://10.251.40.44'
const webOrigin = process.env.AGENTLOOP_WEB_ORIGIN_TEST ?? 'http://10.251.40.44'
const webUrl = process.env.AGENTLOOP_WEB_URL_TEST ?? new URL('/agentloop/', webOrigin).toString()
const pythonInstallDir = join(appRoot, 'release/local-agent/build-python')

if (process.argv.includes('--help')) {
  process.stdout.write('Build the Apple Silicon Local Runtime Agent for the test Web page.\n')
  process.stdout.write('Overrides: AGENTLOOP_ROUTER_URL_TEST, AGENTLOOP_WEB_ORIGIN_TEST, AGENTLOOP_WEB_URL_TEST, AGENTLOOP_PACKAGED_PYTHON_ROOT.\n')
  process.exit(0)
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Build this package on an Apple Silicon Mac')
}
if (Number(process.versions.node.split('.')[0]) !== 26) {
  throw new Error(`Node 26.x is required; found ${process.versions.node}`)
}
for (const [name, value] of [['Router', routerUrl], ['Web', webOrigin]]) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`${name} must be an HTTP(S) origin without a path: ${value}`)
  }
}
if (new URL(webUrl).origin !== new URL(webOrigin).origin) {
  throw new Error(`Web page URL must share the configured Web origin: ${webUrl}`)
}

let pythonRoot = process.env.AGENTLOOP_PACKAGED_PYTHON_ROOT
if (pythonRoot === undefined || pythonRoot.trim() === '') {
  await mkdir(pythonInstallDir, { recursive: true })
  const installed = (await readdir(pythonInstallDir)).filter((name) => name.startsWith('cpython-3.12.')).sort().reverse()
  pythonRoot = installed.map((name) => join(pythonInstallDir, name))
    .find((path) => existsSync(join(path, 'bin/python3.12')))
  if (pythonRoot === undefined) {
    run('uv', ['python', 'install', '--install-dir', pythonInstallDir, '--no-bin', '3.12'])
    const downloaded = (await readdir(pythonInstallDir)).filter((name) => name.startsWith('cpython-3.12.')).sort().reverse()
    pythonRoot = downloaded.map((name) => join(pythonInstallDir, name))
      .find((path) => existsSync(join(path, 'bin/python3.12')))
  }
}
if (pythonRoot === undefined) throw new Error('Unable to prepare standalone Python 3.12 with uv')
process.stdout.write(`Packaging Local Runtime Agent for ${webOrigin} via ${routerUrl}\n`)
run('npm', ['run', 'package:local-agent:mac'], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    AGENTLOOP_RELEASE_ENV: 'test',
    AGENTLOOP_ROUTER_URL_TEST: routerUrl,
    AGENTLOOP_WEB_ORIGIN_TEST: webOrigin,
    AGENTLOOP_WEB_URL: webUrl,
    AGENTLOOP_PACKAGED_PYTHON_ROOT: pythonRoot,
  },
})

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`)
}
