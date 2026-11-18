import { createMcpServerForm } from '../web/mcp-settings-form.js';
import { connectorCredentialMessages, connectorCredentialStatus } from '../web/connector-status.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function fixture(servers = [], probeResult = async () => ({ ok: true, toolCount: 2 }), connectorFixture) {
  const source = await readFile(new URL('../web/capability-settings.js', import.meta.url), 'utf8');
  class Element {
    children = []; dataset = {}; textContent = ''; value = ''; className = ''; parent = null; attrs = {}; classList = { toggle() {}, add() {} };
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
    replaceChildren(...items) { this.children = []; this.append(...items); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    addEventListener(name, fn) { this[`on${name}`] = fn; } setAttribute(name, value) { this.attrs[name] = value; }
    querySelector() { return null; } querySelectorAll() { return []; } focus() {}
  }
  const elements = new Map(); const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const tab = new Element(); tab.dataset.settingsTab = connectorFixture ? 'connectors' : 'mcp'; const calls = [];
  const api = async (path, body) => { calls.push({ path, body }); if (body) return path === '/api/mcp/test' ? probeResult() : {}; if (path === '/api/mcp') return { servers }; if (path === '/api/runtimes') return { runtimes: [] }; if (path === '/api/skills') return { skills: [] }; if (path === '/api/connectors/catalog') return { connectors: [{ key: '126-mail', displayName: '126 邮箱', capabilities: [] }] }; if (path === '/api/connectors') return { connections: connectorFixture }; throw Error(path); };
  const timers = new Map(); let timerId = 0;
  const sandbox = { createMcpServerForm, connectorCredentialMessages, connectorCredentialStatus, setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); }, document: { createElement: () => new Element(), querySelectorAll: () => [tab] }, installModelSettings: () => ({ canLeave: () => true }), Node: Element, confirm: () => true };
  const install = runInNewContext(source.replace(/^import .*;\n/gm, '').replace('export function', 'function') + '\ninstallCapabilitySettings', sandbox);
  install({ api, element, refreshModels() {}, status() {}, currentRuntime() {}, refreshCapabilities() {} });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const click = async control => { control.onclick(); await settle(); };
  await click(tab);
  return { element, calls, click, settle, timers, body: element('capability-body') };
}
const saved = { id: 'server-1', displayName: '高德地图', key: 'amap-maps', transport: 'http', url: 'https://mcp.amap.com/mcp', auth: { kind: 'query_parameter', parameterName: 'key', credentialConfigured: true } };

test('Connector settings preserve catalog and account actions when a credential key is missing', async () => {
  const ui = await fixture([], undefined, [{ id: 'mail', connectorKey: '126-mail', displayName: '我的邮箱', enabled: true, moduleAvailable: true, credentialConfigured: false, unavailableReason: 'connector_credential_key_missing' }]);
  const card = ui.body.children.find(child => child.className === 'connector-existing-card');
  assert.ok(card);
  assert.equal(card.children[0].children[0].textContent, '我的邮箱');
  assert.deepEqual(card.children[0].children[1].children.map(c => c.textContent), ['编辑', '删除']);
  assert.match(card.children[1].textContent, /加密主密钥缺失.*恢复原密钥/);
  assert.equal(ui.body.children[1].children[0].children[0].children[0].textContent, '126 邮箱');
  assert.doesNotMatch(ui.element('capability-status').textContent, /读取失败/);
});

test('MCP catalog shows rows and row actions, and probes saved credentials without runtime selection', async () => {
  const ui = await fixture([saved, { ...saved, id: 'server-2', displayName: '第二个服务', key: 'second' }]);
  const [heading, list] = ui.body.children;
  assert.equal(heading.children[1].textContent, '＋ 新增 MCP');
  assert.equal(list.children.length, 2);
  assert.deepEqual(list.children[0].children[1].children.map(c => c.textContent), ['探测', '编辑', '删除']);
  assert.equal(ui.body.children.length, 2, 'no editor until requested');
  assert.deepEqual(ui.calls.map(c => c.path), ['/api/mcp']);
  await ui.click(list.children[0].children[1].children[0]);
  assert.equal(ui.calls[1].path, '/api/mcp/test'); assert.equal(ui.calls[1].body.server.id, saved.id);
  assert.equal('credentialConfigured' in ui.calls[1].body.server.auth, false);
  assert.match(list.children[0].children[0].children[3].textContent, /连接成功.*2/);
  assert.equal(list.children[1].children[0].children[3].hidden, true);
});

function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function findField(ui, key) { return descendants(ui.body).find(node => node.dataset.mcpField === key); }
function findButton(ui, text) { return descendants(ui.body).find(node => node.textContent === text && node.onclick); }
const posted = ui => { const value = ui.calls.find(call => call.path === '/api/mcp' && call.body)?.body.server; return value === undefined ? value : JSON.parse(JSON.stringify(value)); };
const ontology = {
  id: 'ontology-1', displayName: 'ontoflow-jtbc', key: 'ontoflow-jtbc', transport: 'http', url: 'http://10.82.75.22:8082/mcp',
  protocolVersion: '2024-11-05', timeoutMs: 30000, auth: { kind: 'custom_headers', headerNames: ['X-API-Key'], credentialConfigured: true },
  toolAllowlist: ['call_rdb_sql_api_query'], trust: 'untrusted', aliases: ['数智域数据资产', 'ODS 建模', 'ontoflow-jtbc'],
  capabilities: [{ id: 'data_asset.ods_read', category: 'data_asset', label: 'ODS metadata and sample reads', description: 'Read approved DB2 ODS metadata and samples through the OntoFlow JTBC source.', producesEvidenceKinds: ['source_summary', 'schema_summary', 'record_counts', 'explicit_caveats'], sourceKinds: ['database'] }],
};
const amap = { ...saved, timeoutMs: 15000, trust: 'trusted', aliases: ['高德', '高德MCP', 'amap', '高德地图', '高德地图 MCP'], capabilities: [{ id: 'spatial_planning.route', category: 'spatial_planning', label: 'Route planning', description: 'Plan routes and travel options using this map source.' }] };

test('OntoFlow fields round trip without losing tool policy, capability evidence, identity or saved credentials', async () => {
  const ui = await fixture([ontology]);
  await ui.click(findButton(ui, '编辑'));
  assert.equal(findField(ui, 'auth.headerName').value, 'X-API-Key');
  assert.equal(findField(ui, 'auth.headerValue').value, '');
  assert.equal(findField(ui, 'protocolVersion').value, '2024-11-05');
  assert.equal(findField(ui, 'toolAllowlist').value, 'call_rdb_sql_api_query');
  assert.equal(findField(ui, 'capability.sourceKinds').value, 'database');
  assert.equal(findField(ui, 'capability.producesEvidenceKinds').value.split('\n').length, 4);
  findField(ui, 'displayName').value = '数智域数据资产'; ui.body.oninput();
  await ui.click(findButton(ui, '＋ 新增 MCP'));
  assert.match(ui.element('capability-status').textContent, /未保存/);
  await ui.click(findButton(ui, '保存 MCP'));
  const expected = { ...ontology, displayName: '数智域数据资产', auth: { kind: 'custom_headers', headerNames: ['X-API-Key'] } };
  assert.deepEqual(posted(ui), expected);
  assert.equal(ui.body.children.length, 2);
});

test('Amap query credentials and aliases survive form/JSON switching and draft testing never saves', async () => {
  const ui = await fixture([amap]); await ui.click(findButton(ui, '编辑'));
  assert.equal(findField(ui, 'auth.kind').value, 'query_parameter');
  assert.equal(findField(ui, 'auth.parameterName').value, 'key');
  findField(ui, 'auth.value').value = 'synthetic-map-key';
  await ui.click(findButton(ui, 'JSON 配置'));
  assert.equal(JSON.parse(findField(ui, 'json').value).auth.value, 'synthetic-map-key');
  assert.equal('credentialConfigured' in JSON.parse(findField(ui, 'json').value).auth, false);
  await ui.click(findButton(ui, '表单配置'));
  assert.equal(findField(ui, 'auth.value').value, 'synthetic-map-key');
  await ui.click(findButton(ui, '测试连接'));
  assert.equal(ui.calls.filter(call => call.path === '/api/mcp' && call.body).length, 0);
  const probe = ui.calls.find(call => call.path === '/api/mcp/test');
  assert.equal(probe.body.server.id, saved.id);
  assert.match(ui.element('capability-status').textContent, /尚未保存/);
  await ui.click(findButton(ui, '保存 MCP'));
  assert.deepEqual(posted(ui), { ...amap, auth: { kind: 'query_parameter', parameterName: 'key', value: 'synthetic-map-key' } });
});

test('JSON import handles smart delimiters, keeps saved identity, and rejects invalid or unsupported input', async () => {
  const ui = await fixture([saved]); await ui.click(findButton(ui, '编辑')); await ui.click(findButton(ui, 'JSON 配置'));
  const json = findField(ui, 'json');
  json.value = '{ “value”: }';
  await ui.click(findButton(ui, '保存 MCP'));
  assert.equal(posted(ui), undefined);
  assert.match(descendants(ui.body).find(node => node.className === 'mcp-form-feedback').textContent, /JSON 格式无效/);
  json.value = JSON.stringify({ ...saved, auth: { ...saved.auth }, extensions: { retained: true } });
  await ui.click(findButton(ui, '表单配置'));
  assert.match(descendants(ui.body).find(node => node.className === 'mcp-form-feedback').textContent, /不支持/);
  assert.equal(json.parent.parent.hidden, false, 'invalid JSON remains visible');
  json.value = JSON.stringify({ ...saved, id: 'ignored', auth: { ...saved.auth, value: 'synthetic-key' }, aliases: ['保留“弯引号”'] }).replace('"value"', '“value”');
  await ui.click(findButton(ui, '保存 MCP'));
  assert.equal(posted(ui).id, saved.id);
  assert.equal(posted(ui).auth.value, 'synthetic-key');
  assert.deepEqual(posted(ui).aliases, ['保留“弯引号”']);
  await ui.click(findButton(ui, '编辑')); await ui.click(findButton(ui, 'JSON 配置'));
  assert.equal(findField(ui, 'json').value.includes('synthetic-key'), false);
});

test('new service form imports full OntoFlow config and does not accept a forged identity', async () => {
  const ui = await fixture(); await ui.click(findButton(ui, '＋ 新增 MCP'));
  assert.equal(findField(ui, 'displayName').value, '');
  await ui.click(findButton(ui, 'JSON 配置'));
  findField(ui, 'json').value = JSON.stringify({ ...ontology, auth: { kind: 'custom_headers', headers: { 'X-API-Key': 'synthetic-ontology-key' } } });
  await ui.click(findButton(ui, '表单配置'));
  assert.equal(findField(ui, 'auth.headerValue').value, 'synthetic-ontology-key');
  await ui.click(findButton(ui, '保存 MCP'));
  assert.equal('id' in posted(ui), false);
  assert.deepEqual(posted(ui).auth, { kind: 'custom_headers', headerNames: ['X-API-Key'], headers: { 'X-API-Key': 'synthetic-ontology-key' } });
});

test('partial header replacement cannot silently erase another saved credential', async () => {
  const ui = await fixture([{ ...ontology, auth: { kind: 'custom_headers', headerNames: ['X-API-Key', 'X-Tenant-Key'], credentialConfigured: true } }]);
  await ui.click(findButton(ui, '编辑')); findField(ui, 'auth.headerValue').value = 'synthetic-new-key';
  await ui.click(findButton(ui, '保存 MCP'));
  assert.equal(posted(ui), undefined);
  assert.match(descendants(ui.body).find(node => node.className === 'mcp-form-feedback').textContent, /所有请求头/);
});

test('new entry cancellation and confirmed deletion operate on the intended service', async () => {
  const ui = await fixture([saved]); await ui.click(findButton(ui, '＋ 新增 MCP'));
  await ui.click(findButton(ui, '取消')); assert.equal(ui.body.children.length, 2);
  await ui.click(findButton(ui, '删除')); assert.ok(ui.calls.some(c => c.path === '/api/mcp/server-1/remove'));
});

test('probe shows immediate progress, reports failures in the right row, and clears stale results', async () => {
  let finish; const responses = [];
  const ui = await fixture([saved, { ...saved, id: 'server-2', displayName: '第二个服务', key: 'second' }], () => new Promise((resolve, reject) => { finish = { resolve, reject }; responses.push(finish); }));
  const rows = ui.body.children[1].children; const status = rows[0].children[0].children[3]; const button = rows[0].children[1].children[0];
  button.onclick();
  assert.equal(status.hidden, false); assert.equal(status.textContent, '正在探测连接…'); assert.equal(button.textContent, '探测中…');
  finish.resolve({ ok: true, toolCount: 15 }); await ui.settle();
  assert.match(status.textContent, /连接成功.*15/); assert.equal(button.textContent, '探测');
  button.onclick(); assert.equal(status.textContent, '正在探测连接…');
  finish.resolve({ ok: false, toolCount: 0 }); await ui.settle(); assert.match(status.textContent, /连接失败/);
  button.onclick(); finish.reject(new Error('sensitive diagnostic text')); await ui.settle();
  assert.match(status.textContent, /探测未完成/); assert.doesNotMatch(status.textContent, /sensitive/);
  assert.equal(rows[1].children[0].children[3].hidden, true);
});

test('probe results expire after ten seconds, and a new probe cancels the old timer', async () => {
  let finish;
  const ui = await fixture([saved], () => new Promise(resolve => { finish = resolve; }));
  const row = ui.body.children[1].children[0], status = row.children[0].children[3], probe = row.children[1].children[0];
  probe.onclick(); finish({ ok: true, toolCount: 1 }); await ui.settle();
  assert.equal(status.hidden, false); assert.equal([...ui.timers.values()][0].delay, 10000);
  const previous = [...ui.timers.values()][0];
  probe.onclick(); assert.equal(ui.timers.size, 0); assert.equal(status.textContent, '正在探测连接…');
  finish({ ok: false }); await ui.settle();
  assert.equal(ui.timers.size, 1); assert.notEqual([...ui.timers.values()][0], previous);
  assert.match(status.textContent, /连接失败/); [...ui.timers.values()][0].fn(); assert.equal(status.hidden, true);
});
