import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { IdentityService } from "../src/router/identity/service.ts";
import { ConversationDeleteConflictError } from "../src/router/persistence/control-plane-store.ts";
import { SqlDeviceRepository } from "../src/router/devices/device-service.ts";
import type { SubmitConversationTask } from "../src/shared/contracts.ts";
import { SharedWorkspaceArtifactCatalog } from "../src/router/artifacts/shared-workspace-artifact-catalog.ts";
import { createRouterHttpServer } from "../src/router/api/router-api.ts";

test("Router derives task identity and accepts opaque local Runtime placement", async () => {
  const database = new AppDatabase(":memory:");
  const identity = new IdentityService(database);
  const session = await identity.register("owner@example.test", "correct-horse-battery-7");
  let submitted: SubmitConversationTask | undefined;
  let deleted: { tenantId: string; ownerUserId: string; conversationId: string } | undefined;
  const router = {
    async submit(task: SubmitConversationTask) {
      submitted = task;
      return { id: "assignment-1", tenantId: task.tenantId, ownerUserId: task.ownerUserId };
    },
    async deleteConversation(tenantId: string, ownerUserId: string, conversationId: string) {
      if (conversationId === "active-conversation") throw new ConversationDeleteConflictError();
      deleted = { tenantId, ownerUserId, conversationId };
    },
    async assignment() { return undefined; },
  };
  const server = createRouterHttpServer(router, { identity });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;

    const unauthenticated = await fetch(`${base}/v1/conversations`, {
      headers: { "x-tenant-id": session.principal.tenantId, "x-user-id": session.principal.userId },
    });
    assert.equal(unauthenticated.status, 401);

    const deletedResponse = await fetch(`${base}/v1/conversations/conversation-to-delete`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(deletedResponse.status, 204);
    assert.deepEqual(deleted, {
      tenantId: session.principal.tenantId,
      ownerUserId: session.principal.userId,
      conversationId: "conversation-to-delete",
    });

    const activeDelete = await fetch(`${base}/v1/conversations/active-conversation`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(activeDelete.status, 409);
    assert.deepEqual(await activeDelete.json(), { error: "conversation_active_runs_prevent_delete" });

    const created = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
        "x-tenant-id": "attacker-tenant",
        "x-user-id": "attacker-user",
      },
      body: JSON.stringify({ conversationId: "c1", clientMessageId: "m1", input: "hello" }),
    });
    assert.equal(created.status, 202);
    assert.equal(submitted?.tenantId, session.principal.tenantId);
    assert.equal(submitted?.ownerUserId, session.principal.userId);
    assert.deepEqual(submitted?.executionTarget, { kind: "cloud_pool" });
    assert.deepEqual(submitted?.dataPolicy, { mode: "cloud" });

    const forgedBodyIdentity = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "attacker-tenant", ownerUserId: "attacker-user", conversationId: "c1", clientMessageId: "m2", input: "hello" }),
    });
    assert.equal(forgedBodyIdentity.status, 400);

    const localOnCloudRouter = await fetch(`${base}/v2/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        schema: "agentloop.task/v2",
        conversationId: "c1",
        clientMessageId: "m3",
        input: "read my folder",
        executionTarget: { kind: "local_device", deviceId: "device-1", runtimeId: "local-runtime-1" },
        dataPolicy: { mode: "local" },
        localDirectoryScopeIds: ["lds_opaque"],
        localUploadedSourceIds: ["src_0123456789abcdef0123456789abcdef"],
      }),
    });
    assert.equal(localOnCloudRouter.status, 202);
    assert.deepEqual(submitted?.executionTarget, { kind: "local_device", deviceId: "device-1", runtimeId: "local-runtime-1" });
    assert.deepEqual(submitted?.dataPolicy, { mode: "local" });
    assert.deepEqual(submitted?.localDirectoryScopeIds, ["lds_opaque"]);
    assert.deepEqual(submitted?.localUploadedSourceIds, ["src_0123456789abcdef0123456789abcdef"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  }
});

test("identity registration hashes credentials, normalizes email, and revokes bearer sessions", async () => {
  const database = new AppDatabase(":memory:");
  const identity = new IdentityService(database);
  try {
    const session = await identity.register("  USER@example.test ", "a-long-password-123");
    assert.equal(session.principal.email, "user@example.test");
    assert.equal((await identity.authenticate(`Bearer ${session.token}`)).userId, session.principal.userId);
    await assert.rejects(identity.login("user@example.test", "incorrect-password"), /Invalid email or password/);
    await identity.revoke(`Bearer ${session.token}`);
    await assert.rejects(identity.authenticate(`Bearer ${session.token}`), /invalid or expired/i);
  } finally {
    await database.close();
  }
});

test("Web removes a left-list conversation only after its owning persistent data planes acknowledge deletion", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  assert.match(app, /async function deleteConversation\(conversationId\)/);
  assert.match(app, /deletingConversationIds\.add\(conversationId\)/);
  assert.match(app, /fetch\(`\$\{api\}\/v1\/conversations\/\$\{encodeURIComponent\(conversationId\)\}`, \{ method: "DELETE"/);
  assert.match(app, /localAgentFetch\(`\/v1\/local-runtimes\/\$\{encodeURIComponent\(runtimeId\)\}\/conversations\/\$\{encodeURIComponent\(conversationId\)\}`, \{ method: "DELETE"/);
  assert.match(app, /await Promise\.all\(deletions\);\n    sessions = sessions\.filter\(\(item\) => item\.id !== conversationId\);/);
});

test("authenticated Web receives only a compatible signed Local Agent release manifest", async () => {
  const database = new AppDatabase(":memory:");
  const identity = new IdentityService(database);
  const session = await identity.register("release-owner@example.test", "correct-horse-battery-7");
  const router = { async submit() { throw new Error("not used"); }, async assignment() { return undefined; } };
  const server = createRouterHttpServer(router, {
    identity,
    localAgentReleases: [{
      version: "1.2.3", protocolVersion: "1", platform: "darwin", arch: "arm64",
      downloadUrl: "https://downloads.example.test/agentloop-local-agent-1.2.3.pkg",
      sha256: "a".repeat(64), signature: "minisign:example",
      launchUrl: "agentloop-local-runtime://start",
    }],
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/v1/local-agent/releases/latest?platform=darwin&arch=arm64`)).status, 401);
    const response = await fetch(`${base}/v1/local-agent/releases/latest?platform=darwin&arch=arm64`, { headers: { authorization: `Bearer ${session.token}` } });
    assert.equal(response.status, 200);
    const body = await response.json() as { protocolVersion: string; releases: Array<{ version: string; sha256: string }> };
    assert.equal(body.protocolVersion, "1");
    assert.deepEqual(body.releases, [{ version: "1.2.3", protocolVersion: "1", platform: "darwin", arch: "arm64", downloadUrl: "https://downloads.example.test/agentloop-local-agent-1.2.3.pkg", sha256: "a".repeat(64), signature: "minisign:example", launchUrl: "agentloop-local-runtime://start" }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  }
});

test("Web manages a paired Local Agent through Router control rather than loopback", async () => {
  const database = new AppDatabase(":memory:");
  const identity = new IdentityService(database);
  const session = await identity.register("agent-control-owner@example.test", "correct-horse-battery-7");
  const calls: Array<{ deviceId: string; method: string; payload?: Record<string, unknown>; tenantId: string; ownerUserId: string }> = [];
  const router = { async submit() { throw new Error("not used"); }, async assignment() { return undefined; } };
  const server = createRouterHttpServer(router, {
    identity,
    localAgentControl: {
      async agentControl(input) {
        calls.push(input);
        return (input.method === "agent.runtimes.create" ? { runtime: { id: "local-second", displayName: input.payload?.displayName } } : { runtimes: [] }) as never;
      },
    },
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/devices/device-owned/local-agent/runtimes`, {
      method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ displayName: "研究助理" }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(calls, [{
      tenantId: session.principal.tenantId, ownerUserId: session.principal.userId, deviceId: "device-owned",
      method: "agent.runtimes.create", payload: { displayName: "研究助理" },
    }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  }
});

test("a Local Runtime Agent consumes one user-approved registration token and can be revoked", async () => {
  const database = new AppDatabase(":memory:");
  const identity = new IdentityService(database);
  const devices = new SqlDeviceRepository(database);
  try {
    const owner = await identity.register("owner@example.test", "correct-horse-battery-7");
    const other = await identity.register("other@example.test", "correct-horse-battery-7");
    const authorization = await devices.issueRegistrationToken(owner.principal);
    const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const agent = await devices.registerAgent({
      registrationToken: authorization.token, displayName: "朱军的 MacBook Pro", publicKey,
    });
    assert.equal(agent.status, "active");
    assert.deepEqual((await devices.list(owner.principal)).map((device) => device.id), [agent.id]);
    assert.deepEqual(await devices.list(other.principal), []);
    await assert.rejects(devices.registerAgent({
      registrationToken: authorization.token, displayName: "second agent", publicKey,
    }), /invalid or expired/);
    assert.equal((await devices.heartbeat(agent.agentToken)).id, agent.id);
    const localSession = await devices.issueLocalSession(owner.principal, agent.id);
    const authorized = await devices.authorizeLocalSession(agent.agentToken, localSession.token);
    assert.equal(authorized.ownerUserId, owner.principal.userId);
    assert.equal(authorized.deviceId, agent.id);
    assert.ok(localSession.expiresAt >= Date.now() + (6 * 24 * 60 * 60 * 1000), "local Agent authorization should last with the user login, not two minutes");
    const refreshedLocalSession = await devices.issueLocalSession(owner.principal, agent.id);
    assert.notEqual(refreshedLocalSession.token, localSession.token);
    await assert.rejects(devices.authorizeLocalSession(agent.agentToken, localSession.token), /invalid or expired/i);
    assert.equal((await devices.authorizeLocalSession(agent.agentToken, refreshedLocalSession.token)).ownerUserId, owner.principal.userId);
    await assert.rejects(devices.authorizeLocalSession("invalid-agent-token-which-is-long-enough-123456", localSession.token), /not authorized|invalid/i);
    await devices.revoke(owner.principal, agent.id);
    await assert.rejects(devices.heartbeat(agent.agentToken), /not authorized/);
  } finally {
    await database.close();
  }
});

test("Router artifact catalog reads a verified shared-workspace artifact without the original Host", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-artifact-catalog-"));
  const database = new AppDatabase(":memory:");
  try {
    // Simulate the catalog schema created by the first implementation, before
    // artifact identity was correctly scoped to its Assignment.
    await database.exec(`
      CREATE TABLE mr_artifacts (
        id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL, remote_run_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL,
        byte_size INTEGER NOT NULL, mime_type TEXT NOT NULL, role TEXT NOT NULL, source_tool TEXT NOT NULL,
        previewable INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(assignment_id, id)
      );
      CREATE INDEX mr_artifacts_assignment_idx ON mr_artifacts(assignment_id, created_at);
    `);
    const conversationRoot = join(root, "conversations", "conversation-1");
    await mkdir(conversationRoot, { recursive: true });
    await writeFile(join(conversationRoot, "report.md"), "# Durable report\n");
    const secondConversationRoot = join(root, "conversations", "conversation-2");
    await mkdir(secondConversationRoot, { recursive: true });
    await writeFile(join(secondConversationRoot, "report.md"), "# Separate report\n");
    const catalog = new SharedWorkspaceArtifactCatalog(database, root);
    await catalog.capture({
      assignmentId: "assignment-1", tenantId: "tenant-1", ownerUserId: "user-1", conversationId: "conversation-1", remoteRunId: "run-1",
      artifacts: [{ id: "artifact-1", runId: "run-1", path: "report.md", name: "report.md", bytes: 17, mimeType: "text/markdown", role: "final", sourceTool: "computer_write_file", previewable: true }],
    });
    await catalog.capture({
      assignmentId: "assignment-2", tenantId: "tenant-2", ownerUserId: "user-2", conversationId: "conversation-2", remoteRunId: "run-2",
      artifacts: [{ id: "artifact-1", runId: "run-2", path: "report.md", name: "report.md", bytes: 18, mimeType: "text/markdown", role: "final", sourceTool: "computer_write_file", previewable: true }],
    });
    const read = await catalog.read("assignment-1", "artifact-1");
    assert.equal(Buffer.from(read?.content ?? []).toString("utf8"), "# Durable report\n");
    assert.equal((await catalog.list("assignment-1"))[0]?.sha256.length, 64);
    assert.equal(Buffer.from((await catalog.read("assignment-2", "artifact-1"))?.content ?? []).toString("utf8"), "# Separate report\n");
    await writeFile(join(conversationRoot, "report.md"), "tampered content\n");
    await assert.rejects(catalog.read("assignment-1", "artifact-1"), /artifact_(unavailable|integrity_mismatch)/);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
