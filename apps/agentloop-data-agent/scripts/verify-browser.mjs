import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const output = resolve('data/qa');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.DATA_AGENT_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.DATA_AGENT_TEST_ORIGIN ?? 'http://127.0.0.1:8810');
  await page.waitForFunction(() => !document.querySelector('#notice').textContent);
  await page.screenshot({ path: join(output, 'welcome.png'), fullPage: true });
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, 'mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#prompt').fill(process.env.DATA_AGENT_TEST_QUESTION ?? '查询人力月报数据中最新的月份。');
  const accepted = page.waitForResponse(r => r.url().endsWith('/api/messages') && r.request().method() === 'POST');
  await page.locator('#send').click();
  const response = await accepted;
  assert.equal(response.status(), 202, await response.text());
  const { run } = await response.json();
  console.log('Live browser Run:', run.id);
  let snapshot;
  for (let attempt = 0; attempt < 150; attempt++) {
    snapshot = await page.evaluate(async id => (await fetch(`/api/runs/${id}`)).json(), run.id);
    if (snapshot.run.status !== 'running' || snapshot.humanLoop) break;
    if (attempt % 10 === 0) console.log('Run progress:', snapshot.events.at(-1)?.type ?? 'pending');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  await page.screenshot({ path: join(output, 'conversation.png'), fullPage: true });
  await writeFile(join(output, 'live-run.json'), JSON.stringify(snapshot, null, 2));
  assert.equal(snapshot.run.status, 'completed', JSON.stringify({ status: snapshot.run.status, errorCode: snapshot.run.errorCode, hil: snapshot.humanLoop }));
  assert.ok(snapshot.run.output?.trim());
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.message').length >= 2);
  assert.equal(await page.locator('.message.user').count(), 1);
  assert.equal(await page.locator('#notice').textContent(), '');
  assert.deepEqual(errors, []);
  console.log('Browser, mobile, live answer and reload checks passed. Screenshots:', output);
} finally { await browser.close(); }
