import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase, RunService, SkillService } from "@zhujun/agentloop";
import type { ConnectorModule } from "@zhujun/agentloop-connector-sdk";
import { WebSocketServer, type WebSocket } from "ws";
import { createLocalAgentServer } from "../local-agent-runtime/src/api/local-agent-api.ts";
import { LocalAgentService } from "../local-agent-runtime/src/service/local-agent-service.ts";
import { LocalConnectorConfigurationStore } from "../local-agent-runtime/src/persistence/local-connector-configuration-store.ts";
import { EncryptedLocalRuntimeSecretStore } from "../local-agent-runtime/src/persistence/encrypted-local-runtime-secret-store.ts";
import { ConnectorRegistry, ConnectorRuntimeService } from "../src/connectors/index.ts";

test("an arbitrary Connector capability reaches the normal planner without provider-specific routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-capability-discovery-"));
  const database = new AppDatabase(":memory:");
  try {
    const capabilityId = "custom_inventory.inspect";
    const definition = {
      manifest: { schema: "agentloop.connectorManifest/v1" as const, key: "unseen-provider", version: "0.1.0", displayName: "Custom inventory", description: "Synthetic discovery fixture", agentloopSdk: "^0.1.0" },
      capabilities: [{ id: capabilityId, category: "read" as const, label: "Inspect inventory", description: "Inspect the authorized inventory", risk: "low" as const, replaySafe: true }],
    };
    const operations = [{ id: "inspect", capabilityId, mode: "read" as const, inputSchema: { type: "object" as const }, executionMode: "parallel" as const, replaySafe: true }];
    const module: ConnectorModule = {
      definition,
      connect: async ({ connection }) => ({ definition, connection, operations,
        execute: async () => { throw new Error("Discovery must not invoke the connector"); }, mapEvidence: () => [],
      }),
      project: async () => ({ connectorKey: definition.manifest.key, connectorVersion: "0.1.0", capabilities: definition.capabilities, operations, runtimeTools: [] }),
    };
    const registry = new ConnectorRegistry();
    registry.register(module);
    const connectorRuntime = new ConnectorRuntimeService(registry, {
      resolver: { resolve: async (id) => ({ id, connectorKey: definition.manifest.key, ownerType: "user", ownerId: "owner", scopes: [], credentialRef: "fixture", status: "active" }) },
      credentialProvider: { get: async () => ({}) },
    });
    let inspected = false;
    const runs = new RunService({
      database, skills: new SkillService(database), workspaceRoot: root, runToolProvider: connectorRuntime,
      modelFactory: () => ({ limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
        complete: async () => { throw new Error("No model invocation is needed to test planner input"); },
      }),
      plannerFactory: () => ({ plan: async (task) => {
        const capability = task.availableCapabilities?.find((item) => item.id === capabilityId);
        assert.ok(capability, "the capability must be discoverable from the Connector's declaration");
        assert.deepEqual(capability.sourceIds, ["connector.unseen-provider.connection-custom"]);
        assert.ok(task.availableTools?.some((tool) => tool.source?.transport === "connector"
          && tool.source.capabilities.some((item) => item.id === capabilityId)));
        inspected = true;
        throw new Error("catalog_checked");
      } }),
    });
    await assert.rejects(runs.execute("owner", "Inspect the available inventory", { connectorConnectionIds: ["connection-custom"] }));
    const failure = await database.prepare("SELECT payload_json FROM run_events WHERE type = 'run.failed'").get() as { payload_json: string } | undefined;
    assert.equal(inspected, true, failure?.payload_json ?? "planner input was not inspected");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Local Agent loads only its enabled connections and preserves selection through Router RPC and strict-local HTTP", { timeout: 20_000 }, async (t) => {
  for (const method of ["completeWpsAuthorization", "completeFeishuAuthorization"] as const) {
    t.mock.method(LocalAgentService.prototype, method, async () => ({ origin: "http://localhost:5174", attemptId: "oauth-attempt" }));
  }
  const root = await mkdtemp(join(tmpdir(), "agentloop-connector-admission-"));
  const runtimeId = "mail-runtime";
  const appRoot = new URL("../", import.meta.url).pathname;
  const starts: Array<{ connectorConnectionIds?: readonly string[] }> = [];
  // Stop at the kernel admission boundary: no model or email network requests.
  t.mock.method(RunService.prototype, "startConversation", async (_owner: string, _input: unknown, options?: { connectorConnectionIds?: readonly string[] }) => {
    starts.push(options ?? {});
    return { id: `run-${starts.length}`, status: "completed", createdAt: Date.now() };
  });
  const router = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ session: { ownerUserId: "owner" } }));
  });
  const sockets = new WebSocketServer({ server: router });
  let agent: Server | undefined;
  let socket: WebSocket | undefined;
  const connected = new Promise<WebSocket>((resolve) => sockets.once("connection", (connectedSocket) => {
    connectedSocket.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "agent.hello") {
        connectedSocket.send(JSON.stringify({ type: "agent.hello.ack" }));
        resolve(connectedSocket);
      }
    });
    connectedSocket.send(JSON.stringify({ type: "connection.ready" }));
  }));
  try {
    await mkdir(join(root, "empty-skills"));
    await writeFile(join(root, "state.json"), JSON.stringify({
      defaultRuntimeId: runtimeId,
      device: { id: "test-device", agentToken: "fixture-only-token" },
    }));
    const database = new AppDatabase(join(root, "supervisor.db"));
    let connectionId: string;
    let credentialRefs: readonly string[];
    try {
      const store = new LocalConnectorConfigurationStore(database, new EncryptedLocalRuntimeSecretStore(join(root, "runtime-secrets")));
      await store.ready();
      const modulePath = new URL("../../../packages/connector-126-mail/src/index.ts", import.meta.url).pathname;
      const saved = await store.upsert(runtimeId, {
        connectorKey: "126-mail", displayName: "Mail", modulePath,
        exportName: "createConfigured126MailConnector", credentials: { email: "fixture@126.com", authorizationCode: "fixture" },
      });
      connectionId = `local_connection_${saved.id}`;
      // These invalid modules must never be loaded or selected by this Runtime.
      await store.upsert(runtimeId, { connectorKey: "disabled", displayName: "Disabled", modulePath: "/nonexistent-disabled.ts", enabled: false, credentials: { token: "disabled-fixture" } });
      await store.upsert("other-runtime", { connectorKey: "other", displayName: "Other Runtime", modulePath: "/nonexistent-other.ts", credentials: { token: "other-fixture" } });
      credentialRefs = await store.secretStorageKeys();
      assert.equal(credentialRefs.length, 3);
    } finally { database.close(); }
    router.listen(0, "127.0.0.1");
    await once(router, "listening");
    const address = router.address();
    assert.ok(address && typeof address !== "string");
    agent = await createLocalAgentServer({
      appRoot, routerUrl: `http://127.0.0.1:${address.port}`, webOrigin: "http://web.test",
      statePath: join(root, "state.json"), databasePath: join(root, "agentloop.db"),
      workspaceRoot: join(root, "workspace"), skillPackageStoreRoot: join(root, "packages"),
      supervisorDatabasePath: join(root, "supervisor.db"),
      providerConfigPath: join(appRoot, "config/llm-providers.json"),
      skillDirectoriesConfigPath: join(root, "unused-skills.json"),
      stepExecutionStrategyConfigPath: join(appRoot, "config/step-execution-strategy.json"),
      environment: { AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: join(root, "empty-skills") },
      integrationEnvironment: { WEB_SEARCH_DISABLED: "1" },
    });
    const reopenedSecrets = new EncryptedLocalRuntimeSecretStore(join(root, "runtime-secrets"));
    for (const reference of credentialRefs!) {
      assert.ok(await reopenedSecrets.read(reference), "startup must preserve every retained Connector credential, not only MCP secrets");
    }
    agent.listen(0, "127.0.0.1");
    await once(agent, "listening");
    const agentAddress = agent.address();
    assert.ok(agentAddress && typeof agentAddress !== "string");
    socket = await connected;

    // Callback identity must match the catalog key used by the common UI
    // listener; otherwise authorization succeeds but the binding stays busy.
    for (const key of ["kingsoft-wps", "feishu"]) {
      const callback = await fetch(`http://127.0.0.1:${agentAddress.port}/v1/local-connectors/${key}/callback`);
      assert.equal(callback.status, 200);
      const html = await callback.text();
      assert.ok(html.includes(`"source":"agentloop-${key}-oauth"`));
      assert.ok(html.includes('"attemptId":"oauth-attempt"'));
      assert.ok(html.includes('"http://localhost:5174"'));
    }

    const selections = [undefined, [], [connectionId!]];
    for (const [index, selection] of selections.entries()) {
      const payload = {
        schema: "agentloop.runtimeDispatch/v1", assignmentId: `assignment-${index}`, dispatchKey: `dispatch-${index}`,
        subject: { tenantId: "tenant", userId: "owner" }, conversationId: `rpc-conversation-${index}`, input: "Inspect tools only",
        executionTarget: { kind: "local_device", deviceId: "test-device", runtimeId },
        requestedModelKey: "local:fixture", allowDangerousTools: false, resourceRefs: [],
        ...(selection === undefined ? {} : { connectorConnectionIds: selection }),
      };
      const result = await new Promise<{ ok: boolean; result: unknown; error?: string }>((resolve) => {
        const receive = (raw: Buffer) => {
          const message = JSON.parse(raw.toString());
          if (message.type === "rpc.response" && message.messageId === `message-${index}`) {
            socket!.off("message", receive);
            resolve(message);
          }
        };
        socket!.on("message", receive);
        socket!.send(JSON.stringify({ type: "rpc.request", messageId: `message-${index}`, runtimeId, method: "dispatch", payload }));
      });
      assert.equal(result.ok, true, result.error ?? "dispatch failed");
      assert.deepEqual(starts.at(-1)?.connectorConnectionIds, selection ?? [connectionId!]);

      const response: Response = await fetch(`http://127.0.0.1:${agentAddress.port}/v1/strict-local-runs`, {
        method: "POST", headers: { origin: "http://web.test", "content-type": "application/json", "x-local-session": "s".repeat(32) },
        body: JSON.stringify({ runtimeId, conversationId: `strict-conversation-${index}`, clientMessageId: `strict-message-${index}`,
          input: "Inspect tools only", requestedModelKey: "local:fixture", allowDangerousTools: false,
          ...(selection === undefined ? {} : { connectorConnectionIds: selection }),
        }),
      });
      assert.equal(response.status, 202, await response.text());
      assert.deepEqual(starts.at(-1)?.connectorConnectionIds, selection ?? [connectionId!]);
    }
    assert.equal(starts.length, 6);
  } finally {
    if (agent !== undefined) {
      agent.closeAllConnections();
      await new Promise<void>((resolve) => agent!.close(() => resolve()));
    }
    sockets.clients.forEach((client) => client.terminate());
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    router.closeAllConnections();
    await new Promise<void>((resolve) => router.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
