import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { publishKernel, bindKernelConsumer, readChannel, activateKernel } from './kernel-release.mjs';

const readKernel = cwd => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "console.log((await import('@zhujun/agentloop')).marker)"], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
test('published channel changes only on successful release; linked consumers and npm ci follow it on a new process', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'agentloop-release-contract-'));
  const previousCache = process.env.npm_config_cache;
  process.env.npm_config_cache = join(root, 'npm-cache');
  let existing;
  try {
    const packageRoot = join(root, 'source'), channelRoot = join(root, 'channel');
    await fs.mkdir(join(packageRoot, 'dist'), { recursive: true });
    await fs.writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@zhujun/agentloop', version: '0.1.0', type: 'module', exports: { '.': './dist/index.js', './package.json': './package.json' }, files: ['dist'] }));
    const write = async marker => {
      await fs.writeFile(join(packageRoot, 'dist/index.js'), `export const marker = ${JSON.stringify(marker)}; export const lazy = () => import('./lazy.js');\n`);
      await fs.writeFile(join(packageRoot, 'dist/lazy.js'), `export const marker = ${JSON.stringify(marker)};\n`);
    };
    await write('one');
    const first = await publishKernel({ packageRoot, channelRoot, build: false });
    const consumers = ['report', 'data'].map(name => join(root, name));
    for (const consumer of consumers) {
      await fs.mkdir(consumer); await fs.writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
      await bindKernelConsumer(consumer, channelRoot);
      assert.equal(readKernel(consumer), 'one');
      const link = await fs.readlink(join(consumer, 'node_modules/@zhujun/agentloop'));
      assert.ok(link.endsWith('/package'), `npm must retain the stable channel root, not pin ${link}`);
      const pkg = JSON.parse(await fs.readFile(join(consumer, 'package.json'), 'utf8'));
      assert.ok(pkg.dependencies['@zhujun/agentloop'].endsWith('/channel/package'));
    }
    existing = spawn(process.execPath, ['--input-type=module', '-e', "const k=await import('@zhujun/agentloop');console.log('ready');process.stdin.once('data',async()=>{console.log(k.marker,(await k.lazy()).marker);process.exit(0)});"], { cwd: consumers[0], stdio: ['pipe', 'pipe', 'pipe'] });
    await once(existing.stdout, 'data');
    await write('unpublished');
    assert.equal(readKernel(consumers[0]), 'one', 'editing/building source does not publish it');
    await fs.writeFile(join(packageRoot, 'dist/index.js'), "throw new Error('broken release'); export const marker = 'broken';\n");
    await assert.rejects(publishKernel({ packageRoot, channelRoot, build: false }), /broken release/);
    assert.equal((await readChannel(channelRoot)).releaseId, first.releaseId);
    assert.equal(readKernel(consumers[1]), 'one', 'failed publication preserves current');
    await write('two');
    const second = await publishKernel({ packageRoot, channelRoot, build: false });
    assert.notEqual(second.releaseId, first.releaseId);
    for (const consumer of consumers) assert.equal(readKernel(consumer), 'two');
    const output = []; existing.stdout.on('data', chunk => output.push(chunk.toString()));
    const stopped = once(existing, 'exit'); existing.stdin.write('continue\n');
    assert.equal((await stopped)[0], 0); existing = undefined;
    assert.equal(output.join('').trim(), 'one one', 'running processes and lazy internal imports stay on their immutable release');
    const reinstall = spawnSync('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumers[0], encoding: 'utf8' });
    assert.equal(reinstall.status, 0, reinstall.stderr);
    assert.equal(readKernel(consumers[0]), 'two');
    const repeat = await publishKernel({ packageRoot, channelRoot, build: false });
    assert.equal(repeat.releaseId, second.releaseId, 'identical package bytes have one immutable release');
    await activateKernel(first.releaseId, channelRoot);
    for (const consumer of consumers) assert.equal(readKernel(consumer), 'one', 'rollback takes effect on next start');
    await assert.rejects(activateKernel('../escape', channelRoot), /Invalid release/);
    await fs.mkdir(join(channelRoot, '.publish-lock'));
    await assert.rejects(publishKernel({ packageRoot, channelRoot, build: false }), /channel is locked/);
    await fs.rm(join(channelRoot, '.publish-lock'), { recursive: true });
    assert.equal((await readChannel(channelRoot)).releaseId, first.releaseId);
  } finally {
    existing?.kill();
    if (previousCache === undefined) delete process.env.npm_config_cache; else process.env.npm_config_cache = previousCache;
    await fs.rm(root, { recursive: true, force: true });
  }
});
