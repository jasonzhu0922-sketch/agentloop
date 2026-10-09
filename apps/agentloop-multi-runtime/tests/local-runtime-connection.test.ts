import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { AppDatabase } from "@zhujun/agentloop";
import { IdentityService } from "../src/router/identity/service.ts";
import { ControlPlaneStore } from "../src/router/persistence/control-plane-store.ts";
import { RouterService } from "../src/router/service/router-service.ts";
import { RuntimeCapacityError, RuntimeDispatchOutcomeUnknownError } from "../src/router/ports/control-plane-contracts.ts";
import { SqlDeviceRepository } from "../src/router/devices/device-service.ts";
import { LocalAgentRuntimeControl } from "../src/router/runtime-control/local-agent-runtime-control.ts";
import type { RuntimeDispatchEnvelope } from "../src/shared/contracts.ts";

test("Router dispatches a local Assignment through the authenticated device connection exactly once", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  const identity = new IdentityService(database);
  const devices = new SqlDeviceRepository(database);
  await store.ready();
  const owner = await identity.register("local-owner@example.test", "correct-horse-battery-7");
  const registration = await devices.issueRegistrationToken(owner.principal);
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const device = await devices.registerAgent({ registrationToken: registration.token, displayName: "test device", publicKey });
  const registry = new LocalAgentRuntimeControl(devices, store);
  const server = createServer();
  registry.attach(server);
  const runtimeId = "local-runtime-test";
  const dispatched: RuntimeDispatchEnvelope[] = [];
  let terminal = false;
  let socket: WebSocket | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/runtime-connections`, {
      headers: { authorization: `Bearer ${device.agentToken}` },
    });
    const readyMessage = nextMessage(socket);
    await once(socket, "open");
    const ready = await readyMessage;
    assert.equal(ready.type, "connection.ready");
    const helloAck = nextMessage(socket);
    socket.send(JSON.stringify({
      type: "agent.hello",
      deviceId: device.id,
      runtimes: [{ runtimeId, displayName: "文档分析", profile: "general", capabilities: [], maxConcurrentRuns: 1, status: "ready", catalogVersion: "1" }],
    }));
    assert.equal((await helloAck).type, "agent.hello.ack");
    const republishedAck = nextMessage(socket);
    socket.send(JSON.stringify({
      type: "agent.hello",
      deviceId: device.id,
      runtimes: [
        { runtimeId, displayName: "文档分析", profile: "general", capabilities: [], maxConcurrentRuns: 1, status: "ready", catalogVersion: "1" },
        { runtimeId: "local-runtime-second", displayName: "数据整理", profile: "general", capabilities: [], maxConcurrentRuns: 1, status: "ready", catalogVersion: "1" },
      ],
    }));
    assert.equal((await republishedAck).type, "agent.hello.ack");
    assert.equal(socket.readyState, WebSocket.OPEN, "republishing a complete catalog must not close its own connection");
    assert.deepEqual(
      (await store.runtimeCatalog(owner.principal.tenantId, owner.principal.userId)).filter((runtime) => runtime.kind === "local").map((runtime) => runtime.id).sort(),
      [runtimeId, "local-runtime-second"].sort(),
    );
    assert.equal((await store.runtimeCatalog(owner.principal.tenantId, owner.principal.userId)).find((runtime) => runtime.id === runtimeId)?.displayName, "文档分析");
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString()) as { type: string; messageId: string; method: string; payload: Record<string, unknown> };
      if (request.type !== "rpc.request") return;
      let result: unknown;
      const artifact = {
        id: "local-artifact-1", runId: "local-run-1", path: "local-artifact:local-artifact-1", name: "local-report.txt",
        bytes: 18, mimeType: "text/plain", role: "final" as const, sourceTool: "computer_write_file", previewable: true,
      };
      if (request.method === "dispatch") {
        dispatched.push(request.payload as unknown as RuntimeDispatchEnvelope);
        result = { remoteRunId: "local-run-1" };
      } else if (request.method === "getRun") {
        result = { remoteRunId: "local-run-1", status: terminal ? "completed" : "running", modelKey: "local-resolved-model", ...(terminal ? { output: "local final answer", finishedAt: 1234 } : {}) };
      } else if (request.method === "events") {
        result = terminal ? [{ seq: 1, type: "run.completed", data: { output: "local final answer" }, createdAt: 1234 }] : [];
      } else if (request.method === "artifacts") {
        result = [artifact];
      } else if (request.method === "readArtifact") {
        result = { artifact, contentBase64: Buffer.from("local artifact bytes").toString("base64") };
      } else {
        result = [];
      }
      socket!.send(JSON.stringify({ type: "rpc.response", messageId: request.messageId, ok: true, result }));
    });

    const router = new RouterService({
      store,
      endpointFactory: (endpoint) => registry.endpoint(endpoint.slice("local-runtime://".length)),
    });
    const other = await identity.register("other-local-owner@example.test", "correct-horse-battery-7");
    await assert.rejects(router.submit({
      tenantId: other.principal.tenantId,
      ownerUserId: other.principal.userId,
      conversationId: "forbidden-conversation",
      clientMessageId: "forbidden-message",
      input: "try another user's device",
      executionTarget: { kind: "local_device", deviceId: device.id, runtimeId },
      dataPolicy: { mode: "local" },
    }), RuntimeCapacityError);
    const task = {
      tenantId: owner.principal.tenantId,
      ownerUserId: owner.principal.userId,
      conversationId: "conversation-local",
      clientMessageId: "message-local",
      input: "read the approved folder",
      executionTarget: { kind: "local_device" as const, deviceId: device.id, runtimeId },
      dataPolicy: { mode: "local" as const },
      localDirectoryScopeIds: ["lds_opaque"],
      localUploadedSourceIds: ["src_0123456789abcdef0123456789abcdef"],
    };
    const assignment = await router.submit(task);
    const duplicate = await router.submit(task);
    assert.equal(assignment.id, duplicate.id);
    assert.equal(assignment.runtimeId, runtimeId);
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0]?.localDirectoryScopeIds, ["lds_opaque"]);
    assert.deepEqual(dispatched[0]?.localUploadedSourceIds, ["src_0123456789abcdef0123456789abcdef"]);

    terminal = true;
    assert.equal((await router.assignment(assignment.id))?.run?.status, "completed");
    const turn = await database.prepare("SELECT user_input, assistant_output, status, execution_location, model_key FROM mr_turns WHERE assignment_id = ?")
      .get(assignment.id) as { user_input: string; assistant_output: string; status: string; execution_location: string; model_key: string } | undefined;
    assert.equal(turn?.user_input, task.input);
    assert.equal(turn?.assistant_output, "local final answer");
    assert.equal(turn?.status, "completed");
    assert.equal(turn?.execution_location, "local");
    assert.equal(turn?.model_key, "local-resolved-model");
    const history = await store.conversation(owner.principal.tenantId, owner.principal.userId, task.conversationId);
    assert.equal(history?.turns[0]?.finalTurn?.assistantOutput, "local final answer");
    assert.equal(history?.turns[0]?.finalTurn?.modelKey, "local-resolved-model");
    assert.equal(history?.turns[0]?.assignment?.executionLocation, "local");
    assert.equal(history?.turns[0]?.assignment?.remoteRunId, "local-run-1");
    assert.deepEqual((await router.artifacts(assignment.id))?.artifacts.map((artifact) => artifact.id), ["local-artifact-1"]);
    const read = await router.readArtifact(assignment.id, "local-artifact-1");
    assert.equal(read?.artifact.name, "local-report.txt");
    assert.equal(Buffer.from(read?.content ?? []).toString("utf8"), "local artifact bytes");
  } finally {
    if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, "close");
      socket.close();
      await closed;
      for (let attempt = 0; attempt < 20; attempt++) {
        if ((await store.runtimeCatalog(owner.principal.tenantId, owner.principal.userId)).every((runtime) => runtime.kind !== "local" || runtime.status === "offline")) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  }
});

async function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  const [raw] = await once(socket, "message") as [Buffer];
  return JSON.parse(raw.toString()) as Record<string, unknown>;
}

test("lost Local Agent dispatch ACK retries the same Assignment and dispatch key", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  const now = Date.now();
  await store.registerLocalRuntime({
    runtimeId: "local-retry-runtime",
    deviceId: "device-retry",
    tenantId: "tenant-retry",
    ownerUserId: "user-retry",
    connectionId: "connection-retry",
    connectionEpoch: 1,
    profile: "general",
    capabilities: [],
    maxConcurrentRuns: 1,
    status: "ready",
    catalogVersion: "1",
    leaseExpiresAt: now + 20_000,
    now,
  });
  const envelopes: RuntimeDispatchEnvelope[] = [];
    const router = new RouterService({
    store,
    endpointFactory: () => ({
      async dispatch(envelope) {
        envelopes.push(envelope);
        if (envelopes.length === 1) throw new RuntimeDispatchOutcomeUnknownError("ack_lost");
        return { remoteRunId: "already-created-run" };
      },
    }),
    now: () => now + envelopes.length,
  });
  const task = {
    tenantId: "tenant-retry",
    ownerUserId: "user-retry",
    conversationId: "conversation-retry",
    clientMessageId: "message-retry",
    input: "retry without duplicate",
    executionTarget: { kind: "local_device" as const, deviceId: "device-retry", runtimeId: "local-retry-runtime" },
    dataPolicy: { mode: "local" as const },
  };
  try {
    await assert.rejects(router.submit(task), RuntimeDispatchOutcomeUnknownError);
    assert.equal((await store.assignment(envelopes[0]!.assignmentId))?.status, "reserved");
    const accepted = await router.submit(task);
    assert.equal(accepted.remoteRunId, "already-created-run");
    assert.equal(envelopes.length, 2);
    assert.equal(envelopes[0]?.assignmentId, envelopes[1]?.assignmentId);
    assert.equal(envelopes[0]?.dispatchKey, envelopes[1]?.dispatchKey);
  } finally {
    await database.close();
  }
});

test("dynamic Runtime registration cannot replace a cloud Host or another device Runtime", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{
    id: "protected-cloud-runtime",
    endpoint: "http://cloud-runtime",
    profile: "general",
    capabilities: [],
    maxConcurrentRuns: 1,
    activeRunCount: 0,
    status: "offline",
  }]);
  const local = {
    runtimeId: "protected-local-runtime",
    deviceId: "device-owner",
    tenantId: "tenant-owner",
    ownerUserId: "user-owner",
    connectionId: "connection-owner",
    connectionEpoch: 1,
    profile: "general" as const,
    capabilities: [],
    maxConcurrentRuns: 1,
    status: "ready" as const,
    catalogVersion: "1",
    leaseExpiresAt: Date.now() + 20_000,
  };
  try {
    await assert.rejects(store.registerLocalRuntime({ ...local, runtimeId: "protected-cloud-runtime" }), /runtime_id_conflict/);
    await store.registerLocalRuntime(local);
    await assert.rejects(store.registerLocalRuntime({
      ...local,
      deviceId: "device-attacker",
      connectionId: "connection-attacker",
      connectionEpoch: 2,
    }), /runtime_id_conflict/);
  } finally {
    await database.close();
  }
});
