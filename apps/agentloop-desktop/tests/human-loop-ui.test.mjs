import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHumanLoop, readHumanLoopResponse, bindHumanLoop } from '../web/human-loop.js';
import { createTurn, updateTurn } from '../web/turn-projection.js';
import { readRunUpdate } from '../web/run-polling.js';

const request = responseSchema => ({ id: 'question', revision: 1, status: 'open', title: '<script>title</script>', prompt: '请填写', rationale: '需要输入', responseSchema });
const selection = request({ type: 'select', minSelections: 1, maxSelections: 2, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', description: '<img src=x onerror=alert(1)>' }] });
function withFormData(t) {
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor(form) { this.data = form.data; } get(name) { return this.data[name]?.[0] ?? null; } getAll(name) { return this.data[name] ?? []; } };
  t.after(() => { globalThis.FormData = original; });
}

test('schema-driven selection/form/confirm UI escapes content, never preselects an answer, and preserves typed response shape', t => {
  withFormData(t);
  const html = renderHumanLoop(selection);
  assert.match(html, /type="checkbox"/); assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|<img| checked/);
  assert.deepEqual(readHumanLoopResponse(selection, { data: { choice: ['0', '1'] } }), ['a', 'b']);
  assert.throws(() => readHumanLoopResponse(selection, { data: {} }), /请选择/);
  const form = request({ type: 'form', fields: [{ id: '__proto__', label: '正文', valueType: 'textarea', required: true }, { id: 'count', label: '数量', valueType: 'number', required: false }, { id: 'file', label: '文件', valueType: 'file_ref', required: false }] });
  assert.match(renderHumanLoop(form), /textarea/); assert.match(renderHumanLoop(form), /type="number"/);
  const value = readHumanLoopResponse(form, { data: { 'field-0': ['邮件正文'], 'field-1': ['3'] } });
  assert.equal(Object.hasOwn(value, '__proto__'), true); assert.equal(value.__proto__, '邮件正文'); assert.equal(value.count, '3');
  assert.throws(() => readHumanLoopResponse(form, { data: {} }), /请填写/);
  const confirm = request({ type: 'confirm', acceptLabel: '继续', rejectLabel: '停止', requireReasonOnReject: true });
  assert.deepEqual(readHumanLoopResponse(confirm, { data: { decision: ['accept'] } }), true);
  assert.throws(() => readHumanLoopResponse(confirm, { data: { decision: ['reject'] } }), /拒绝原因/);
  assert.deepEqual(readHumanLoopResponse(confirm, { data: { decision: ['reject'], reason: ['不继续'] } }), { accepted: false, reason: '不继续' });
});

test('submission waits for an explicit submit, prevents double click, and retains draft after failure', async t => {
  withFormData(t); let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const fields = { disabled: false }, feedback = { textContent: '' };
  const form = { data: { choice: ['0'] }, reportValidity: () => true, querySelector: selector => selector === 'fieldset' ? fields : feedback };
  bindHumanLoop(form, selection, async (req, value) => { assert.equal(req.id, 'question'); assert.deepEqual(value, ['a']); calls++; await gate; throw new Error('offline'); });
  assert.equal(calls, 0);
  const first = form.onsubmit({ preventDefault() {} });
  await form.onsubmit({ preventDefault() {} }); assert.equal(calls, 1); assert.equal(fields.disabled, true);
  release(); await first;
  assert.equal(fields.disabled, false); assert.deepEqual(form.data.choice, ['0']); assert.match(feedback.textContent, /填写已保留/);
  bindHumanLoop(form, selection, async () => { calls++; });
  await form.onsubmit({ preventDefault() {} }); assert.equal(fields.disabled, true); assert.match(feedback.textContent, /回答已提交/);
});

test('authoritative request polling removes stale waiting events and restores a new request after reconnect', async () => {
  const run = { id: 'run', status: 'running', input: '', createdAt: 1 };
  const turn = createTurn(run);
  updateTurn(turn, run, [{ seq: 1, type: 'run.waiting_user', data: { request: selection } }]);
  const current = request({ type: 'confirm', acceptLabel: '继续', rejectLabel: '停止' }); current.id = 'new-question';
  const update = await readRunUpdate(async path => path.includes('/events?') ? { events: [] } : path.endsWith('/artifacts') ? { artifacts: [] } : path.endsWith('/human-loop/current') ? { request: current } : { run }, turn);
  updateTurn(turn, update.run, update.events, update.artifacts, update.humanLoop);
  assert.equal(turn.humanLoop.id, 'new-question');
  updateTurn(turn, run, [], undefined, {}); assert.equal(turn.humanLoop, undefined);
  updateTurn(turn, { ...run, status: 'cancelled' }, [], undefined, { request: current }); assert.equal(turn.humanLoop, undefined);
});
