import assert from 'node:assert/strict';
import test from 'node:test';
import { createSteerDrafts, renderSteerMessages } from '../../agentloop-multi-runtime/web/client/ui/steer-queue.js';

test('unknown submission retains immutable identity and original Run across reload and lost response', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const scope = ['account', 'runtime', 'conversation'];
  const queue = createSteerDrafts(storage, scope);
  const draft = queue.add('Focus on East China');
  queue.edit(draft.requestId, 'Focus on East China and compare last year');
  queue.begin(draft.requestId, 'original-run');
  assert.throws(() => queue.remove(draft.requestId));
  const restored = createSteerDrafts(storage, scope);
  assert.equal(restored.list()[0].state, 'unknown');
  assert.throws(() => restored.edit(draft.requestId, 'changed'));
  assert.throws(() => restored.begin(draft.requestId, 'new-run'));
  assert.equal(restored.begin(draft.requestId, 'original-run').requestId, draft.requestId);
  restored.failed(draft.requestId);
  assert.equal(restored.list()[0].state, 'unknown');
  restored.reconcile([{ requestId: draft.requestId, status: 'answered' }]);
  assert.equal(createSteerDrafts(storage, scope).list().length, 0);
});

test('terminal conflict preserves draft; accounts, Runtime and conversations have separate queues', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const queue = createSteerDrafts(storage, ['a', 'r', 'c']);
  const draft = queue.add('Unsent requirement');
  queue.begin(draft.requestId, 'old'); queue.failed(draft.requestId, true);
  assert.equal(queue.list()[0].state, 'draft');
  assert.equal(queue.begin(draft.requestId, 'next').runId, 'next');
  for (const scope of [['other', 'r', 'c'], ['a', 'other', 'c'], ['a', 'r', 'other']]) assert.deepEqual(createSteerDrafts(storage, scope).list(), []);
  const html = renderSteerMessages([{ id: '<id>', text: '<img onerror=bad>', status: 'unprocessed', decision: { reason: 'cancelled' } }]);
  assert.doesNotMatch(html, /<img|<id>/); assert.match(html, /未处理/); assert.match(html, /cancelled/);
});

test('two windows preserve each other drafts and cannot edit a message submitted elsewhere', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const first = createSteerDrafts(storage, ['account', 'runtime', 'conversation']);
  const second = createSteerDrafts(storage, ['account', 'runtime', 'conversation']);
  const draft = first.add('one'); second.add('two');
  assert.equal(first.list().length, 2);
  first.begin(draft.requestId, 'run');
  assert.throws(() => second.edit(draft.requestId, 'changed'));
  assert.throws(() => second.remove(draft.requestId));
  assert.equal(second.list()[0].text, 'one');
});
