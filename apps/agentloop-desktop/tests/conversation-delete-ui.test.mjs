import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createComposerPreferences } from '../web/composer-preferences.js';

// Run the actual app controller with a small DOM/transport fixture. Rendering
// dependencies are replaced; the sidebar, click handlers and state are real.
async function fixture(preferencesStorage = new Map(), running = false, runtimeCount = 2) {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  class Element {
    children = []; value = ''; hidden = false; disabled = false; textContent = ''; attributes = {};
    classList = { toggle() {} };
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    get firstChild() { return this.children[0]; }
    addEventListener(type, handler) { this[`on${type}`] = handler; }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelectorAll(tag) { return this.children.flatMap(child => [...((child.tag === tag || (tag === 'input:checked' && child.tag === 'input' && child.checked)) ? [child] : []), ...child.querySelectorAll(tag)]); }
  }
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let records = [{ id: 'first', title: '第一条会话' }, { id: 'second', title: '第二条会话' }];
  const runtimeRows = Array.from({ length: runtimeCount }, (_, index) => ({ id: `runtime-${String.fromCharCode(97 + index)}`, displayName: `Runtime ${String.fromCharCode(65 + index)}`, status: 'ready' }));
  let confirmed = true; let failure; let clearCount = 0;
  const requests = []; const storage = new Map();
  const noop = () => {};
  const sandbox = {
    document: { getElementById: element, createElement(tag) { const node = new Element(); node.tag = tag; return node; }, querySelectorAll: () => [], addEventListener: noop, documentElement: { dataset: {} } },
    window: { confirm: () => confirmed }, crypto: { randomUUID }, btoa: value => Buffer.from(value, 'binary').toString('base64'),
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    localStorage: { getItem: key => preferencesStorage.get(key), setItem: (key, value) => preferencesStorage.set(key, value) }, createComposerPreferences,
    createArtifactWorkspace: () => ({ render: noop, collapse: noop, activate: noop }),
    createConversationView: () => ({ clear() { clearCount++; }, render: noop, submitting: noop, submitted: noop }),
    createTurn: run => ({ ...run, events: [], lastSeq: 0 }),
    updateTurn: (turn, run) => Object.assign(turn, run),
    readRunUpdate: () => new Promise(() => {}),
    installCapabilitySettings: noop, resetComposerInput: noop,
    async fetch(path, options) {
      requests.push({ path, ...options }); const url = new URL(path, 'http://fixture'); let data;
      if (url.pathname === '/api/session') data = { csrfToken: 'fixture-csrf', accountId: 'fixture', user: { email: 'test@example.test' } };
      else if (url.pathname === '/api/runtimes') data = { runtimes: runtimeRows };
      else if (url.pathname === '/api/connectors') data = { connections: [{ id: 'mail', displayName: 'Mail', enabled: true, moduleAvailable: true }] };
      else if (url.pathname === '/api/models') data = { models: ['model-a', 'model-b'] };
      else if (url.pathname === '/api/sources' && options.method === 'POST') data = { source: { id: 'source-note', originalName: 'note.txt' } };
      else if (url.pathname === '/api/conversations') data = { conversations: records };
      else if (running && url.pathname === '/api/runs' && options.method === 'POST') {
        const payload = JSON.parse(options.body);
        data = { run: { id: 'run-new', status: 'running', conversationId: payload.conversationId } };
      }
      else if (running && url.pathname === '/api/conversations/first') data = { runs: [{ id: 'run-first', status: 'running', conversationId: 'first' }] };
      else if (running && url.pathname === '/api/runs/run-first/events') data = { events: [] };
      else if (running && url.pathname === '/api/runs/run-first/artifacts') data = { artifacts: [] };
      else if (running && url.pathname === '/api/runs/run-first/human-loop/current') data = {};
      else if (url.pathname.endsWith('/remove')) {
        if (failure) return { ok: false, status: failure, json: async () => ({ error: 'fixture_failure' }) };
        records = records.filter(item => item.id !== url.pathname.split('/')[3]); data = { removed: true };
      } else data = { runs: [] };
      return { ok: true, status: 200, json: async () => data };
    },
  };
  await runInNewContext(`(async () => { ${source.replace(/^import .*;\n/gm, '')} })()`, sandbox);
  return { element, requests, storage, rows: () => element('conversations').children,
    confirm: value => { confirmed = value; }, fail: value => { failure = value; }, clears: () => clearCount };
}

test('sidebar conversations use a dot and highlight the selected conversation', async () => {
  const ui = await fixture();
  assert.equal(ui.rows()[0].children[0].children[0].className, 'session-dot');
  assert.equal(ui.rows()[0].children[0].children[0].tag, 'span');
  await ui.rows()[0].children[0].onclick();
  assert.match(ui.rows()[0].children[0].className, /\bactive\b/);
  assert.equal(ui.rows()[0].children[0].children[0].className, 'session-dot');
});

test('sidebar deletion cancellation and failure preserve the selected conversation and draft', async () => {
  const ui = await fixture(); await ui.rows()[0].children[0].onclick();
  ui.element('message').value = '未发送草稿';
  ui.confirm(false); await ui.rows()[0].children[1].onclick();
  assert.equal(ui.requests.filter(item => item.path.includes('/remove')).length, 0);
  ui.confirm(true); ui.fail(409); await ui.rows()[0].children[1].onclick();
  assert.equal(ui.rows().length, 2); assert.equal(ui.element('message').value, '未发送草稿');
  assert.equal(ui.element('conversation-title').textContent, '第一条会话');
  assert.match(ui.element('status').textContent, /任务执行中/);
  assert.equal(ui.element('send').disabled, false);
});

test('a running conversation permits navigation and reconnects when selected again', async () => {
  const ui = await fixture(new Map(), true);
  await ui.rows()[0].children[0].onclick();
  assert.equal(ui.element('message').disabled, true);
  assert.equal(ui.element('cancel').hidden, false);
  assert.equal(ui.element('new-conversation').disabled, false);
  assert.equal(ui.rows()[1].children[0].disabled, false);
  await ui.rows()[1].children[0].onclick();
  assert.equal(ui.element('message').disabled, false);
  assert.equal(ui.element('cancel').hidden, true);
  await ui.rows()[0].children[0].onclick();
  assert.equal(ui.element('message').disabled, true);
  assert.equal(ui.element('cancel').hidden, false);
  ui.element('new-conversation').onclick();
  assert.equal(ui.element('message').disabled, false);
  assert.equal(ui.element('cancel').hidden, true);
  assert.equal(ui.requests.filter(request => request.path.startsWith('/api/conversations/first?')).length, 2);
});

test('clicking a robot removes an empty conversation and starts the selected Runtime', async () => {
  const ui = await fixture();
  const initialConversation = ui.element('conversation-title').textContent;
  await ui.rows()[0].children[0].onclick();
  assert.doesNotMatch(ui.element('runtime-robots').className, /runtime-arc/);
  const robots = ui.element('runtime-robots').querySelectorAll('button');
  robots[1].onclick(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ui.rows().length, 1);
  assert.equal(ui.rows().length, 1);
  assert.notEqual(ui.element('conversation-title').textContent, initialConversation);
  assert.equal(ui.element('status').textContent, '');
  assert.equal(ui.element('runtime-select').value, 'runtime-b');
  assert.equal(ui.requests.filter(request => request.path.includes('/remove')).length, 1);
});

test('more than three Runtimes use the compact arc launcher', async () => {
  const ui = await fixture(new Map(), false, 4);
  assert.match(ui.element('runtime-robots').className, /runtime-arc/);
  assert.equal(ui.element('runtime-robots').querySelectorAll('button').length, 5);
});

test('uploading an attachment binds the new conversation to its runtime', async () => {
  const ui = await fixture();
  const fileInput = ui.element('file');
  fileInput.files = [{ size: 1, name: 'note.txt', async arrayBuffer() { return new Uint8Array([65]).buffer; } }];
  await fileInput.onchange({ target: fileInput });
  assert.equal(ui.element('runtime-select').disabled, true);
});

test('a new conversation can start a run while another conversation is running', async () => {
  const ui = await fixture(new Map(), true);
  await ui.rows()[0].children[0].onclick();
  ui.element('new-conversation').onclick();
  ui.element('model').value = 'model-a'; ui.element('message').value = '并行任务';
  void ui.element('composer').onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  const request = ui.requests.find(item => item.path.startsWith('/api/runs?') && item.method === 'POST');
  assert.ok(request);
  assert.notEqual(JSON.parse(request.body).conversationId, 'first');
  assert.equal(ui.element('message').disabled, true);
  await ui.rows()[0].children[0].onclick();
  assert.equal(ui.element('cancel').hidden, false);
});

test('deleting another conversation preserves current state; deleting the active one clears it', async () => {
  const ui = await fixture(); await ui.rows()[0].children[0].onclick();
  ui.element('message').value = '未发送草稿'; const clears = ui.clears();
  await ui.rows()[1].children[1].onclick();
  assert.equal(ui.rows().length, 1); assert.equal(ui.clears(), clears);
  assert.equal(ui.element('conversation-title').textContent, '第一条会话');
  assert.equal(ui.element('message').value, '未发送草稿');
  ui.storage.set('agentloop-desktop-pending:fixture', 'pending request');
  await ui.rows()[0].children[1].onclick();
  assert.equal(ui.rows().length, 0); assert.equal(ui.clears(), clears + 1);
  assert.equal(ui.element('conversation-title').textContent, '新对话');
  assert.equal(ui.element('message').value, ''); assert.equal(ui.element('empty-state').hidden, false);
  assert.equal(ui.element('details').hidden, true); assert.equal(ui.storage.size, 0);
  const request = ui.requests.find(item => item.path.includes('/remove'));
  assert.equal(request.path, '/api/conversations/second/remove?runtimeId=runtime-a');
  assert.equal(request.method, 'POST'); assert.equal(request.headers['X-Desktop-CSRF'], 'fixture-csrf');
});


test('composer restores conversation connectors after reload and keeps the chosen model across sessions', async () => {
  const preferences = new Map();
  const ui = await fixture(preferences);
  await ui.rows()[0].children[0].onclick();
  const connector = ui.element('run-connectors').querySelectorAll('input')[0];
  connector.checked = true; ui.element('run-connectors').onchange();
  ui.element('model').value = 'model-a'; ui.element('model').onchange();
  await ui.rows()[1].children[0].onclick();
  assert.equal(connector.checked, false);
  assert.equal(ui.element('model').value, 'model-a');
  ui.element('new-conversation').onclick();
  assert.equal(ui.element('model').value, 'model-a');
  const reloaded = await fixture(preferences);
  assert.equal(reloaded.element('model').value, 'model-a');
  await reloaded.rows()[0].children[0].onclick();
  assert.equal(reloaded.element('run-connectors').querySelectorAll('input')[0].checked, true);
  await reloaded.rows()[1].children[0].onclick();
  assert.equal(reloaded.element('run-connectors').querySelectorAll('input')[0].checked, false);
});
