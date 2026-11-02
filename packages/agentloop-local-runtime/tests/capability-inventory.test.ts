import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalRuntimeFactory } from "@zhujun/agentloop-local-runtime/host";
import { greetingModel, modelPort } from "./fixtures/models.ts";

test("shared Factory carries configured MCP knowledge into a tool-free reply and persisted evidence", async t => {
  const root = await mkdtemp(join(tmpdir(), "shared-capability-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skills = join(root, "skills"); await mkdir(skills);
  const goal = "列出所有已配置的 MCP 服务及其能力。";
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request.method);
    assert.notEqual(request.method, "tools/call", "inventory knowledge must not invoke MCP tools");
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = request.method === "tools/list"
      ? { tools: [{ name: "archive_search", description: "Search archive records.", inputSchema: {
        type: "object", properties: { privateInputField: { type: "string" } },
      } }] }
      : { protocolVersion: "2025-06-18" };
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  let resolverSawInventory = false;
  let replySawInventory = false;
  const base = greetingModel();
  const models = modelPort({
    limits: base.limits,
    async complete(input, signal) {
      const response = await base.complete(input, signal);
      if (input.tools.some(tool => tool.name === "resolve_conversation_turn")) {
        const content = input.runtimeContext!.content;
        assert.match(content, /runtime_configured/);
        assert.match(content, /Archive service/);
        resolverSawInventory = true;
        const toolCalls = response.toolCalls.map(call => ({ ...call, arguments: {
          ...(call.arguments as Record<string, unknown>), effectiveGoal: goal,
          taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: false,
            deliverables: [{ targetId: "inventory", purpose: goal, expectedArtifactCount: 1,
              action: "none", kind: "none", surface: "conversation" }] },
        } }));
        return { ...response, toolCalls };
      }
      if (input.tools.some(tool => tool.name === "submit_assessment")) return response;
      assert.deepEqual(input.tools, []);
      const content = input.runtimeContext!.content;
      assert.match(content, /runtime_configured/);
      assert.match(content, /loaded_for_runtime/);
      assert.match(content, /Archive service/);
      assert.match(content, /archive_search/);
      for (const privateValue of ["private-source-id", "private-alias", "mcp.example.test", "fixture-secret", "privateInputField"]) {
        assert.equal(content.includes(privateValue), false, `${privateValue} must not enter inventory reply context`);
      }
      replySawInventory = true;
      return { content: "已配置 Archive service，可检索归档记录；未执行检索。", finishReason: "stop", toolCalls: [] };
    },
  });
  const factory = new LocalRuntimeFactory({ databasePath: join(root, "runtime.db"),
    skillPackageStoreRoot: join(root, "packages"), models,
    environment: { AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: skills } });
  const runtime = await factory.create({ id: "local", displayName: "Local", storageKey: "default", isDefault: true }, {
    customSkillDirectories: [], integrationEnvironment: { WEB_SEARCH_DISABLED: "1", MCP_FIXTURE_TOKEN: "fixture-secret" },
    mcpServers: [{ key: "private-source-id", displayName: "Archive service", aliases: ["private-alias"],
      transport: "http", url: "https://mcp.example.test/tools", auth: { kind: "bearer", tokenEnv: "MCP_FIXTURE_TOKEN" } }],
  }, join(root, "workspace"), join(root, "uploads"));
  t.after(async () => { await runtime.close?.(); await runtime.database.close(); });
  const run = await runtime.runs.executeConversation("owner", goal, { modelKey: "local:test" });
  assert.equal(run.status, "completed", run.errorCode ?? run.output ?? "inventory Run must complete");
  assert.equal(resolverSawInventory, true);
  assert.equal(replySawInventory, true);
  const events = await runtime.runs.events("owner", run.id);
  const snapshots = events.filter(event => event.type === "runtime.capability_snapshot.created");
  assert.ok(snapshots.some(event => (event.data.snapshot as { scope: string }).scope === "runtime_configured"));
  assert.equal(events.some(event => event.type === "tool.dispatched"), false);
  assert.deepEqual(requests, ["initialize", "notifications/initialized", "tools/list"]);
});
