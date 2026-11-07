import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

for (const [name, file, end, key] of [
  ['Desktop', new URL('../web/app.js', import.meta.url), "element('logout').onclick", 'agentloop.desktop.theme.v1'],
  ['Multi Runtime', new URL('../../agentloop-multi-runtime/web/client/app.js', import.meta.url), '$("new-chat").addEventListener', 'agentloop.multi-runtime.theme.v1'],
]) {
  test(`${name} cycles three themes and restores the chosen theme`, () => {
    const source = readFileSync(file, 'utf8');
    const start = source.indexOf('const themeButton = ');
    const finish = source.indexOf(end, start);
    assert.ok(start >= 0 && finish > start);
    const storage = new Map();
    function load() {
      const button = { setAttribute(name, value) { this[name] = value; }, addEventListener(_event, handler) { this.click = handler; } };
      const document = { documentElement: { dataset: {} } };
      const localStorage = { getItem: name => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value) };
      runInNewContext(source.slice(start, finish), { element: () => button, $: () => button, document, localStorage });
      return { button, document };
    }
    const first = load();
    assert.equal(first.document.documentElement.dataset.theme, 'purple');
    first.button.click();
    assert.equal(first.document.documentElement.dataset.theme, 'light');
    first.button.click();
    assert.equal(first.document.documentElement.dataset.theme, 'dark');
    first.button.click();
    assert.equal(first.document.documentElement.dataset.theme, 'purple');
    assert.match(first.button['aria-label'], /智慧紫/);
    assert.equal(storage.get(key), 'purple');
    const reloaded = load();
    assert.equal(reloaded.document.documentElement.dataset.theme, 'purple');
    reloaded.button.click();
    assert.equal(reloaded.document.documentElement.dataset.theme, 'light');
    assert.equal(load().document.documentElement.dataset.theme, 'light');
    storage.set(key, 'invalid');
    assert.equal(load().document.documentElement.dataset.theme, 'purple');
  });
}
