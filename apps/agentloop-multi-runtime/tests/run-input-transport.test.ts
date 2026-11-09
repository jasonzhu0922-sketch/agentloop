import assert from 'node:assert/strict';
import test from 'node:test';
import type { Server } from 'node:http';
import { AppError } from '@zhujun/agentloop';
import { createRouterHttpServer } from '../src/router/api/router-api.ts';
import { createRuntimeHostHttpServer } from '../src/runtime-host/api/runtime-host-api.ts';
import { HttpRuntimeControl } from '../src/router/runtime-control/http-runtime-control.ts';
import type { RuntimeHostService } from '../src/runtime-host/service/runtime-host-service.ts';

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const message = { id: 'message', requestId: 'stable', runId: 'remote', seq: 1, text: 'progress?', status: 'accepted' as const, createdAt: 1, updatedAt: 1 };

test('Router verifies tenant and owner before forwarding Steer to the bound Host; conflicts survive HTTP', async () => {
  let calls = 0, terminal = false;
  const host = createRuntimeHostHttpServer({
    async submitInput(id: string, input: { requestId: string; text: string }) {
      calls++; assert.equal(id, 'remote'); assert.deepEqual(input, { requestId: 'stable', text: 'progress?' });
      if (terminal) throw new AppError('CONFLICT', 'Run is terminal', 409);
      return message;
    },
    async inputMessages(id: string) { calls++; assert.equal(id, 'remote'); return [message]; },
  } as unknown as RuntimeHostService, { dispatchToken: 'fixture-dispatch' });
  const hostOrigin = await listen(host);
  const control = new HttpRuntimeControl(hostOrigin, 'Bearer fixture-dispatch');
  const router = createRouterHttpServer({
    async assignment(id: string) { return id === 'assignment' ? { assignment: { tenantId: 'tenant', ownerUserId: 'owner' } } : undefined; },
    inputMessages: async () => control.inputMessages('remote'),
    submitInput: async (_: string, input: { requestId: string; text: string }) => control.submitInput('remote', input),
  } as unknown as Parameters<typeof createRouterHttpServer>[0], { identity: {
    authenticate: async authorization => {
      const [tenantId, userId] = String(authorization).replace('Bearer ', '').split(':');
      return { tenantId, userId, email: 'fixture@example.test' };
    },
  } as NonNullable<NonNullable<Parameters<typeof createRouterHttpServer>[1]>['identity']> });
  const origin = await listen(router);
  const send = (owner = 'owner', tenant = 'tenant', data: unknown = { requestId: 'stable', text: 'progress?' }) => fetch(origin + '/v1/assignments/assignment/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant-id': tenant, 'x-user-id': owner, authorization: `Bearer ${tenant}:${owner}` }, body: JSON.stringify(data),
  });
  try {
    assert.equal((await fetch(hostOrigin + '/v1/runtime-runs/remote/messages')).status, 401);
    assert.equal((await send('other')).status, 404);
    assert.equal((await send('owner', 'other')).status, 404);
    assert.equal((await send('owner', 'tenant', { requestId: 'stable', text: 'progress?', runtimeId: 'foreign' })).status, 400);
    assert.equal(calls, 0);
    const accepted = await send(); assert.equal(accepted.status, 200); assert.deepEqual((await accepted.json()).message, message);
    const history = await fetch(origin + '/v1/assignments/assignment/messages', { headers: { 'x-tenant-id': 'tenant', 'x-user-id': 'owner', authorization: 'Bearer tenant:owner' } });
    assert.deepEqual((await history.json()).messages, [message]);
    terminal = true; assert.equal((await send()).status, 409);
  } finally {
    await Promise.all([router, host].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  }
});
