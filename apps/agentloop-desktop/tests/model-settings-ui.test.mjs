import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { MODEL_CONFIGURATION_EDITOR_SCHEMA as schema } from '@zhujun/agentloop';

class Element {
  children = []; dataset = {}; attributes = {}; value = ''; textContent = ''; disabled = false; hidden = false; className = '';
  classList = { toggle() {}, add() {} };
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
  append(...items) { for (const item of items) { item.parentElement = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, callback) { this[`on${name}`] = callback; }
  querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]).filter(child => selector.split(',').map(tag => tag.trim().toUpperCase()).includes(child.tagName)); }
}
const normalize = value => JSON.parse(JSON.stringify(value));
const flatten = node => [node, ...node.children.flatMap(flatten)];
const source = await readFile(new URL('../web/model-settings.js', import.meta.url), 'utf8');
function module() {
  return runInNewContext(source.replace(/export /g, '') + '\n({ createModelParameterForm, installModelSettings })', { document: { createElement: tag => new Element(tag) }, structuredClone, URL, console });
}
const sample = { key: 'chat', displayName: '工作模型', providerModel: 'upstream-Model', protocol: 'chat-completions', contextWindowTokens: 64000, maxOutputTokens: 4096, temperature: 0,
  vendorFlag: { nested: ['preserve', 1] }, reasoningVisibility: 'hidden' };
function form(model = sample, kind = 'openai-compatible', editable = true, preset) {
  return module().createModelParameterForm(structuredClone(model), schema.providers.find(provider => provider.id === kind), schema, { editable, preset: schema.presets.find(entry => entry.id === preset), onChange() {} });
}
const textarea = (form, key) => flatten(form.element).find(control => control.dataset.fieldInput === key);

test('ordinary edits preserve unknown extensions, zero values and omitted defaults', () => {
  const editor = form(); assert.deepEqual(normalize(editor.read(true)), sample);
  editor.controls.get('displayName').value = '新名称'; editor.controls.get('reasoning').value = 'medium';
  const result = normalize(editor.read(true));
  assert.equal(result.displayName, '新名称'); assert.equal(result.reasoning, 'medium'); assert.equal(result.temperature, 0); assert.deepEqual(result.vendorFlag, sample.vendorFlag);
  assert.equal(Object.hasOwn(result, 'providerOptions'), false); assert.equal(Object.hasOwn(result, 'timeoutMs'), false);
});

test('saved thinking remains intact until a level is selected, which directly replaces it', () => {
  const model = { ...sample, enableThinking: false, thinkingMode: 'disabled' };
  const editor = form(model); assert.deepEqual(normalize(editor.read(true)), model);
  assert.equal(editor.controls.get('reasoning').disabled, false);
  assert.match(editor.controls.get('reasoning').children[0].textContent, /关闭思考/);
  editor.controls.get('displayName').value = '仅修改名称';
  assert.equal(editor.read(true).enableThinking, false);
  editor.controls.get('reasoning').value = 'high';
  const result = normalize(editor.read(true));
  assert.equal(result.reasoning, 'high');
  assert.equal(Object.hasOwn(result, 'enableThinking'), false);
  assert.equal(Object.hasOwn(result, 'thinkingMode'), false);
  assert.deepEqual(result.vendorFlag, model.vendorFlag);
  assert.equal(model.enableThinking, false);
});

test('selecting service defaults also removes phase and effort overrides', () => {
  const editor = form({ ...sample, reasoningEffort: 'none', thinkingEffort: 'high', planningThinkingMode: 'enabled' });
  assert.match(editor.controls.get('reasoning').children[0].textContent, /planningThinkingMode=enabled/);
  editor.controls.get('reasoning').value = 'provider-default';
  const result = editor.read(true);
  assert.equal(result.reasoning, 'provider-default');
  for (const key of ['reasoningEffort', 'thinkingEffort', 'planningThinkingMode']) assert.equal(Object.hasOwn(result, key), false);
});

test('field errors are actionable and extensions cannot overwrite connection or managed fields', () => {
  const editor = form(); editor.controls.get('maxOutputTokens').value = '64000'; assert.throws(() => editor.read(true), /最大输出必须小于/);
  editor.controls.get('maxOutputTokens').value = '4096'; textarea(editor, 'extensions').value = '{"baseUrl":"https://other.example"}'; assert.throws(() => editor.read(true), /对应表单/);
  textarea(editor, 'extensions').value = '{"temperature":0.5}'; assert.throws(() => editor.read(true), /对应表单/);
  textarea(editor, 'extensions').value = '{"__proto__":{}}'; assert.throws(() => editor.read(), /无效字段/);
  textarea(editor, 'extensions').value = '{'; assert.throws(() => editor.read(), /JSON 格式无效/);
  textarea(editor, 'extensions').value = '{}'; textarea(editor, 'providerOptions').value = '{"max_tokens":1000000}'; assert.throws(() => editor.read(true), /不能覆盖/);
});

test('SDK options stay in their namespace and readonly forms retain every value', () => {
  const model = { ...sample, providerOptions: { enableThinking: false, thinkingBudget: 2048 } };
  const editor = form(model, 'alibaba', false);
  assert.deepEqual(normalize(editor.read(true)), model);
  assert.ok(flatten(editor.element).filter(control => ['INPUT', 'TEXTAREA', 'SELECT'].includes(control.tagName)).every(control => control.disabled));
  assert.equal(editor.controls.get('reasoning').value, '');
});

async function fixture({ editable = true, failSave = false, failRefresh = false } = {}) {
  const elements = new Map(); const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const providers = [{ key: 'service', displayName: '工作服务', baseUrl: 'https://service.example/v1', credentialConfigured: true, models: [sample, { ...sample, key: 'second', displayName: '第二个模型' }] },
    { key: 'other', displayName: '其他服务', baseUrl: 'https://other.example/v1', credentialConfigured: true, models: [] }];
  const snapshot = { revision: 'revision-1', editable, configuration: { reuseCloudModels: false, providers } }; const calls = [];
  const api = async (path, body) => {
    calls.push({ path, body: body && structuredClone(body) });
    if (path.endsWith('/schema')) return schema;
    if (path.endsWith('/test')) return { ok: true, durationMs: 10, message: '基础调用通过' };
    if (!body) return structuredClone(snapshot);
    if (failSave) throw new Error('model_configuration_stale');
    return { ...snapshot, revision: 'revision-2', configuration: { ...body.configuration, providers: body.configuration.providers.map(({ apiKey, ...provider }) => provider) } };
  };
  const ui = module().installModelSettings({ api, element, managed: true, status() {}, async refreshModels() { if (failRefresh) throw Error('refresh-failed'); } });
  await ui.load();
  const control = key => flatten(element('provider-editors')).find(item => item.dataset.fieldInput === key);
  // The production HTML owns these containers; link them in the minimal DOM.
  element('provider-editors').append(element('provider-form'), element('model-list'), element('model-form'), element('provider-api-key'));
  return { ...ui, element, calls, control };
}

test('switching services and models retains drafts, and probing never saves', async () => {
  const f = await fixture(); assert.equal(f.element('provider-api-key').disabled, false);
  const displayName = f.control('displayName'); displayName.value = '未保存名称'; displayName.oninput();
  f.control('reasoning').value = 'medium'; f.control('reasoning').onchange();
  f.element('provider-list').children[1].onclick(); f.element('provider-list').children[0].onclick();
  assert.equal(f.control('displayName').value, '未保存名称'); assert.equal(f.control('reasoning').value, 'medium');
  f.element('model-list').children[1].onclick(); f.element('model-list').children[0].onclick(); assert.equal(f.control('displayName').value, '未保存名称');
  await f.element('model-test').onclick();
  assert.match(f.element('model-test-status').textContent, /基础调用通过/); assert.equal(f.canLeave(), false);
  const probe = f.calls.find(call => call.path.endsWith('/test'));
  assert.equal(probe.body.configuration.providers[0].models[0].reasoning, 'medium'); assert.deepEqual(probe.body.configuration.providers[0].models[0].vendorFlag, sample.vendorFlag);
  assert.equal(f.calls.some(call => call.path === '/api/model-configuration' && call.body), false);
});

test('stale saves preserve entered credentials and model edits', async () => {
  const f = await fixture({ failSave: true }); f.control('displayName').value = '保留修改'; f.control('displayName').oninput();
  f.element('provider-api-key').value = 'draft-secret'; f.element('provider-api-key').oninput(); await f.element('model-settings-save').onclick();
  assert.equal(f.control('displayName').value, '保留修改'); assert.equal(f.element('provider-api-key').value, 'draft-secret'); assert.equal(f.canLeave(), false);
});

test('acknowledged save immediately drops entered credentials even if catalog refresh fails', async () => {
  const f = await fixture({ failRefresh: true }); f.element('provider-api-key').value = 'draft-secret'; f.element('provider-api-key').oninput();
  await f.element('model-settings-save').onclick(); assert.equal(f.element('provider-api-key').value, ''); assert.equal(f.canLeave(), true);
  assert.match(f.element('model-settings-status').textContent, /已保存.*刷新失败/);
});

test('host-owned configuration disables editing, test calls and save actions', async () => {
  const f = await fixture({ editable: false });
  for (const id of ['provider-add', 'provider-delete', 'model-add', 'model-delete', 'model-test', 'provider-api-key', 'model-settings-save']) assert.equal(f.element(id).disabled, true);
});


test('testing the selected model works while another new model is still incomplete', async () => {
  const f = await fixture(); f.element('model-add').onclick();
  f.element('model-list').children[0].onclick();
  await f.element('model-test').onclick();
  const probe = f.calls.find(call => call.path.endsWith('/test'));
  assert.ok(probe); assert.equal(probe.body.configuration.providers.length, 1);
  assert.equal(probe.body.configuration.providers[0].models.length, 1);
  assert.equal(probe.body.modelKey, 'chat');
  await f.element('model-settings-save').onclick();
  assert.equal(f.calls.some(call => call.path === '/api/model-configuration' && call.body), false);
  assert.match(f.element('model-settings-status').textContent, /服务模型 ID/);
});

test('SiliconFlow thinking edits use its switch and preserve unrelated extensions', () => {
  const model = { ...sample, reasoning: 'high', vendorFlag: { retained: true } };
  const editor = form(model, 'openai-compatible', true, 'siliconflow');
  assert.equal(editor.controls.has('reasoning'), false);
  assert.deepEqual(normalize(editor.read(true)), model);
  editor.controls.get('enableThinking').value = 'false';
  const off = normalize(editor.read(true));
  assert.equal(off.enableThinking, false); assert.equal(Object.hasOwn(off, 'reasoning'), false);
  assert.deepEqual(off.vendorFlag, model.vendorFlag);
  const restored = form(off, 'openai-compatible', true, 'siliconflow');
  assert.deepEqual(normalize(restored.read(true)), off);
  restored.controls.get('enableThinking').value = 'provider-default';
  assert.equal(restored.read(true).enableThinking, undefined);
  assert.equal(restored.read(true).reasoning, 'provider-default');
});

test('platform presets choose the connection driver without changing existing model protocols', async () => {
  const f = await fixture();
  f.control('protocol').value = ''; // An existing generic service implicitly uses Responses.
  f.control('provider.preset').value = 'siliconflow'; f.control('provider.preset').onchange();
  assert.equal(f.control('provider.kind').value, 'openai-compatible');
  assert.equal(f.control('provider.baseUrl').value, 'https://api.siliconflow.cn/v1');
  assert.equal(f.control('protocol').value, 'responses');
  assert.equal(f.control('provider.key').value, 'service');
});

test('new SiliconFlow service exposes a thinking toggle and inherits Chat Completions', async () => {
  const f = await fixture(); f.element('provider-add').onclick();
  f.control('provider.preset').value = 'siliconflow'; f.control('provider.preset').onchange();
  f.element('provider-api-key').value = 'draft-silicon-key';
  f.element('model-add').onclick();
  f.control('displayName').value = 'DeepSeek hosted by SiliconFlow';
  f.control('providerModel').value = 'deepseek-ai/DeepSeek-V4-Flash';
  f.control('enableThinking').value = 'false';
  await f.element('model-test').onclick();
  const provider = f.calls.find(call => call.path.endsWith('/test')).body.configuration.providers[0];
  assert.equal(provider.preset, 'siliconflow'); assert.equal(provider.kind, 'openai-compatible');
  assert.equal(provider.models[0].enableThinking, false); assert.equal(provider.models[0].protocol, undefined);
  assert.equal(provider.models[0].reasoning, undefined);
});
