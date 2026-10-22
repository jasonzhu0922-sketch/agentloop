import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalAgentServer } from "../local-agent-runtime/src/api/local-agent-api.ts";
import { createLocalAgentClient } from "../web/client/local-runtime/local-agent-client.js";

test("Local Agent stores browser uploads as sources in the selected Runtime without using Router attachment storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-agent-upload-"));
  const runtimeId = "local-runtime-upload";
  const router = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/device-agent/authorize-session") {
      response.setHeader("content-type", "application/json");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (JSON.parse(Buffer.concat(chunks).toString()).sessionToken === "expired".repeat(8)) {
        response.statusCode = 401;
        response.end(JSON.stringify({ code: "local_session_invalid", error: "Local Runtime session is invalid or expired" }));
        return;
      }
      response.end(JSON.stringify({ session: { ownerUserId: "local-owner" } }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  let agent: ReturnType<typeof createServer> | undefined;
  try {
    router.listen(0, "127.0.0.1");
    await once(router, "listening");
    const routerAddress = router.address();
    assert.ok(routerAddress !== null && typeof routerAddress !== "string");
    await writeFile(join(root, "state.json"), JSON.stringify({
      defaultRuntimeId: runtimeId,
      deviceIdentity: { publicKey: "unused", privateKey: "unused" },
      device: { id: "device-local", agentToken: "device-token", displayName: "test device" },
    }));
    await mkdir(join(root, "empty-skills"));
    await writeFile(join(root, "skill-directories.json"), JSON.stringify({
      schema: "agentloop.skillDirectories/v1",
      customSkillDirectories: [],
    }));
    const appRoot = join(process.cwd(), "apps", "agentloop-multi-runtime");
    agent = await createLocalAgentServer({
      appRoot,
      routerUrl: `http://127.0.0.1:${routerAddress.port}`,
      statePath: join(root, "state.json"),
      databasePath: join(root, "agentloop.db"),
      workspaceRoot: join(root, "shared-workspace"),
      skillPackageStoreRoot: join(root, "skill-packages"),
      runtimeDataRoot: join(root, "runtimes"),
      supervisorDatabasePath: join(root, "supervisor.db"),
      providerConfigPath: join(appRoot, "config", "llm-providers.json"),
      skillDirectoriesConfigPath: join(root, "skill-directories.json"),
      stepExecutionStrategyConfigPath: join(appRoot, "config", "step-execution-strategy.json"),
      webOrigin: "http://web.test",
      environment: { WEB_SEARCH_DISABLED: "1", AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: join(root, "empty-skills") },
    });
    agent.listen(0, "127.0.0.1");
    await once(agent, "listening");
    const agentAddress = agent.address();
    assert.ok(agentAddress !== null && typeof agentAddress !== "string");
    let token = "expired".repeat(8);
    let refreshes = 0;
    const client = createLocalAgentClient({
      baseUrl: `http://127.0.0.1:${agentAddress.port}`,
      session: {
        ensureValid: async () => {}, token: () => token,
        refresh: async () => { refreshes++; token = "s".repeat(32); },
      },
    });
    const settings = await client.request("/v1/local-models/configuration", { headers: { origin: "http://web.test" } });
    assert.equal(settings.status, 200, "settings must renew a session rejected by the real Router error contract");
    assert.equal(refreshes, 1);
    assert.ok((await settings.json() as { configuration?: unknown }).configuration);
    const preflight = await fetch(`http://127.0.0.1:${agentAddress.port}/healthz`, {
      method: "OPTIONS",
      headers: {
        origin: "http://web.test",
        "access-control-request-method": "GET",
        "access-control-request-private-network": "true",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://web.test");
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
    const deniedPreflight = await fetch(`http://127.0.0.1:${agentAddress.port}/healthz`, {
      method: "OPTIONS",
      headers: { origin: "http://untrusted.test", "access-control-request-private-network": "true" },
    });
    assert.equal(deniedPreflight.headers.get("access-control-allow-origin"), null);
    assert.equal(deniedPreflight.headers.get("access-control-allow-private-network"), null);
    const response = await fetch(`http://127.0.0.1:${agentAddress.port}/v1/uploads`, {
      method: "POST",
      headers: { origin: "http://web.test", "content-type": "application/json", "x-local-session": "s".repeat(32) },
      body: JSON.stringify({
        runtimeId,
        conversationId: "conversation-local-upload",
        originalName: "brief.txt",
        mediaType: "text/plain",
        contentBase64: Buffer.from("local-only source content\n").toString("base64"),
      }),
    });
    assert.equal(response.status, 201);
    const result = await response.json() as { runtimeId: string; source: { id: string; originalName: string; status: string } };
    assert.equal(result.runtimeId, runtimeId);
    assert.equal(result.source.originalName, "brief.txt");
    assert.equal(result.source.status, "ready");
    const sourcePath = join(root, "uploads", "default", "users", "user-local-owner", "conversations", "conversation-local-upload", "sources", result.source.id, "original");
    assert.equal(await readFile(sourcePath, "utf8"), "local-only source content\n");
  } finally {
    if (agent !== undefined) {
      agent.closeAllConnections();
      await new Promise<void>((resolve) => agent!.close(() => resolve()));
    }
    router.closeAllConnections();
    await new Promise<void>((resolve) => router.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
