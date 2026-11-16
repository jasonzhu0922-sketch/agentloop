import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalAgentService } from '../local-agent-runtime/src/service/local-agent-service.ts';

// The strict-local transport must preserve actor, Run, request revision and
// response shape when delegating to the same Runtime HIL authority as Desktop.
test('strict-local HIL delegates the authenticated owner and exact response revision', async () => {
  const calls = [];
  const request = { id: 'request', revision: 7, status: 'open' };
  const runtime = { runs: {
    currentHumanLoop: async (...args) => { calls.push(['read', ...args]); return request; },
    respondHumanLoop: async (...args) => { calls.push(['respond', ...args]); if (args[4] !== 7) throw Object.assign(new Error('revision_conflict'), { status: 409 }); return { accepted: true }; },
  } };
  const service = { supervisor: { withRuntimeUse: async (runtimeId, use) => { assert.equal(runtimeId, 'local-runtime'); return use(runtime); } } };
  const session = { ownerUserId: 'authenticated-owner' };
  assert.deepEqual(await LocalAgentService.prototype.strictLocalHumanLoop.call(service, session, 'local-runtime', 'run'), { request });
  const value = { accepted: false, reason: '需要修改范围' };
  await LocalAgentService.prototype.respondStrictLocalHumanLoop.call(service, session, 'local-runtime', 'run', 'request', value, 7);
  assert.deepEqual(calls, [['read', 'authenticated-owner', 'run'], ['respond', 'authenticated-owner', 'run', 'request', value, 7]]);
  await assert.rejects(LocalAgentService.prototype.respondStrictLocalHumanLoop.call(service, session, 'local-runtime', 'run', 'request', value, 6), error => error.status === 409);
});
