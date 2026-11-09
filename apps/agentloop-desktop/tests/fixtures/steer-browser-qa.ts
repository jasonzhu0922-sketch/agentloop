import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { ModelAdapter } from '@zhujun/agentloop';
import { startDesktop } from '../../src/application.ts';
import { fixtureAuth } from './auth.ts';
import { greetingModel, modelPort } from '../../../../packages/agentloop-local-runtime/tests/fixtures/models.ts';

// Explicit manual QA: real Desktop HTTP, storage and Kernel; deterministic model.
const root = await mkdtemp(join(tmpdir(), 'agentloop-steer-browser-'));
await mkdir(join(root, 'skills'));
let release!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
const base = greetingModel();
const model: ModelAdapter = { ...base,
  async complete(input, signal) {
    if (input.tools.some(tool => tool.name === 'submit_run_input_decision')) return {
      content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'progress', name: 'submit_run_input_decision', arguments: {
        kind: 'answer', explanation: '当前执行已保存，正在等待生成最终回复。', effectiveGoal: null, userConstraints: null, taskIntent: null,
      } }],
    };
    const response = await base.complete(input, signal);
    if (!response.toolCalls.length) await gate;
    return response;
  },
  async streamComplete(input, sink, signal) {
    const response = await base.complete(input, signal);
    if (response.toolCalls.length) return response;
    await sink({ type: 'text_delta', text: '正在执行队列交互验收……' });
    await gate;
    return { ...response, content: '确定性测试模型：任务完成，Steer 消息已回答。' };
  },
};
const app = await startDesktop({ mode: 'development', port: 0, dataDirectory: join(root, 'data'), models: modelPort(model), cloudAuth: fixtureAuth(), bundledSkillDirectories: [join(root, 'skills')], openBrowser: false });
assert.equal(app.existing, false);
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const login = await context.request.post(app.origin + '/api/auth/login', { headers: { Origin: app.origin }, data: { email: 'test@example.test', password: 'fixture-only' } });
  assert.equal(login.status(), 200);
  const page = await context.newPage(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  console.log(JSON.stringify({ root, origin: app.origin }));
  await page.goto(app.origin); await page.locator('#message:not([disabled])').waitFor();
  await page.locator('#model').selectOption('local:test');
  await page.locator('#message').fill('你好'); await page.locator('#send').click();
  try { await page.locator('#cancel:not([hidden])').waitFor({ timeout: 8000 }); }
  catch (error) { console.log(await page.locator('body').innerText()); console.log(errors); throw error; }
  assert.equal(await page.locator('#message').isEnabled(), true);
  await page.locator('#message').fill('进展如何？'); await page.locator('#send').click();
  const queue = page.locator('#steer-queue');
  await queue.getByRole('button', { name: '编辑', exact: true }).click();
  await queue.locator('textarea').fill('请说明当前进展');
  await page.waitForTimeout(1200);
  assert.equal(await queue.locator('textarea').inputValue(), '请说明当前进展');
  await queue.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('#message').fill('删除这条草稿'); await page.locator('#send').click();
  await queue.locator('.steer-queue-item').nth(1).getByRole('button', { name: '删除', exact: true }).click();
  assert.equal(await queue.locator('.steer-queue-item').count(), 1);
  await page.reload(); await queue.locator('textarea').waitFor();
  assert.equal(await queue.locator('textarea').inputValue(), '请说明当前进展');
  await page.screenshot({ path: join(root, 'desktop-queue.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(root, 'narrow-queue.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const gap = await page.evaluate(() => document.querySelector('.composer-box')!.getBoundingClientRect().top - document.querySelector('#steer-queue')!.getBoundingClientRect().bottom);
  assert.ok(gap >= 0 && gap <= 10, 'queue remains directly above composer');
  await queue.getByRole('button', { name: 'Steer', exact: true }).click();
  await page.locator('.steer-message-user', { hasText: '请说明当前进展' }).waitFor();
  assert.equal(await queue.locator('.steer-queue-item').count(), 0);
  release();
  await page.getByText('已回答', { exact: true }).waitFor();
  await page.locator('#cancel[hidden]').waitFor({ state: 'attached' });
  await page.reload(); await page.getByText('已回答', { exact: true }).waitFor();
  assert.equal(await page.locator('.steer-message-user').count(), 1);
  await page.screenshot({ path: join(root, 'narrow-answered.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, model: 'deterministic', origin: app.origin, screenshots: root, checks: ['active composer', 'queue edit/delete', 'reload draft', 'explicit Steer', 'durable answer after reload', '390px no overflow'] }));
} finally {
  release(); await browser.close();
  if (!app.existing) await app.close();
}
