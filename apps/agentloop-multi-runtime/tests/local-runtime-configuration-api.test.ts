import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { createLocalAgentServer } from "../local-agent-runtime/src/api/local-agent-api.ts";

test("loopback Runtime configuration supports empty extensions and redacts encrypted MCP credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-runtime-config-api-"));
  const defaultRuntimeId = "local-runtime-default";
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
      defaultRuntimeId,
      deviceIdentity: { publicKey: "unused", privateKey: "unused" },
      device: { id: "device-local", agentToken: "device-token", displayName: "test device" },
    }));
    await mkdir(join(root, "empty-skills"));
    await writeFile(join(root, "skill-directories.json"), JSON.stringify({
      schema: "agentloop.skillDirectories/v1",
      customSkillDirectories: [],
    }));
    const appRoot = join(process.cwd(), "apps", "agentloop-multi-runtime");
    const supervisorDatabasePath = join(root, "supervisor.db");
    agent = await createLocalAgentServer({
      appRoot,
      routerUrl: `http://127.0.0.1:${routerAddress.port}`,
      statePath: join(root, "state.json"),
      databasePath: join(root, "agentloop.db"),
      workspaceRoot: join(root, "shared-workspace"),
      skillPackageStoreRoot: join(root, "skill-packages"),
      runtimeDataRoot: join(root, "runtimes"),
      supervisorDatabasePath,
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
    const request = async (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${agentAddress.port}${path}`, {
      ...init,
      headers: { origin: "http://web.test", "x-local-session": "s".repeat(32), ...init.headers },
    });

    const skillZip = new JSZip();
    skillZip.file("uploaded-review/SKILL.md", [
      "---",
      "name: uploaded-review",
      "description: Uploaded review workflow.",
      "---",
      "",
      "Review the supplied content.",
    ].join("\n"));
    const skillArchive = await skillZip.generateAsync({ type: "nodebuffer" });
    const unsafeZip = new JSZip();
    unsafeZip.file("../escaped/SKILL.md", "---\nname: escaped\ndescription: invalid\n---\n");
    const unsafeArchive = await unsafeZip.generateAsync({ type: "nodebuffer" });
    const unsafeResponse = await request("/v1/local-skill-package-uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ originalName: "unsafe.zip", contentBase64: unsafeArchive.toString("base64") }),
    });
    assert.equal(unsafeResponse.status, 400);
    assert.deepEqual(await unsafeResponse.json(), { error: "skill_upload_invalid" });

    const uploadResponse = await request("/v1/local-skill-package-uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ originalName: "uploaded-review.zip", contentBase64: skillArchive.toString("base64") }),
    });
    assert.equal(uploadResponse.status, 201);
    const uploaded = await uploadResponse.json() as { skill: { packageId: string; sourceKind: string } };
    assert.equal(uploaded.skill.sourceKind, "uploaded");

    const mcpTestResponse = await request("/v1/local-mcp-servers/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server: {
        displayName: "Unavailable local test",
        key: "unavailable-local-test",
        transport: "http",
        url: "http://127.0.0.1:9/mcp",
        timeoutMs: 500,
        auth: { kind: "none" },
      } }),
    });
    assert.equal(mcpTestResponse.status, 200);
    const mcpTest = await mcpTestResponse.json() as { ok: boolean; stage: string };
    assert.deepEqual({ ok: mcpTest.ok, stage: mcpTest.stage }, { ok: false, stage: "connection" });

    const createdResponse = await request("/v1/local-runtimes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Contract Runtime" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { runtime: { id: string }; configuration: { skills: unknown[]; mcpServers: unknown[] } };
    assert.deepEqual(created.configuration.skills, []);
    assert.deepEqual(created.configuration.mcpServers, []);

    const specializedResponse = await request("/v1/local-runtimes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Uploaded Skill Runtime", skills: [{ packageId: uploaded.skill.packageId }] }),
    });
    assert.equal(specializedResponse.status, 201);
    const specialized = await specializedResponse.json() as { configuration: { skills: Array<{ packageId: string }> } };
    assert.deepEqual(specialized.configuration.skills.map((skill) => skill.packageId), [uploaded.skill.packageId]);

    const runningUpdate = await request(`/v1/local-runtimes/${created.runtime.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills: [], mcpServers: [] }),
    });
    assert.equal(runningUpdate.status, 409);
    assert.deepEqual(await runningUpdate.json(), { error: "runtime_must_be_stopped_for_configuration" });

    assert.equal((await request(`/v1/local-runtimes/${created.runtime.id}/stop`, { method: "POST" })).status, 200);
    const token = "never-return-this-token";
    const updateResponse = await request(`/v1/local-runtimes/${created.runtime.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Contract Review Runtime",
        skills: [],
        mcpServers: [{
          displayName: "Contract source",
          key: "contract-source",
          transport: "http",
          url: "http://127.0.0.1:9444/mcp",
          auth: { kind: "bearer", token },
        }],
      }),
    });
    assert.equal(updateResponse.status, 200);
    const updated = await updateResponse.json() as { runtime: { displayName: string }; configuration: unknown };
    assert.equal(updated.runtime.displayName, "Contract Review Runtime");
    assert.equal(JSON.stringify(updated).includes(token), false);

    const readResponse = await request(`/v1/local-runtimes/${created.runtime.id}/configuration`);
    assert.equal(readResponse.status, 200);
    const saved = await readResponse.json() as { configuration: { mcpServers: Array<{ auth: unknown }> } };
    assert.deepEqual(saved.configuration.mcpServers[0]?.auth, { kind: "bearer", credentialConfigured: true });
    assert.equal((await readFile(supervisorDatabasePath)).includes(Buffer.from(token)), false);
  } finally {
    if (agent !== undefined) {
      agent.closeAllConnections();
      await new Promise<void>((resolve) => agent!.close(() => resolve()));
    }
    router.closeAllConnections();
    await new Promise<void>((resolve) => router.close(() => resolve()));
    await makeTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

async function makeTreeWritable(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(path, 0o700).catch(() => undefined);
    for (const entry of await readdir(path).catch(() => [])) await makeTreeWritable(join(path, entry));
  } else await chmod(path, 0o600).catch(() => undefined);
}
