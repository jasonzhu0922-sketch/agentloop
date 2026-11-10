import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

test('packaged backend sends operational summaries to the host log, separate from tray messages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-packaged-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist', 'auth'), { recursive: true });
  await copyFile(new URL('../distribution/backend.mjs', import.meta.url), join(root, 'backend.mjs'));
  await writeFile(join(root, 'desktop-config.json'), JSON.stringify({ accountServiceUrl: 'https://example.com', version: '0.2.3', update: { sequence: 17 } }));
  await writeFile(join(root, 'dist', 'application.js'), `export async function startDesktop(options) { options.log('event=run.completed'); return { existing: false, origin: 'http://127.0.0.1:1234', close: async () => {} }; }`);
  await writeFile(join(root, 'dist', 'auth', 'cloud-auth.js'), 'export class CloudAccountAuth {}');
  await writeFile(join(root, 'packaged-tools.mjs'), 'export async function packagedToolEnvironment() { return {}; } export async function verifyPackagedPython() {}');
  await writeFile(join(root, 'update-client.mjs'), 'export async function checkDesktopUpdate() {} export async function downloadDesktopUpdate() {}');
  for (const name of ['connector-feishu', 'connector-126-mail', 'connector-wps']) {
    const dir = join(root, 'node_modules', '@zhujun', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `@zhujun/${name}`, main: 'index.js' }));
    await writeFile(join(dir, 'index.js'), '');
  }
  const child = spawn(process.execPath, [join(root, 'backend.mjs')], { env: { ...process.env, AGENTLOOP_DESKTOP_DATA_DIR: join(root, 'data') } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; if (stdout.includes('"type":"ready"')) child.stdin.end('close\n'); });
  child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, stderr);
  assert.match(stderr, /event=run\.completed/);
  assert.match(stderr, /本地服务已就绪/);
  assert.doesNotMatch(stdout, /event=run\.completed/);
  assert.match(stdout, /AGENTLOOP_DESKTOP:.*"type":"ready"/);
  assert.match(stdout, /AGENTLOOP_DESKTOP:.*"version":"0\.2\.3"/);
  const ready = stdout.split('\n').filter(line => line.startsWith('AGENTLOOP_DESKTOP:')).map(line => JSON.parse(line.slice('AGENTLOOP_DESKTOP:'.length))).find(message => message.type === 'ready');
  assert.equal(ready.updateSequence, 17);
});
