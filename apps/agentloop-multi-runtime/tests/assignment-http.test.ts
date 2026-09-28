import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { ControlPlaneStore } from "../src/control-plane/control-plane-store.ts";
import { PersistentMultiRuntimeRouter } from "../src/control-plane/persistent-router.ts";
import { startAssignmentReconciler } from "../src/control-plane/assignment-reconciler.ts";
import { createRouterHttpServer } from "../src/http/router-http.ts";
import { IdentityService } from "../src/auth/identity-service.ts";
import { observeAssignment } from "../web/assignment-stream.js";
import { projectAssistantEvent } from "../web/assistant-event-projection.js";

test("HTTP Router returns a durable failed Assignment when a Runtime rejects dispatch before Run admission", async () => {
  const database = new AppDatabase(":memory:"); const store = new ControlPlaneStore(database);
  await store.ready();
  const identity = new IdentityService(database);
  const session = await identity.register("dispatch-failure@example.test", "long-test-password-123");
  await store.seedRuntimes([{ id: "host", endpoint: "http://fixture-host", profile: "general", capabilities: [], maxConcurrentRuns: 2, activeRunCount: 0, status: "ready" }]);
  await store.heartbeat({ runtimeId: "host", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: Date.now() });
  const router = new PersistentMultiRuntimeRouter({
    store,
    endpointFactory: () => ({ dispatch: async () => { throw new Error("upstream api_key=never-return-this"); } }),
  });
  const server = createRouterHttpServer(router, { identity });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/v2/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        schema: "agentloop.task/v2", conversationId: "dispatch-failure", clientMessageId: "message", input: "fixture",
        executionTarget: { kind: "cloud_pool" }, dataPolicy: { mode: "cloud" },
      }),
    });
    const body = await response.json() as { assignment?: { status?: string; remoteRunId?: string; errorCode?: string; errorMessage?: string } };
    assert.equal(response.status, 202);
    assert.deepEqual(body.assignment, {
      ...body.assignment,
      status: "failed",
      remoteRunId: "",
      errorCode: "runtime_dispatch_failed",
      errorMessage: "Runtime 未能接收本次任务，请稍后重试。",
    });
    assert.doesNotMatch(JSON.stringify(body), /never-return-this/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  }
});

test("HTTP Router + browser observer survives upstream error and socket loss, reconciles final state without redispatch", { timeout: 10_000 }, async () => {
  const database = new AppDatabase(":memory:"); const store = new ControlPlaneStore(database);
  await store.ready();
  const identity = new IdentityService(database);
  const session = await identity.register("observer@example.test", "long-test-password-123");
  await store.seedRuntimes([{ id: "host", endpoint: "http://fixture-host", profile: "general", capabilities: [], maxConcurrentRuns: 2, activeRunCount: 0, status: "ready" }]);
  await store.heartbeat({ runtimeId: "host", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: Date.now() });
  let finished = false; let dispatches = 0; let eventReads = 0;
  const router = new PersistentMultiRuntimeRouter({ store, endpointFactory: () => ({
    dispatch: async () => { dispatches++; return { remoteRunId: "run-http" }; },
    getRun: async () => ({ remoteRunId: "run-http", status: finished ? "completed" : "running", output: "persisted final output" }),
    events: async (_id, afterSeq) => {
      eventReads++;
      if (eventReads === 2) throw new Error("injected Host transport error");
      const events = [{ seq: 1, type: "assistant.streaming", data: { content: "preserved progress" }, createdAt: 1 },
        ...(finished ? [{ seq: 2, type: "run.completed", data: { output: "persisted final output" }, createdAt: 2 }] : [])];
      return events.filter((event) => event.seq > afterSeq);
    },
  }) });
  const assignment = await router.submit({ tenantId: session.principal.tenantId, ownerUserId: session.principal.userId, conversationId: "c", clientMessageId: "m", input: "fixture" });
  const server = createRouterHttpServer(router, { identity });
  const observerAbort = new AbortController();
  let stop = async () => {};
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/v1/assignments/${assignment.id}`;
    const assistant: Record<string, unknown> = { status: "running", text: "" };
    const applied: number[] = []; let reconnects = 0; let streamRequests = 0; const cursors: string[] = [];
    await observeAssignment({ baseUrl, headers: { authorization: `Bearer ${session.token}`, "x-tenant-id": "forged", "x-user-id": "forged" }, signal: observerAbort.signal,
      fetchImpl: async (url, init) => {
        if (String(url).includes("/stream")) {
          streamRequests++; cursors.push(new URL(String(url)).searchParams.get("afterSeq")!);
          if (streamRequests === 2) { finished = true; throw new TypeError("injected browser socket loss"); }
        }
        return fetch(url, init);
      },
      onEvent: (event) => { applied.push(event.seq); return projectAssistantEvent(assistant, event as unknown as Record<string, unknown>); },
      onRun: (run) => { assistant.status = run.status; assistant.text = run.output; },
      onConnection: (state) => { if (state === "reconnecting") { reconnects++; assert.equal(assistant.status, "running"); } }, wait: async () => {},
    });
    assert.equal(reconnects, 2); assert.deepEqual(cursors, ["0", "1"]); assert.deepEqual(applied, [1, 2]);
    assert.equal(assistant.status, "completed"); assert.equal(assistant.text, "persisted final output");
    assert.equal((await store.assignment(assignment.id))?.status, "completed");

    // A second accepted Run has no SSE client at all. Only the background observer updates it.
    const unobserved = await router.submit({ tenantId: session.principal.tenantId, ownerUserId: session.principal.userId, conversationId: "c2", clientMessageId: "m2", input: "fixture" });
    stop = startAssignmentReconciler(router);
    await stop();
    assert.equal((await store.assignment(unobserved.id))?.status, "completed"); assert.equal(dispatches, 2);
  } finally {
    observerAbort.abort(); await stop(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  }
});
