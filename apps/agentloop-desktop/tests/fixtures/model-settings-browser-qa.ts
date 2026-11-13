import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startDesktop } from '../../src/application.ts';
import { fixtureAuth } from './auth.ts';

// Real Desktop HTTP, config vault and native SDK. Upstream is deterministic;
// only temporary account data and synthetic credentials are used.
const root = await mkdtemp(join(tmpdir(), 'agentloop-model-settings-browser-'));
await mkdir(join(root, 'skills'));
const screenshotRoot = process.env.MODEL_SETTINGS_QA_OUTPUT ?? root;
await mkdir(screenshotRoot, { recursive: true });
const calls: Array<Record<string, any>> = [];
const upstream = createServer((request, response) => { void (async () => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
  assert.equal(request.headers.authorization, 'Bearer fixture-secret-not-a-real-key');
  if (body.model === 'invalid-model') {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'invalid model; reflected fixture-secret-not-a-real-key' } })); return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: 'browser-qa', object: 'chat.completion', created: 1, model: body.model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
})().catch(() => { response.writeHead(500); response.end(); }); });
await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
const address = upstream.address(); if (!address || typeof address === 'string') throw Error('fixture_bind_failed');
const app = await startDesktop({ mode: 'development', port: 0, dataDirectory: join(root, 'data'), cloudAuth: fixtureAuth(), bundledSkillDirectories: [join(root, 'skills')], openBrowser: false });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const login = await context.request.post(app.origin + '/api/auth/login', { headers: { Origin: app.origin }, data: { email: 'test@example.test', password: 'fixture-only' } });
  assert.equal(login.status(), 200); const { csrfToken } = await login.json();
  const page = await context.newPage(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.origin); await page.locator('#message:not([disabled])').waitFor();
  await page.locator('#model-settings-open').click(); await page.locator('[data-settings-tab="models"]').click();
  await page.locator('#provider-add:not([disabled])').waitFor();
  assert.equal(await page.locator('#provider-empty').isVisible(), true); assert.equal(await page.locator('#model-editor').isVisible(), false);
  await page.locator('#provider-add').click();
  const provider = (key: string) => page.locator(`[data-field-input="provider.${key}"]`);
  const model = (key: string) => page.locator(`#model-form [data-field-input="${key}"]`);
  await provider('preset').selectOption('alibaba');
  assert.equal(await provider('baseUrl').inputValue(), 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  await provider('displayName').fill('百炼 · 工作服务');
  await page.locator('.provider-advanced summary').click(); await provider('key').fill('bailian');
  await provider('baseUrl').fill(`http://127.0.0.1:${address.port}/compatible-mode/v1`);
  await page.locator('#provider-api-key').fill('fixture-secret-not-a-real-key');
  await page.locator('#model-add').click();
  await page.locator('#model-form .model-advanced summary').click();
  await model('displayName').fill('通义千问 · 主模型'); await model('providerModel').fill('qwen3-max'); await model('key').fill('qwen-work');
  await model('contextWindowTokens').fill('131072'); await model('maxOutputTokens').fill('8192'); await model('reasoning').selectOption('medium');
  await model('providerOptions').fill('{"enableThinking":true,"thinkingBudget":1024}');
  await model('extensions').fill('{"provider_flag":{"retained":true}}');
  const before = await (await context.request.get(app.origin + '/api/model-configuration')).json();
  await page.locator('#model-test').click(); await page.locator('#model-test-status').filter({ hasText: '基础调用通过' }).waitFor();
  assert.equal(calls.length, 1); assert.equal(calls[0].enable_thinking, true); assert.equal(calls[0].thinking_budget, 1024); assert.deepEqual(calls[0].provider_flag, { retained: true });
  assert.deepEqual(await (await context.request.get(app.origin + '/api/model-configuration')).json(), before);
  await page.locator('#model-settings-save').click(); await page.locator('#model-settings-status').filter({ hasText: '配置已保存并生效' }).waitFor();
  assert.equal(await page.locator('#provider-api-key').inputValue(), '');
  const saved = await (await context.request.get(app.origin + '/api/model-configuration')).json();
  assert.equal(saved.configuration.providers[0].kind, 'alibaba'); assert.equal(JSON.stringify(saved).includes('fixture-secret'), false);
  await model('displayName').fill('通义千问 · 编辑中的主模型');
  await page.locator('#model-add').click(); await page.locator('#model-form .model-advanced summary').click(); await model('displayName').fill('通义千问 · 备用'); await model('key').fill('qwen-backup'); await model('providerModel').fill('qwen-plus');
  await page.locator('#model-list button').first().click(); assert.equal(await model('displayName').inputValue(), '通义千问 · 编辑中的主模型');
  await page.locator('#model-list button').nth(1).click(); assert.equal(await model('providerModel').inputValue(), 'qwen-plus');
  await page.locator('#model-list button').first().click();
  await model('providerModel').fill('invalid-model'); await page.locator('#model-test').click();
  await page.locator('#model-test-status').filter({ hasText: 'HTTP 400' }).waitFor();
  assert.match(await page.locator('#model-test-status').innerText(), /invalid model/); assert.doesNotMatch(await page.locator('#model-test-status').innerText(), /fixture-secret/);
  await model('providerModel').fill('qwen3-max');
  await page.locator('#model-settings-save').click(); await page.locator('#model-settings-status').filter({ hasText: '配置已保存并生效' }).waitFor();
  await page.locator('#model-settings-done').click(); await page.reload();
  await page.locator('#model-settings-open').click(); await page.locator('[data-settings-tab="models"]').click();
  await page.locator('#model-list button').nth(1).waitFor();
  assert.equal(await model('reasoning').inputValue(), 'medium');
  await page.screenshot({ path: join(screenshotRoot, 'model-configuration-desktop.png'), fullPage: true });
  // Reproduce an existing generic-provider configuration from the model editor:
  // opening and unrelated edits preserve its off switch, while selecting a
  // level replaces legacy controls and reaches the native provider request.
  const legacy = await (await context.request.get(app.origin + '/api/model-configuration')).json();
  const seed = await context.request.post(app.origin + '/api/model-configuration', {
    headers: { Origin: app.origin, 'X-Desktop-CSRF': csrfToken }, data: { revision: legacy.revision, configuration: { reuseCloudModels: false, providers: [{
      ...legacy.configuration.providers[0], preset: undefined, kind: 'openai-compatible', models: [{ key: 'ds-model-flash', displayName: 'DeepSeek4flash', providerModel: 'deepseek-v4.1-flash', protocol: 'chat-completions', enableThinking: false }],
    }] } },
  });
  assert.equal(seed.status(), 200);
  await page.locator('#model-settings-discard').click();
  await model('providerModel').filter({ visible: true }).waitFor();
  await page.waitForFunction(() => (document.querySelector('#model-form [data-field-input="providerModel"]') as HTMLInputElement)?.value === 'deepseek-v4.1-flash');
  assert.equal(await model('reasoning').isEnabled(), true);
  assert.match(await model('reasoning').locator('option:checked').innerText(), /关闭思考/);
  await model('displayName').fill('DeepSeek4flash · 编辑');
  await page.locator('#model-test').click(); await page.locator('#model-test-status').filter({ hasText: '基础调用通过' }).waitFor();
  assert.equal(calls.at(-1)!.enable_thinking, false);
  assert.equal(calls.at(-1)!.reasoning_effort, undefined);
  await model('reasoning').selectOption('high');
  await page.locator('#model-test').click(); await page.locator('#model-test-status').filter({ hasText: '基础调用通过' }).waitFor();
  assert.equal(calls.at(-1)!.reasoning_effort, 'high');
  assert.equal(calls.at(-1)!.enable_thinking, undefined);
  await page.locator('#provider-connection').evaluate((element: HTMLDetailsElement) => { element.open = true; });
  await page.locator('.provider-advanced summary').click();
  await provider('kind').selectOption('alibaba');
  await page.locator('#model-test').click(); await page.locator('#model-test-status').filter({ hasText: '基础调用通过' }).waitFor();
  assert.equal(calls.at(-1)!.enable_thinking, true);
  assert.ok(calls.at(-1)!.thinking_budget > 0);
  await model('reasoning').selectOption('none');
  await page.locator('#model-test').click(); await page.locator('#model-test-status').filter({ hasText: '基础调用通过' }).waitFor();
  assert.equal(calls.at(-1)!.enable_thinking, false);
  assert.equal(calls.at(-1)!.thinking_budget, undefined);
  await page.locator('#model-settings-save').click(); await page.locator('#model-settings-status').filter({ hasText: '配置已保存并生效' }).waitFor();
  await page.locator('#model-settings-done').click(); await page.reload();
  await page.locator('#model-settings-open').click(); await page.locator('[data-settings-tab="models"]').click();
  await model('reasoning').waitFor();
  assert.equal(await model('reasoning').inputValue(), 'none');
  const migrated = await (await context.request.get(app.origin + '/api/model-configuration')).json();
  assert.equal(migrated.configuration.providers[0].models[0].reasoning, 'none');
  assert.equal(migrated.configuration.providers[0].models[0].enableThinking, undefined);
  // Concurrent writes must preserve the editor draft after a stale revision.
  const concurrent = await (await context.request.get(app.origin + '/api/model-configuration')).json();
  const update = await context.request.post(app.origin + '/api/model-configuration', { headers: { Origin: app.origin, 'X-Desktop-CSRF': csrfToken }, data: { revision: concurrent.revision, configuration: concurrent.configuration } });
  assert.equal(update.status(), 200);
  await model('displayName').fill('保留这个未保存修改'); await page.locator('#model-settings-save').click();
  await page.locator('#model-settings-status').filter({ hasText: '其他标签页' }).waitFor(); assert.equal(await model('displayName').inputValue(), '保留这个未保存修改');
  await page.locator('#model-settings-discard').click(); await page.locator('#model-list button').first().waitFor();
  // A hosted DeepSeek model keeps SiliconFlow's driver and thinking semantics.
  await page.locator('#provider-add').click();
  await provider('preset').selectOption('siliconflow');
  assert.equal(await provider('baseUrl').inputValue(), 'https://api.siliconflow.cn/v1');
  await provider('baseUrl').fill(`http://127.0.0.1:${address.port}/v1`);
  await page.locator('#provider-api-key').fill('fixture-secret-not-a-real-key');
  await page.locator('#model-add').click();
  await model('displayName').fill('DeepSeek · 工作模型');
  await model('providerModel').fill('deepseek-ai/DeepSeek-V4-Flash');
  await model('enableThinking').selectOption('false');
  await page.locator('#model-test').click(); await page.locator('#model-test-status').filter({ hasText: '基础调用通过' }).waitFor();
  assert.equal(calls.at(-1)!.enable_thinking, false); assert.equal(calls.at(-1)!.reasoning_effort, undefined);
  await page.locator('#model-settings-save').click(); await page.locator('#model-settings-status').filter({ hasText: '配置已保存并生效' }).waitFor();
  const silicon = await (await context.request.get(app.origin + '/api/model-configuration')).json();
  assert.equal(silicon.configuration.providers[1].preset, 'siliconflow');
  assert.equal(silicon.configuration.providers[1].kind, 'openai-compatible');
  await page.locator('#model-settings-discard').click(); await page.locator('#provider-list button').nth(1).click();
  assert.equal(await model('enableThinking').inputValue(), 'false');
  assert.equal(await page.locator('#provider-connection').getAttribute('open'), null);
  await page.screenshot({ path: join(screenshotRoot, 'model-configuration-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('#settings-models').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
  await model('enableThinking').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshotRoot, 'model-configuration-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, root, screenshotRoot, checks: ['empty state', 'provider presets', 'native SDK request', 'probe without persistence', 'credential redaction', 'model draft switching', 'safe upstream reason', 'durable reload', 'legacy thinking directly editable', 'legacy off preserved on unrelated edits', 'selected effort replaces legacy switch', 'Alibaba high and off reach actual request', 'migrated setting survives reload', 'stale edit retention', 'SiliconFlow hosted model switch', 'service preset survives reload', '390px no overflow'] }));
} finally {
  await browser.close(); if (!app.existing) await app.close();
  await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
}
