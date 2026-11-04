import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createComposerPreferences } from '../web/composer-preferences.js';

// Run the actual app controller with a small DOM/transport fixture. Rendering
// dependencies are replaced; the sidebar, click handlers and state are real.
async function fixture(preferencesStorage = new Map()) {
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
  let confirmed = true; let failure; let clearCount = 0;
  const requests = []; const storage = new Map();
  const noop = () => {};
  const sandbox = {
    document: { getElementById: element, createElement(tag) { const node = new Element(); node.tag = tag; return node; }, querySelectorAll: () => [], addEventListener: noop, documentElement: { dataset: {} } },
    window: { confirm: () => confirmed }, crypto: { randomUUID },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    localStorage: { getItem: key => preferencesStorage.get(key), setItem: (key, value) => preferencesStorage.set(key, value) }, createComposerPreferences,
    createArtifactWorkspace: () => ({ render: noop, collapse: noop, activate: noop }),
    createConversationView: () => ({ clear() { clearCount++; }, render: noop }),
    installCapabilitySettings: noop, resetComposerInput: noop,
    async fetch(path, options) {
      requests.push({ path, ...options }); const url = new URL(path, 'http://fixture'); let data;
      if (url.pathname === '/api/session') data = { csrfToken: 'fixture-csrf', accountId: 'fixture', user: { email: 'test@example.test' } };
      else if (url.pathname === '/api/runtimes') data = { runtimes: [{ id: 'runtime-a', displayName: 'Runtime', status: 'ready' }] };
      else if (url.pathname === '/api/connectors') data = { connections: [{ id: 'mail', displayName: 'Mail', enabled: true, moduleAvailable: true }] };
      else if (url.pathname === '/api/models') data = { models: ['model-a', 'model-b'] };
      else if (url.pathname === '/api/conversations') data = { conversations: records };
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
