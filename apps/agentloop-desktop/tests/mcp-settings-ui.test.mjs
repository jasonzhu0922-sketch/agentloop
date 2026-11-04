import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function fixture(servers = [], probeResult = async () => ({ ok: true, toolCount: 2 })) {
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
  const tab = new Element(); tab.dataset.settingsTab = 'mcp'; const calls = [];
  const api = async (path, body) => { calls.push({ path, body }); if (body) return path === '/api/mcp/test' ? probeResult() : {}; if (path === '/api/mcp') return { servers }; throw Error(path); };
  const timers = new Map(); let timerId = 0;
  const sandbox = { setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); }, document: { createElement: () => new Element(), querySelectorAll: () => [tab] }, installModelSettings: () => ({ canLeave: () => true }), Node: Element, confirm: () => true };
  const install = runInNewContext(source.replace(/^import .*;\n/, '').replace('export function', 'function') + '\ninstallCapabilitySettings', sandbox);
  install({ api, element, refreshModels() {}, status() {}, currentRuntime() {}, refreshCapabilities() {} });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const click = async control => { control.onclick(); await settle(); };
  await click(tab);
  return { element, calls, click, settle, timers, body: element('capability-body') };
}
const saved = { id: 'server-1', displayName: '高德地图', key: 'amap-maps', transport: 'http', url: 'https://mcp.amap.com/mcp', auth: { kind: 'query_parameter', parameterName: 'key', credentialConfigured: true } };

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

test('editing JSON preserves identity and secrets, and unsaved edits block switching rows', async () => {
  const ui = await fixture([saved]); const [heading, list] = ui.body.children;
  await ui.click(list.children[0].children[1].children[1]);
  let editor = ui.body.children[2]; const json = editor.children[1].children[1];
  assert.equal(JSON.parse(json.value).auth.credentialConfigured, true);
  json.value = JSON.stringify({ ...saved, id: 'ignored', auth: { ...saved.auth, value: 'synthetic-key' }, aliases: ['保留“弯引号”'] }).replace('"value"', '“value”');
  ui.body.oninput(); await ui.click(heading.children[1]);
  assert.equal(ui.body.children[2], editor); assert.match(ui.element('capability-status').textContent, /未保存/);
  await ui.click(editor.children[3].children[1]);
  const post = ui.calls.find(c => c.body && c.path === '/api/mcp');
  assert.equal(post.body.server.id, saved.id); assert.equal(post.body.server.auth.value, 'synthetic-key');
  assert.equal('credentialConfigured' in post.body.server.auth, false); assert.equal(post.body.server.aliases[0], '保留“弯引号”');
  assert.equal(ui.body.children.length, 2, 'editor closes after save');
  await ui.click(ui.body.children[1].children[0].children[1].children[1]); editor = ui.body.children[2];
  assert.equal(editor.children[1].children[1].value.includes('synthetic-key'), false);
  editor.children[1].children[1].value = '{ “value”: }';
  await ui.click(editor.children[3].children[1]); assert.match(ui.element('capability-status').textContent, /JSON 格式无效/);
  await ui.click(editor.children[3].children[0]); assert.equal(ui.body.children.length, 2);
});

test('new entry and confirmed deletion operate on the intended service', async () => {
  const ui = await fixture([saved]);
  await ui.click(ui.body.children[0].children[1]);
  assert.equal(ui.body.children[2].children[0].children[0].children[0].textContent, '新增 MCP');
  await ui.click(ui.body.children[2].children[3].children[0]);
  await ui.click(ui.body.children[1].children[0].children[1].children[2]);
  assert.ok(ui.calls.some(c => c.path === '/api/mcp/server-1/remove'));
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
