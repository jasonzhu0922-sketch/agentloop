import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalAgentServer } from "../src/local-agent/local-agent-server.ts";

test("Local Agent stores browser uploads as sources in the selected Runtime without using Router attachment storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-agent-upload-"));
  const runtimeId = "local-runtime-upload";
  const router = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/device-agent/authorize-session") {
      response.setHeader("content-type", "application/json");
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
