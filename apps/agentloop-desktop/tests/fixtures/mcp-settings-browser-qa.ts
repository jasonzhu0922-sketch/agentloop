import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startDesktop } from '../../src/application.ts';
import { fixtureAuth } from './auth.ts';
import { modelPort } from '../../../../packages/agentloop-local-runtime/tests/fixtures/models.ts';

// Real Desktop, encrypted persistence and HTTP MCP loader; temporary data and
// synthetic credentials only. Each endpoint represents one authentication mode.
const root = await mkdtemp(join(tmpdir(), 'agentloop-mcp-browser-'));
const output = process.argv[2] ?? process.env.MCP_SETTINGS_QA_OUTPUT ?? root;
await mkdir(output, { recursive: true }); await mkdir(join(root, 'skills'));
const received: Array<{ path: string; method: string; protocol?: string }> = [];
const upstream = createServer((req, res) => { void (async () => {
  const url = new URL(req.url!, 'http://localhost');
  const authenticated = url.pathname.startsWith('/ontology')
    ? req.headers['x-api-key'] === 'synthetic-ontology-key'
    : url.searchParams.get('key') === 'synthetic-map-key';
  if (!authenticated) { res.writeHead(401); res.end(); return; }
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const message = JSON.parse(Buffer.concat(chunks).toString());
  received.push({ path: url.pathname, method: message.method, protocol: message.params?.protocolVersion });
  if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
  const result = message.method === 'tools/list' ? { tools: [{ name: url.pathname.startsWith('/ontology') ? 'call_rdb_sql_api_query' : 'maps_direction_driving', description: 'QA read tool', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
    : { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
})().catch(() => { res.writeHead(500); res.end(); }); });
await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
const address = upstream.address(); assert.ok(address && typeof address !== 'string');
const endpoint = `http://127.0.0.1:${address.port}`;
const app = await startDesktop({ mode: 'development', port: 0, dataDirectory: join(root, 'data'), models: modelPort(), cloudAuth: fixtureAuth(), bundledSkillDirectories: [join(root, 'skills')], openBrowser: false });
assert.equal(app.existing, false);
let browser;
try {
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const login = await context.request.post(app.origin + '/api/auth/login', { headers: { Origin: app.origin }, data: { email: 'test@example.test', password: 'fixture-only' } });
  assert.equal(login.status(), 200);
  const page = await context.newPage(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.origin); await page.locator('#message:not([disabled])').waitFor();
  await page.locator('#model-settings-open').click(); await page.locator('[data-settings-tab="mcp"]').click();
  const field = (name: string) => page.locator(`[data-mcp-field="${name}"]`);
  const click = (name: string) => page.getByRole('button', { name, exact: true }).click();
  const saved = () => page.locator('#capability-status').filter({ hasText: 'MCP 已保存' }).waitFor();
  const catalog = async () => (await (await context.request.get(app.origin + '/api/mcp')).json()).servers;

  await click('＋ 新增 MCP');
  await field('displayName').fill('ontoflow-jtbc'); await field('key').fill('ontoflow-jtbc');
  await field('url').fill(endpoint + '/ontology/mcp'); await field('timeoutMs').fill('30000');
  await field('auth.kind').selectOption('custom_headers'); await field('auth.headerName').fill('X-API-Key');
  await field('auth.headerValue').fill('synthetic-ontology-key');
  await page.locator('summary').filter({ hasText: '高级配置与工具访问' }).click();
  await field('protocolVersion').fill('2024-11-05'); await field('trust').selectOption('untrusted');
  await field('toolAllowlist').fill('call_rdb_sql_api_query'); await field('aliases').fill('数智域数据资产\nODS 建模\nontoflow-jtbc');
  await page.locator('summary').filter({ hasText: '能力声明' }).click(); await click('＋ 添加能力');
  await field('capability.id').fill('data_asset.ods_read'); await field('capability.category').fill('data_asset');
  await field('capability.label').fill('ODS metadata and sample reads');
  await field('capability.description').fill('Read approved DB2 ODS metadata and samples through the OntoFlow JTBC source.');
  await field('capability.producesEvidenceKinds').fill('source_summary\nschema_summary\nrecord_counts\nexplicit_caveats');
  await field('capability.sourceKinds').fill('database');
  await click('测试连接'); await page.locator('#capability-status').filter({ hasText: '连接成功' }).waitFor();
  assert.equal((await catalog()).length, 0, 'probe must not persist a draft');
  assert.ok(received.some(call => call.path === '/ontology/mcp' && call.protocol === '2024-11-05'));
  await click('保存 MCP'); await saved();
  const ontology = (await catalog())[0];
  assert.equal(ontology.auth.credentialConfigured, true); assert.deepEqual(ontology.toolAllowlist, ['call_rdb_sql_api_query']);
  assert.deepEqual(ontology.capabilities[0].producesEvidenceKinds, ['source_summary', 'schema_summary', 'record_counts', 'explicit_caveats']);
  assert.equal(JSON.stringify(ontology).includes('synthetic-ontology-key'), false);
  await page.getByRole('button', { name: '编辑 ontoflow-jtbc', exact: true }).click();
  assert.equal(await field('auth.headerValue').inputValue(), '');
  await field('displayName').fill('数智域数据资产'); await click('保存 MCP'); await saved();
  await page.getByRole('button', { name: '探测 数智域数据资产', exact: true }).click();
  await page.locator('.mcp-probe-status.success').waitFor();
  await page.getByRole('button', { name: '编辑 数智域数据资产', exact: true }).click();
  await page.locator('summary').filter({ hasText: '高级配置与工具访问' }).click();
  await page.locator('summary').filter({ hasText: '能力声明' }).click();
  await field('displayName').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'mcp-ontology-desktop.png'), fullPage: true });
  await field('capability.sourceKinds').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'mcp-capabilities-desktop.png'), fullPage: true });
  await click('取消'); await click('＋ 新增 MCP');
  await field('displayName').fill('高德地图'); await field('key').fill('amap-maps'); await field('url').fill(endpoint + '/amap/mcp');
  await field('timeoutMs').fill('15000'); await field('auth.kind').selectOption('query_parameter');
  await field('auth.parameterName').fill('key'); await field('auth.value').fill('synthetic-map-key');
  await click('JSON 配置'); const draft = JSON.parse(await field('json').inputValue());
  draft.trust = 'trusted'; draft.aliases = ['高德', '高德MCP', 'amap', '高德地图', '高德地图 MCP'];
  draft.capabilities = [{ id: 'spatial_planning.route', category: 'spatial_planning', label: 'Route planning', description: 'Plan routes and travel options using this map source.' }];
  await field('json').fill(JSON.stringify(draft, null, 2)); await click('表单配置');
  assert.equal(await field('auth.value').inputValue(), 'synthetic-map-key');
  await click('测试连接'); await page.locator('#capability-status').filter({ hasText: '连接成功' }).waitFor();
  assert.equal((await catalog()).length, 1);
  await click('保存 MCP'); await saved();
  const amap = (await catalog()).find((server: any) => server.key === 'amap-maps');
  assert.equal(amap.auth.credentialConfigured, true); assert.equal(amap.trust, 'trusted'); assert.equal(amap.aliases.length, 5);
  assert.equal(JSON.stringify(amap).includes('synthetic-map-key'), false);
  await page.getByRole('button', { name: '编辑 高德地图', exact: true }).click();
  assert.equal(await field('auth.value').inputValue(), '');
  await field('displayName').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'mcp-amap-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  await field('displayName').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator('.mcp-editor').evaluate(node => node.scrollWidth > node.clientWidth), false);
  await page.screenshot({ path: join(output, 'mcp-amap-mobile.png'), fullPage: true });
  // The server enforces that saved credentials cannot move to another endpoint.
  await field('url').fill(endpoint + '/amap/other'); await click('保存 MCP');
  await page.locator('#capability-status').filter({ hasText: '缺少凭据' }).waitFor();
  assert.equal((await catalog()).find((server: any) => server.key === 'amap-maps').url, endpoint + '/amap/mcp');
  await click('取消');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.reload(); await page.locator('#message:not([disabled])').waitFor();
  await page.locator('#model-settings-open').click(); await page.locator('[data-settings-tab="mcp"]').click();
  await page.locator('.mcp-server-row').first().waitFor();
  assert.equal(await page.locator('.mcp-server-row').count(), 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ output, serverCount: 2, authenticatedRequests: received.length, browserErrors: errors }));
} finally {
  await browser?.close(); await app.close(); await new Promise<void>(resolve => upstream.close(() => resolve()));
}
