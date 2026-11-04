import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, access, cp, readdir, chmod, lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const sourceRoot = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node scripts/smoke-package.mjs /path/to/Resources [--probe-account-service]');
const config = JSON.parse(await readFile(join(sourceRoot, 'desktop-config.json'), 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'desktop-package-smoke-'));
const resourceRoot = join(directory, 'relocated', 'Resources');
await cp(sourceRoot, resourceRoot, { recursive: true });
const node = join(resourceRoot, 'runtime/bin', process.platform === 'win32' ? 'node.exe' : 'node');
try {
  // Resolve all tools with host Node/Python and user site packages excluded.
  await cp(new URL('./probe-packaged-tools.mjs', import.meta.url), join(resourceRoot, 'probe-tools.mjs'));
  const toolsWorkspace = join(directory, 'workspace'); await mkdir(toolsWorkspace);
  execFileSync(node, [join(resourceRoot, 'probe-tools.mjs')], { cwd: toolsWorkspace, env: { ...process.env, PATH: process.platform === 'win32' ? process.env.SystemRoot + '\\System32' : '/usr/bin:/bin', NODE_PATH: '', NODE_OPTIONS: '', PYTHONHOME: '/nonexistent-host-python', PYTHONPATH: '/nonexistent-host-site' }, stdio: 'inherit', timeout: 120000 });
  for (let iteration = 0; iteration < 2; iteration++) {
    const child = spawn(node, [join(resourceRoot, 'backend.mjs')], {
      cwd: directory, env: { ...process.env, PATH: process.platform === 'win32' ? process.env.SystemRoot + '\\System32' : '/usr/bin:/bin', PYTHONHOME: '/nonexistent-host-python', PYTHONPATH: '/nonexistent-host-site', NODE_PATH: '', NODE_OPTIONS: '', AGENTLOOP_DESKTOP_DATA_DIR: join(directory, 'data') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    const messages = []; const listeners = [];
    child.stderr.on('data', () => {}); // Native-library warnings are not protocol data.
    lines.on('line', line => {
      if (!line.startsWith('AGENTLOOP_DESKTOP:')) return;
      const message = JSON.parse(line.slice('AGENTLOOP_DESKTOP:'.length)); messages.push(message);
      for (const listener of listeners.splice(0)) listener();
    });
    let timeout;
    try {
      const ready = await Promise.race([
        (async () => { while (!messages.length) await new Promise(resolve => listeners.push(resolve)); return messages.shift(); })(),
        exited.then(() => { throw new Error('Packaged backend exited before ready'); }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Packaged backend startup timeout')), 30000); }),
      ]);
      clearTimeout(timeout);
      assert.equal(ready.type, 'ready');
      const origin = ready.origin;
      for (const path of ['/', '/login', '/app.js', '/markdown.js', '/markdown.css', '/reference/ui/scroll-follow.js']) assert.equal((await fetch(origin + path)).status, 200, path);
      const auth = await (await fetch(origin + '/api/auth/config')).json();
      assert.deepEqual(auth, { configured: true, issuer: config.accountServiceUrl });
      assert.equal((await fetch(origin + '/api/models')).status, 401);
      if (iteration === 0 && process.argv.includes('--probe-account-service')) {
        const response = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'desktop-package-probe@example.invalid', password: 'invalid-package-probe-password' }) });
        assert.equal(response.status, 401, 'Account Service must reject synthetic credentials, not fail with unavailable');
        assert.equal((await response.json()).error, 'invalid_credentials');
      }
      const marker = JSON.parse(await readFile(join(directory, 'data/.desktop-data.json'), 'utf8'));
      assert.equal(marker.mode, 'packaged');
      child.stdin.write('close\n');
      const [code] = await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Packaged shutdown timeout')), 15000); })]);
      clearTimeout(timeout); assert.equal(code, 0);
      await assert.rejects(access(join(directory, 'data/.desktop-instance.lock')));
      console.log(`Packaged backend ${iteration ? 'restart' : 'start'}: assets, auth boundary, graceful shutdown passed.`);
    } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); lines.close(); }
  }
} finally { await removeSmokeDirectory(directory); }

async function removeSmokeDirectory(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return;
  await chmod(path, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) for (const name of await readdir(path)) await removeSmokeDirectory(join(path, name));
  if (path === directory) await rm(path, { recursive: true, force: true });
}
