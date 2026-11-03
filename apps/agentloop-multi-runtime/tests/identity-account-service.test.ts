import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { Server } from "node:http";
import { SqliteConnection } from "@zhujun/agentloop";
import { AccountServiceClient, IdentityService, RemoteIdentityService } from "@zhujun/agentloop-identity";
import { createAccountServer } from "../../agentloop-account-service/src/server.ts";
import { createRouterHttpServer } from "../src/router/api/router-api.ts";
import type { SubmitConversationTask } from "../src/shared/contracts.ts";

test("Router HTTP and Desktop client use one independent account authority", async t => {
  const database = new SqliteConnection(":memory:");
  const identity = new IdentityService(database); await identity.ready();
  const accounts = createAccountServer(identity);
  let router: Server | undefined;
  t.after(async () => {
    for (const server of [router, accounts]) if (server) await new Promise<void>(resolve => {
      server.close(() => resolve()); server.closeAllConnections();
    });
    await database.close();
  });
  async function listen(server: Server) {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  }
  const accountOrigin = await listen(accounts);
  const desktop = new AccountServiceClient(accountOrigin);
  let submitted: SubmitConversationTask | undefined;
  router = createRouterHttpServer({
    async submit(task: SubmitConversationTask) { submitted = task; return { id: "assignment-test", tenantId: task.tenantId, ownerUserId: task.ownerUserId }; },
    async assignment() { return undefined; },
  }, { identity: new RemoteIdentityService(accountOrigin) });
  const origin = await listen(router);
  const credentials = { email: "unified@example.test", password: "fixture-unified-password-12" };
  const registered = await fetch(`${origin}/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials) });
  assert.equal(registered.status, 201);
  const web = await registered.json() as { token: string; user: { id: string }; tenant: { id: string } };
  const local = await desktop.authenticate("login", credentials.email, credentials.password);
  assert.equal(local.principal.userId, web.user.id); assert.equal(local.principal.tenantId, web.tenant.id);
  const task = await fetch(`${origin}/v1/tasks`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${local.token}`, "x-user-id": "forged" },
    body: JSON.stringify({ conversationId: "test-conversation", clientMessageId: "message-1", input: "hello", requestedModelKey: "test-model" }),
  });
  assert.equal(task.status, 202);
  assert.equal(submitted?.ownerUserId, web.user.id); assert.equal(submitted?.tenantId, web.tenant.id);
  const revoked = await fetch(`${origin}/v1/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${local.token}` } });
  assert.equal(revoked.status, 204);
  await assert.rejects(desktop.current(local.token), /session_invalid/);
  assert.equal((await desktop.current(web.token)).userId, web.user.id, "other independently issued sessions remain valid");
  await desktop.logout(web.token);
  assert.equal((await fetch(`${origin}/v1/auth/me`, { headers: { authorization: `Bearer ${web.token}` } })).status, 401);
});
