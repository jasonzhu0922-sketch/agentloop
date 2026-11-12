import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function fixture(tabName = 'runtimes', skillPackages) {
  const source = await readFile(new URL('../web/capability-settings.js', import.meta.url), 'utf8');
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  class Element {
    children = []; dataset = {}; textContent = ''; className = ''; disabled = false; parent = null;
    classList = { toggle() {}, add() {} };
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
    prepend(...items) { for (const item of items) item.parent = this; this.children.unshift(...items); }
    replaceChildren(...items) { this.children = []; this.append(...items); }
    setAttribute() {} addEventListener() {} focus() {}
    get lastElementChild() { return this.children.at(-1); }
    get isConnected() { return this.parent ? this.parent.children.includes(this) && this.parent.isConnected : this === body; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      return flatten(this).slice(1).filter(node => selector.split(',').some(part => part.startsWith('.')
        ? node.className.split(' ').includes(part.slice(1)) : node.tag === part));
    }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  }
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const body = element('capability-body');
  const tab = new Element(); tab.dataset.settingsTab = tabName;
  const runtime = { id: 'desktop-default', displayName: '本机 Runtime', status: 'stopped', isDefault: true, iconKey: 'xuanwu' };
  const packages = skillPackages ?? [
    { packageId: 'healthy', skillName: 'data-analysis', validationStatus: 'valid' },
    { packageId: 'broken', skillName: 'data-platform-query', validationStatus: 'invalid', validationDetail: 'skill_package_not_available' },
    { packageId: 'unbound', skillName: 'unbound-invalid', validationStatus: 'invalid', validationDetail: '<script>text only</script>' },
  ];
  let selected = ['healthy', 'broken']; const writes = [];
  const api = async (path, data) => {
    if (path === '/api/runtimes') return { runtimes: [runtime] };
    if (path === '/api/skills') return { skills: packages };
    if (path === '/api/mcp') return { servers: [] };
    if (path.endsWith('/configuration')) {
      if (data) { selected = [...data.configuration.skillPackageIds]; writes.push(data); }
      return { revision: 'revision-1', configuration: { iconKey: 'xuanwu', skills: selected.map(packageId => ({ packageId })), mcpServerIds: [], mcpServers: [] } };
    }
    throw Error(path);
  };
  const install = runInNewContext(source.replace(/^import .*;\n/gm, '').replace('export function', 'function') + '\ninstallCapabilitySettings', {
    document: { createElement: tag => Object.assign(new Element(), { tag }), querySelectorAll: () => [tab] }, Node: Element,
    installModelSettings: () => ({ canLeave: () => true }), confirm: () => true,
  });
  install({ api, element, refreshModels() {}, status() {}, currentRuntime: () => runtime.id, refreshCapabilities() {} });
  const click = async control => { assert.equal(control.disabled, false); control.onclick(); await new Promise(resolve => setImmediate(resolve)); };
  const button = title => flatten(body).find(node => node.tag === 'button' && node.textContent === title);
  const options = () => body.querySelectorAll('.runtime-skill-option');
  const configure = async () => { await click(button('•••')); await click(button('配置')); };
  await click(tab); if (tabName === 'runtimes') await configure();
  return { body, options, button, click, configure, writes };
}

test('bound unavailable Skills can be unchecked while new invalid bindings stay disabled', async () => {
  const ui = await fixture(); const [healthy, broken, unbound] = ui.options();
  assert.equal(healthy.children[0].disabled, false);
  assert.equal(broken.children[0].checked, true);
  assert.equal(broken.children[0].disabled, false);
  assert.match(broken.children[1].children[2].textContent, /当前绑定已隔离.*可取消勾选/);
  assert.equal(unbound.children[0].checked, false);
  assert.equal(unbound.children[0].disabled, true);
  assert.match(unbound.children[1].children[2].textContent, /<script>text only<\/script>/);
  broken.children[0].checked = false;
  await ui.click(ui.button('保存'));
  assert.deepEqual([...ui.writes[0].configuration.skillPackageIds], ['healthy']);
  await ui.configure();
  assert.equal(ui.options()[1].children[0].checked, false);
  assert.equal(ui.options()[1].children[0].disabled, true);
});

test('unchecking a healthy Skill saves the exact selection even with an unavailable binding retained', async () => {
  const ui = await fixture(); ui.options()[0].children[0].checked = false;
  await ui.click(ui.button('保存'));
  assert.deepEqual([...ui.writes[0].configuration.skillPackageIds], ['broken']);
  assert.equal(ui.writes[0].revision, 'revision-1');
  await ui.configure();
  assert.equal(ui.options()[0].children[0].checked, false);
  assert.equal(ui.options()[1].children[0].checked, true);
});

test('Skill cards distinguish model recognition, failed recognition, missing models and package declarations', async () => {
  const ui = await fixture('skills', [
    { packageId: 'identified', skillName: 'identified', validationStatus: 'valid', metadataSource: 'detected', metadataGenerationMethod: 'deterministic+model', metadataGenerationStatus: 'completed', metadataNeedsReview: true },
    { packageId: 'failed', skillName: 'failed', validationStatus: 'valid', metadataSource: 'detected', metadataGenerationMethod: 'deterministic', metadataGenerationStatus: 'failed', metadataNeedsReview: true },
    { packageId: 'basic', skillName: 'basic', validationStatus: 'valid', metadataSource: 'detected', metadataGenerationMethod: 'deterministic', metadataGenerationStatus: 'fallback', metadataNeedsReview: true },
    { packageId: 'package', skillName: 'package', validationStatus: 'valid', metadataSource: 'package', metadataGenerationMethod: 'none', metadataGenerationStatus: 'not-needed', metadataNeedsReview: false },
  ]);
  assert.deepEqual(ui.body.querySelectorAll('.skill-package-state').map(node => node.textContent), [
    '已通过模型识别，可选维护', '模型识别未完成，已保留基础识别结果', '未配置可用模型，已完成基础识别', '使用包内声明',
  ]);
});
