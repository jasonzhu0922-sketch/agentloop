import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const output = resolve('data/qa');
await mkdir(output, { recursive: true });
async function browserExecutable() {
  const candidates = [process.env.DATA_AGENT_CHROME,
    ...(process.platform === 'win32' ? [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ] : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'])].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try the next installed browser. */ }
  }
  throw new Error('Chrome or Edge was not found; set DATA_AGENT_CHROME to its executable path');
}
const browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true });
const origin = process.env.DATA_AGENT_TEST_ORIGIN ?? 'http://127.0.0.1:8810';

async function verifyIncrementalTechnicalDetails() {
  const page = await browser.newPage({ viewport: { width: 900, height: 320 } });
  const errors = [];
  const createdAt = Date.now();
  let releaseCompletion = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
    if (url.pathname === '/api/config') { await respond({ defaultModelKey: 'browser-test', models: [{ key: 'browser-test', displayName: 'Browser Test' }] }); return; }
    if (url.pathname === '/api/sample-questions') { await respond({ questions: [] }); return; }
    if (url.pathname === '/api/conversations') { await respond({ conversations: [] }); return; }
    if (url.pathname === '/api/messages' && request.method() === 'POST') {
      await respond({ run: { id: 'incremental-tool-run', conversationId: 'incremental-conversation', input: '增量工具详情验证', modelKey: 'browser-test', status: 'running', createdAt } }, 202); return;
    }
    if (url.pathname === '/api/runs/incremental-tool-run') {
      const after = Number(url.searchParams.get('after') || 0);
      const events = after === 0 ? [{ seq: 1, type: 'tool.planned', createdAt: createdAt + 100, data: {
        step: 1, toolCallId: 'visible-tool', toolName: 'computer_run_command', arguments: { command: 'python3', args: ['scripts/data_client.py', 'retrieve-knowledge'] },
      } }] : after === 1 && releaseCompletion ? [{ seq: 2, type: 'tool.completed', createdAt: createdAt + 600, data: {
        step: 1, toolCallId: 'visible-tool', toolName: 'computer_run_command', operationStatus: 'succeeded', exitCode: 0,
        resultPreview: '{\n  "status": "completed",\n  "summary": "真实返回摘要已更新"\n}',
      } }] : [];
      await respond({ run: { id: 'incremental-tool-run', conversationId: 'incremental-conversation', input: '增量工具详情验证', modelKey: 'browser-test', status: 'running', createdAt }, humanLoop: null, events }); return;
    }
    await route.continue();
  });
  try {
    await page.goto(origin);
    await page.locator('#prompt').fill('增量工具详情验证');
    await page.locator('#send').click();
    const tool = page.locator('[data-tool-call-id="visible-tool"]');
    await tool.waitFor({ timeout: 10_000 });
    const details = tool.locator('.preview-execution-tool');
    await details.locator('summary').click();
    assert.equal(await details.evaluate(node => node.open), true);
    const result = details.locator('.preview-execution-tool__result');
    const before = await result.textContent();
    assert.match(before, /尚无返回记录/);
    await page.evaluate(() => window.scrollTo(0, Math.min(120, document.documentElement.scrollHeight - innerHeight)));
    const scroll = await page.evaluate(() => scrollY);
    releaseCompletion = true;
    await page.waitForFunction(() => document.querySelector('[data-tool-call-id="visible-tool"] .preview-execution-tool__result')?.textContent?.includes('真实返回摘要已更新'), undefined, { timeout: 10_000 });
    assert.equal(await details.evaluate(node => node.open), true);
    assert.notEqual(await result.textContent(), before);
    assert.ok(Math.abs((await page.evaluate(() => scrollY)) - scroll) <= 2, 'live tool update preserves page scroll position');
    assert.deepEqual(errors, []);
    console.log('Incremental technical details browser check passed.');
  } finally { await page.close(); }
}

async function verifyArtifactDownloads() {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const createdAt = Date.now();
  const runs = [
    { id: 'file-run', conversationId: 'artifact-conversation', input: '生成 Excel 报告', modelKey: 'browser-test', status: 'completed', createdAt, finishedAt: createdAt + 1000, output: '文件已生成。' },
    { id: 'plain-run', conversationId: 'artifact-conversation', input: '查询收入', modelKey: 'browser-test', status: 'completed', createdAt: createdAt + 2000, finishedAt: createdAt + 3000, output: '收入为 100 万元。' },
  ];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const respond = (body, status = 200, headers = {}) => route.fulfill({ status, headers, contentType: 'application/json; charset=utf-8', body: typeof body === 'string' ? body : JSON.stringify(body) });
    if (url.pathname === '/api/config') { await respond({ defaultModelKey: 'browser-test', models: [{ key: 'browser-test', displayName: 'Browser Test' }] }); return; }
    if (url.pathname === '/api/sample-questions') { await respond({ questions: [] }); return; }
    if (url.pathname === '/api/conversations') { await respond({ conversations: [{ id: 'artifact-conversation', title: '附件验证' }] }); return; }
    if (url.pathname === '/api/conversations/artifact-conversation') { await respond({ id: 'artifact-conversation', title: '附件验证', runs }); return; }
    if (url.pathname === '/api/runs/file-run') { await respond({ run: runs[0], humanLoop: null, events: [], artifacts: [{ id: 'artifact-1', name: '经营报告.xlsx', bytes: 4096, role: 'final' }] }); return; }
    if (url.pathname === '/api/runs/plain-run') { await respond({ run: runs[1], humanLoop: null, events: [], artifacts: [] }); return; }
    if (url.pathname === '/api/runs/file-run/artifacts/artifact-1/download') {
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename=report.xlsx; filename*=UTF-8''report.xlsx" }, body: 'xlsx-test' }); return;
    }
    await route.abort();
  });
  try {
    await page.goto(origin);
    await page.getByRole('button', { name: '附件验证' }).click();
    const fileRun = page.locator('[data-run-id="file-run"]');
    const plainRun = page.locator('[data-run-id="plain-run"]');
    await fileRun.locator('.answer-artifact').waitFor();
    assert.equal(await fileRun.locator('.answer-artifact').count(), 1);
    assert.match(await fileRun.locator('.answer-artifact').textContent(), /经营报告\.xlsx/);
    assert.equal(await plainRun.locator('.answer-artifact').count(), 0);
    const href = await fileRun.locator('.answer-artifact').getAttribute('href');
    assert.equal(href, '/api/runs/file-run/artifacts/artifact-1/download');
    let requestedDownload = false;
    await page.route('**/api/runs/file-run/artifacts/artifact-1/download', async route => {
      requestedDownload = true;
      await route.fulfill({ status: 204 });
    });
    await page.evaluate(path => fetch(path), href);
    assert.equal(requestedDownload, true);
    console.log('Artifact download browser check passed.');
  } finally { await page.close(); }
}

try {
  await verifyIncrementalTechnicalDetails();
  await verifyArtifactDownloads();
  if (process.env.DATA_AGENT_SKIP_LIVE_BROWSER === '1') {
    console.log('Mock browser checks passed; live database check skipped by DATA_AGENT_SKIP_LIVE_BROWSER.');
  } else {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
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
  await page.waitForSelector('.message.assistant.live .preview-execution-stream', { timeout: 30_000 });
  const liveCard = page.locator('.message.assistant.live .assistant-card');
  assert.equal(await liveCard.locator('.answer-content').count(), 0);
  assert.equal(await liveCard.locator('.live-answer').count(), 0);
  assert.equal(await liveCard.locator('.preview-execution-stream').evaluate(details => details.open), true);
  assert.equal((await liveCard.textContent()).includes('**Results'), false);
  await page.screenshot({ path: join(output, 'live-progress.png'), fullPage: true });
  const narrationTexts = new Map();
  let snapshot;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await liveCard.count()) {
      const narrations = await liveCard.locator('[data-narration-id]').evaluateAll(nodes => nodes.map(node => ({
        id: node.dataset.narrationId,
        text: node.querySelector('.preview-execution-narration__text')?.textContent || '',
      })));
      const visibleIds = new Set(narrations.map(narration => narration.id));
      for (const id of narrationTexts.keys()) assert.ok(visibleIds.has(id), `Narration ${id} disappeared while the Run was live`);
      for (const narration of narrations) {
        const prior = narrationTexts.get(narration.id);
        assert.ok(prior === undefined || narration.text.startsWith(prior), `Narration ${narration.id} replaced previously visible text`);
        assert.ok(narration.text.length <= 280, `Narration ${narration.id} is too long for the progress timeline`);
        assert.equal(/stdout|content_complete|query_plan|plan_verification|\bJSON\b|\bSQL\b/iu.test(narration.text), false, `Narration ${narration.id} exposed internal details`);
        narrationTexts.set(narration.id, narration.text);
      }
    }
    snapshot = await page.evaluate(async id => (await fetch(`/api/runs/${id}`)).json(), run.id);
    if (snapshot.run.status !== 'running' || snapshot.humanLoop) break;
    if (attempt % 10 === 0) console.log('Run progress:', snapshot.events.at(-1)?.type ?? 'pending');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  await page.screenshot({ path: join(output, 'conversation.png'), fullPage: true });
  await writeFile(join(output, 'live-run.json'), JSON.stringify(snapshot, null, 2));
  assert.equal(snapshot.run.status, 'completed', JSON.stringify({ status: snapshot.run.status, errorCode: snapshot.run.errorCode, hil: snapshot.humanLoop }));
  assert.ok(snapshot.run.output?.trim());
  await page.waitForFunction(() => {
    const details = document.querySelector('.message.assistant.final .preview-execution-stream');
    return details && !details.open;
  });
  assert.equal(await page.locator('.message.assistant.final .preview-execution-stream').evaluate(details => details.open), false);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.message').length >= 2);
  assert.equal(await page.locator('.message.user').count(), 1);
  assert.equal(await page.locator('.message.assistant.final .preview-execution-stream').evaluate(details => details.open), false);
  assert.equal(await page.locator('#notice').textContent(), '');
  assert.deepEqual(errors, []);
  console.log('Browser, mobile, live answer and reload checks passed. Screenshots:', output);
  }
} finally { await browser.close(); }
