import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/stop-development.sh', import.meta.url));

test('restart waits for the old host and refuses to continue when it cannot exit', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-restart-command-'));
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}` };
  const lookup = join(root, 'lsof'); let child;
  try {
    await writeFile(lookup, '#!/bin/sh\nexit 1\n'); await chmod(lookup, 0o700);
    assert.match((await execute('bash', [script], { env })).stdout, /Desktop 未运行/);
    child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(child.stdout, 'data');
    await writeFile(lookup, `#!/bin/sh\nprintf '%s\\n' ${child.pid}\n`);
    const exited = once(child, 'exit');
    assert.match((await execute('bash', [script], { env, timeout: 5000 })).stdout, /旧 Desktop 已退出/);
    await exited; child = undefined;
    child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(child.stdout, 'data');
    await writeFile(lookup, `#!/bin/sh\nprintf '%s\\n' ${child.pid}\n`);
    const pause = join(root, 'sleep'); await writeFile(pause, '#!/bin/sh\nexit 0\n'); await chmod(pause, 0o700);
    await assert.rejects(execute('bash', [script], { env, timeout: 5000 }), error => error.code === 1 && error.stderr.includes('本次不会复用旧进程'));
    assert.equal(child.exitCode, null);
    const manifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
    assert.equal(manifest.scripts['restart:desktop'], 'bash apps/agentloop-desktop/scripts/stop-development.sh && npm run build:local-runtime && npm run start:desktop');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
