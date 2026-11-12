import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { SKILL_DECLARATION_EDITOR_SCHEMA } from '@zhujun/agentloop';

class Element {
  children = []; dataset = {}; attributes = {}; textContent = ''; value = ''; disabled = false;
  constructor(tag) { this.tagName = tag.toUpperCase(); }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() { this.focused = true; }
}
const flatten = node => [node, ...node.children.flatMap(flatten)];
async function fixture(editable = true, semanticTagOptions = ['data-analysis', 'data-query', '中文标签']) {
  const source = await readFile(new URL('../web/skill-settings.js', import.meta.url), 'utf8');
  const create = runInNewContext(source.replace(/export /g, '') + '\ncreateSkillMetadataForm', {
    document: { createElement: tag => new Element(tag) }, structuredClone,
  });
  const declaration = {
    schema: 'agentloop.skillDeclaration/v1', identity: { name: 'sample', description: 'Sample' },
    activation: { semanticTags: ['data-analysis'], intentExamples: ['分析每月销售趋势'] },
    workflow: { roles: ['source_provider'], artifactKinds: ['none'], sourceKinds: ['database'], qaKinds: [], requiredSkills: ['missing-provider'] },
    execution: { manifest: 'agentloop.executors.json' }, compatibility: { executionProfiles: ['local_script'], producesEvidenceKinds: ['source_summary'] },
    requirements: { python: { version: '>=3.10', packages: ['pandas>=2'], files: [] }, commands: [], environment: [], mcpServers: [] },
  };
  const form = create({ declaration, semanticTagOptions, editorSchema: SKILL_DECLARATION_EDITOR_SCHEMA, name: 'sample', editable, fields: {}, source: 'package' }, [{ skillName: 'other', validationStatus: 'valid' }]);
  const field = path => flatten(form.element).find(node => node.dataset.field === path);
  const input = path => flatten(field(path)).find(node => node.dataset.fieldInput === path);
  const choice = (path, value) => flatten(field(path)).find(node => node.tagName === 'INPUT' && node.value === value);
  return { form, declaration, field, input, choice };
}

test('the form covers every schema field and preserves readonly execution and missing Skill dependencies', async () => {
  const f = await fixture();
  for (const group of SKILL_DECLARATION_EDITOR_SCHEMA.groups) for (const field of group.fields) assert.ok(f.field(field.path), field.path);
  assert.equal(f.input('identity.name'), undefined); assert.equal(f.input('execution.manifest'), undefined);
  assert.equal(f.choice('compatibility.executionProfiles', 'local_script'), undefined);
  assert.equal(f.choice('workflow.requiredSkills', 'missing-provider').checked, true);
  const result = f.form.read(); assert.equal(result.valid, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.declaration)), f.declaration);
});

test('the default view has one optional field and preserves all collapsed values when saving', async () => {
  const f = await fixture();
  const details = flatten(f.form.element).filter(node => node.tagName === 'DETAILS' && node.dataset.section);
  assert.equal(details.length, 2);
  assert.ok(details.every(node => !node.open));
  const visible = node => node.tagName === 'DETAILS' && !node.open ? [node] : [node, ...node.children.flatMap(visible)];
  const controls = visible(f.form.element).filter(node => ['INPUT', 'TEXTAREA'].includes(node.tagName));
  assert.equal(controls.length, 1);
  assert.equal(controls[0].dataset.fieldInput, 'activation.intentExamples');
  controls[0].value = '新的典型请求';
  const result = f.form.read(); assert.equal(result.valid, true);
  const expected = structuredClone(f.declaration); expected.activation.intentExamples = ['新的典型请求'];
  assert.deepEqual(JSON.parse(JSON.stringify(result.declaration)), expected);
  assert.ok(details.every(node => !node.open));
});

test('invalid enum selection and list lengths produce field errors without a save payload being admitted', async () => {
  const f = await fixture(); f.choice('workflow.roles', 'source_provider').checked = false;
  f.input('activation.intentExamples').value = Array.from({ length: 17 }, (_, index) => `request-${index}`).join('\n');
  assert.equal(f.form.read().valid, false);
  assert.equal(flatten(f.form.element).find(node => node.dataset.section === 'advanced').open, true);
  for (const path of ['workflow.roles', 'activation.intentExamples']) assert.ok(flatten(f.field(path)).some(node => node.attributes.role === 'alert' && node.textContent));
});

test('semantic tags are selected from valid existing options and preserve package-specific values', async () => {
  const f = await fixture(true, ['data-query', 'data-query', '中文标签', 'INVALID', 'a'.repeat(65)]);
  assert.equal(f.input('activation.semanticTags').tagName, 'SUMMARY');
  assert.equal(f.choice('activation.semanticTags', 'data-analysis').checked, true);
  const options = flatten(f.field('activation.semanticTags')).filter(node => node.type === 'checkbox');
  assert.deepEqual(options.map(node => node.value), ['data-analysis', 'data-query']);
  const next = f.choice('activation.semanticTags', 'data-query'); next.checked = true; next.onchange();
  assert.deepEqual([...f.form.read().declaration.activation.semanticTags], ['data-analysis', 'data-query']);
  const current = f.choice('activation.semanticTags', 'data-analysis'); current.checked = false; current.onchange();
  assert.deepEqual([...f.form.read().declaration.activation.semanticTags], ['data-query']);
  next.checked = false; next.onchange();
  assert.equal(f.form.read().valid, true);
  assert.deepEqual([...f.form.read().declaration.activation.semanticTags], []);
});

test('tag selection enforces the schema limit while allowing selected tags to be removed', async () => {
  const f = await fixture(true, Array.from({ length: 32 }, (_, index) => `tag-${index}`));
  for (let index = 0; index < 31; index++) {
    const option = f.choice('activation.semanticTags', `tag-${index}`);
    assert.equal(option.disabled, false); option.checked = true; option.onchange();
  }
  assert.equal(f.form.read().declaration.activation.semanticTags.length, 32);
  assert.equal(f.choice('activation.semanticTags', 'tag-31').disabled, true);
  const selected = f.choice('activation.semanticTags', 'data-analysis');
  assert.equal(selected.disabled, false); selected.checked = false; selected.onchange();
  assert.equal(f.choice('activation.semanticTags', 'tag-31').disabled, false);
});

test('clearing an optional Python version removes it and duplicate lines are normalized', async () => {
  const f = await fixture(); f.input('requirements.python.version').value = '';
  f.input('requirements.python.packages').value = 'pandas>=2\n\npandas>=2\nrequests>=2';
  const result = f.form.read(); assert.equal(result.valid, true);
  assert.equal('version' in result.declaration.requirements.python, false);
  assert.deepEqual([...result.declaration.requirements.python.packages], ['pandas>=2', 'requests>=2']);
  f.input('requirements.python.files').value = '../outside.txt'; assert.equal(f.form.read().valid, false);
  assert.equal(flatten(f.form.element).find(node => node.dataset.section === 'requirements').open, true);
});

test('readonly packages cannot change any schema field through the form', async () => {
  const f = await fixture(false);
  for (const node of flatten(f.form.element).filter(node => ['INPUT', 'TEXTAREA'].includes(node.tagName))) assert.equal(node.disabled, true);
  assert.deepEqual(f.form.read().declaration, f.declaration);
});
