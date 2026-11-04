import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../web/artifact-workspace.js', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'shared-preview', setup(builder) {
  builder.onResolve({ filter: /^\.\/markdown\.js$/ }, () => ({ path: fileURLToPath(new URL('../../../packages/agentloop-artifact-preview/src/index.ts', import.meta.url)) }));
} }] });
const { createArtifactWorkspace } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

// Minimal host DOM: the real shared renderer and selection controller run here.
// Browser layout, HTML sandbox and downloads are covered by browser QA.
class Element {
  hidden = false; children = []; attributes = new Map(); markup = ''; writes = 0;
  classList = { values: new Set(), remove: value => this.classList.values.delete(value),
    toggle: (value, force) => { const active = force ?? !this.classList.values.has(value); if (active) this.classList.values.add(value); else this.classList.values.delete(value); return active; } };
  set innerHTML(value) { this.markup = value; this.writes++; }
  get innerHTML() { return this.markup; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.markup = ''; }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const artifact = (id, mimeType = 'text/markdown') => ({ id, name: `${id}.md`, mimeType, bytes: 20, role: 'final' });
const turn = (id, artifacts) => ({ id, artifacts, status: 'completed' });

test('workspace rejects stale reads across file, Run and Runtime switches and releases media URLs', async t => {
  const originalDocument = globalThis.document; const originalWindow = globalThis.window; const originalFetch = globalThis.fetch;
  const revoke = URL.revokeObjectURL; const revoked = [];
  const nodes = new Map(); const element = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  globalThis.document = { createElement: () => new Element() };
  globalThis.window = { addEventListener() {} };
  URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
  t.after(() => { globalThis.document = originalDocument; globalThis.window = originalWindow; globalThis.fetch = originalFetch; URL.revokeObjectURL = revoke; });
  element('details').hidden = true;
  let pending = deferred(); const requests = [];
  const workspace = createArtifactWorkspace({ element, api: path => { requests.push(path); return pending.promise; }, onOpen: () => { element('details').hidden = false; } });
  const first = turn('run A', [artifact('one'), artifact('two')]); workspace.render(first, 'runtime A');
  const oldRead = pending; const firstSelect = workspace.select('one');
  assert.match(element('artifact-download').href, /run%20A\/artifacts\/one\/download\?runtimeId=runtime%20A$/);
  pending = deferred(); const secondSelect = workspace.select('two');
  pending.resolve({ kind: 'text', name: 'two.md', mimeType: 'text/markdown', text: '# latest', truncated: false }); await secondSelect;
  oldRead.resolve({ kind: 'text', name: 'one.md', mimeType: 'text/markdown', text: '# stale', truncated: false }); await firstSelect;
  assert.match(element('artifact-preview').innerHTML, /<h1>latest<\/h1>/); assert.doesNotMatch(element('artifact-preview').innerHTML, /stale/);
  const writes = element('artifact-preview').writes; workspace.render(first, 'runtime A'); assert.equal(element('artifact-preview').writes, writes, 'event rerenders preserve mounted previews');

  pending = deferred(); const changing = workspace.select('one');
  element('details').hidden = true; workspace.render(turn('run A', []), 'runtime B');
  pending.resolve({ kind: 'text', name: 'one.md', mimeType: 'text/markdown', text: 'previous Runtime', truncated: false }); await changing;
  assert.equal(element('artifact-preview').hidden, true); assert.equal(element('artifact-preview').innerHTML, ''); assert.equal(element('artifact-download').hidden, true);

  const bytes = deferred(); globalThis.fetch = () => bytes.promise;
  workspace.render(turn('run B', [artifact('image', 'image/png')]), 'runtime B');
  const loadingImage = workspace.select('image');
  workspace.render(undefined, 'runtime B');
  bytes.resolve(new Response(new Blob(['image'], { type: 'image/png' }))); await loadingImage;
  assert.equal(element('artifact-preview').innerHTML, '', 'late binary responses cannot reopen a cleared conversation');

  element('details').hidden = true;
  globalThis.fetch = async () => new Response(new Blob(['image'], { type: 'image/png' }));
  workspace.render(turn('run C', [artifact('image', 'image/png')]), 'runtime C'); await workspace.select('image');
  assert.match(element('artifact-preview').innerHTML, /src="blob:/);
  workspace.render(undefined, 'runtime C'); assert.equal(revoked.length, 1);
  assert.ok(requests.every(path => path.includes('runtimeId=runtime%20A')));
});
