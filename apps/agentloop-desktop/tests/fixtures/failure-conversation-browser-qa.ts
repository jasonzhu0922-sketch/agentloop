import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { EncryptedLocalRuntimeSecretStore } from '@zhujun/agentloop-local-runtime';
import { startDesktop } from '../../src/application.ts';
import { fixtureAuth, TEST_OWNER } from './auth.ts';
import { modelPort } from '../../../../packages/agentloop-local-runtime/tests/fixtures/models.ts';

// Explicit browser QA using the real HTTP API, encrypted vault, Kernel and
// renderer. All account data and the deliberately removed credential are temporary.
const root = await mkdtemp(join(tmpdir(), 'agentloop-failure-conversation-'));
const broken = join(root, 'skills', 'broken'); await mkdir(broken, { recursive: true });
await writeFile(join(broken, 'SKILL.md'), '---\nname: broken\ndescription: A broken Skill\n---\n\nInstructions.\n');
await writeFile(join(broken, 'agentloop.skill.json'), '{invalid');
const app = await startDesktop({ mode: 'development', port: 0, dataDirectory: join(root, 'data'),
  models: modelPort(), cloudAuth: fixtureAuth(), bundledSkillDirectories: [join(root, 'skills')], openBrowser: false,
  connectorModules: [{ modulePath: fileURLToPath(new URL('../../../../packages/connector-126-mail/src/index.ts', import.meta.url)), exportName: 'createConfigured126MailConnector' }],
});
assert.equal(app.existing, false);
let browser;
try {
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const login = await context.request.post(app.origin + '/api/auth/login', { headers: { Origin: app.origin }, data: { email: 'test@example.test', password: 'fixture-only' } });
  assert.equal(login.status(), 200); const { csrfToken } = await login.json();
  const saved = await context.request.post(app.origin + '/api/connectors', {
    headers: { Origin: app.origin, 'X-Desktop-CSRF': csrfToken },
    data: { connector: { connectorKey: '126-mail', displayName: '测试邮箱', enabled: true, scopes: ['email:search', 'email:read'], credentials: { username: 'test@example.test', password: 'synthetic-only-secret' } } },
  });
  assert.equal(saved.status(), 200); const { connector } = await saved.json();
  const vault = new EncryptedLocalRuntimeSecretStore(join(root, 'data', 'accounts', TEST_OWNER, 'private', 'connector-secrets'));
  const keys = await vault.listKeys(); assert.equal(keys.length, 1); await vault.remove(keys[0]!);
  const page = await context.newPage(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.origin); await page.locator('#message:not([disabled])').waitFor();
  await page.locator('#model').selectOption('local:test');
  await page.locator(`#run-connectors input[value="${connector.id}"]`).check();
  await page.locator('#message').fill('整理我这周收到的邮件'); await page.locator('#send').click();
  const failure = page.locator('.failure-title');
  await failure.waitFor();
  assert.match(await failure.innerText(), /凭据已丢失.*设置.*重新填写/);
  const warning = page.locator('.runtime-diagnostic');
  assert.equal(await warning.count(), 0);
  assert.equal(await page.locator('.execution-process').isVisible(), false);
  await page.reload(); await failure.waitFor();
  assert.equal(await warning.count(), 0); assert.match(await failure.innerText(), /凭据已丢失/);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await failure.scrollIntoViewIfNeeded();
    assert.equal(await warning.count(), 0); assert.equal(await failure.isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(root, `failure-${width}.png`), fullPage: true });
  }
  assert.doesNotMatch(await page.locator('#transcript').innerText(), /Skill「broken」加载失败|SKILL_PACKAGE_INVALID|synthetic-only-secret|local_secret_/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, root, checks: ['real missing-credential failure', 'invalid Skill warning absent', 'collapsed process', 'reload replay', '1440 and 390 widths', 'no secret disclosure', 'no page errors'] }));
} finally {
  await browser?.close(); if (!app.existing) await app.close();
}
