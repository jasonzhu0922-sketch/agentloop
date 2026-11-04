import assert from 'node:assert/strict';
import test from 'node:test';
import { createComposerPreferences } from '../web/composer-preferences.js';

test('connector choices survive reload and remain scoped to account, runtime and conversation', () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  const first = createComposerPreferences(storage, 'account-a');
  first.setConnectors('runtime-a', 'conversation-a', ['mail', 'wps']);
  first.setConnectors('runtime-a', 'conversation-b', ['mail']);
  const reloaded = createComposerPreferences(storage, 'account-a');
  assert.deepEqual(reloaded.connectors('runtime-a', 'conversation-a'), ['mail', 'wps']);
  assert.deepEqual(reloaded.connectors('runtime-a', 'conversation-b'), ['mail']);
  assert.deepEqual(reloaded.connectors('runtime-b', 'conversation-a'), []);
  assert.deepEqual(createComposerPreferences(storage, 'account-b').connectors('runtime-a', 'conversation-a'), []);
  reloaded.setConnectors('runtime-a', 'conversation-a', []);
  assert.deepEqual(createComposerPreferences(storage, 'account-a').connectors('runtime-a', 'conversation-a'), []);
  reloaded.removeConversation('runtime-a', 'conversation-b');
  assert.deepEqual(createComposerPreferences(storage, 'account-a').connectors('runtime-a', 'conversation-b'), []);
});

test('last model choice survives reload and storage failures do not block choices', () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  createComposerPreferences(storage, 'a').setModel('model-a');
  assert.equal(createComposerPreferences(storage, 'a').model(), 'model-a');
  assert.equal(createComposerPreferences(storage, 'b').model(), '');
  const unavailable = createComposerPreferences({ getItem() { throw Error(); }, setItem() { throw Error(); } }, 'a');
  unavailable.setModel('model-b');
  assert.equal(unavailable.model(), 'model-b');
});
