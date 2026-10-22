import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localRuntimeTerminalLogLine } from "../local-agent-runtime/src/observability/runtime-terminal-log.ts";
import { LocalRuntimeFactory } from "../local-agent-runtime/src/service/local-runtime-factory.ts";

test("Local Runtime terminal logs retain the concrete child Runtime identity", () => {
  assert.equal(
    localRuntimeTerminalLogLine("local-runtime-research", "[agentloop] event=tool.completed tool=computer_run_command", { colorMode: "never" }),
    "[local-runtime:local-runtime-research] [agentloop] event=tool.completed tool=computer_run_command",
  );
});

for (const outcome of ["completed", "failed"] as const) {
  test(`Local Agent retains gateway request IDs in ${outcome} provider events and terminal logs`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agentloop-local-request-log-"));
    const appRoot = new URL("../", import.meta.url).pathname;
    await mkdir(join(root, "skills"));
    const lines: string[] = [];
    const gatewayId = `local-gateway-${outcome}-${"a".repeat(100)}`;
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      requests += 1;
      const request = JSON.parse(String(init.body));
      assert.equal(request.model, "flash");
      const headers = { "content-type": "application/json", "x-oneapi-request-id": gatewayId };
      if (outcome === "failed") return new Response('{"error":{"message":"provider rejected request"}}', { status: 400, headers });
      const resolving = request.tools?.some((tool: { function?: { name?: string } }) => tool.function?.name === "resolve_conversation_turn");
      let toolCalls = !resolving ? undefined : [{
        id: "resolve-greeting",
        type: "function",
        function: {
          name: "resolve_conversation_turn",
          arguments: JSON.stringify({
            mode: "reply", relation: "new_goal", inputMode: "none", effectiveGoal: "Greet the user.",
            taskIntent: {
              schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: false,
              deliverables: [{ targetId: "greeting", purpose: "Greet the user.", expectedArtifactCount: 1,
                action: "none", kind: "none", surface: "conversation" }],
            },
            evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [],
          }),
        },
      }];
      const assessment = request.tools?.find((tool: { function?: { name?: string } }) => tool.function?.name === "submit_assessment");
      if (assessment) {
        const criterionIds: string[] = assessment.function.parameters.properties.criteria.items.properties.criterionId.enum ?? [];
        toolCalls = [{ id: "assess-greeting", type: "function", function: {
          name: "submit_assessment", arguments: JSON.stringify({
            criteria: criterionIds.map((criterionId) => ({ criterionId, satisfied: true,
              rationale: "The greeting is present.", evidenceRefs: ["candidateOutput"],
              contractCheck: { status: "valid", rationale: "The greeting contract is valid." } })),
            skills: [], feedback: "", failedBoundary: null,
          }),
        } }];
      }
      const content = toolCalls === undefined ? "你好，有什么可以帮你？" : "";
      if (request.stream) return new Response(`data: ${JSON.stringify({
        id: "local-completion-id",
        choices: [{ finish_reason: toolCalls === undefined ? "stop" : "tool_calls",
          delta: { content, ...(toolCalls === undefined ? {} : {
            tool_calls: toolCalls.map((call, index) => ({ ...call, index })),
          }) } }],
      })}\n\ndata: [DONE]\n\n`, { headers: { ...headers, "content-type": "text/event-stream" } });
      return new Response(JSON.stringify({
        id: "local-completion-id",
        choices: [{ finish_reason: toolCalls === undefined ? "stop" : "tool_calls",
          message: { role: "assistant", content, tool_calls: toolCalls } }],
      }), { headers });
    });
    const runtime = await new LocalRuntimeFactory({
      appRoot, statePath: join(root, "state.json"), databasePath: join(root, "runtime.db"),
      workspaceRoot: join(root, "workspace"), skillPackageStoreRoot: join(root, "packages"),
      providerConfigPath: join(root, "unused-provider.json"), skillDirectoriesConfigPath: join(root, "unused-skills.json"),
      stepExecutionStrategyConfigPath: join(appRoot, "config", "step-execution-strategy.json"),
      environment: { AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: join(root, "skills") },
      runEventLogSink: (definition, line) => {
        lines.push(localRuntimeTerminalLogLine(definition.id, line, { colorMode: "never" }));
      },
    }).create({ id: "local-log-runtime", displayName: "Runtime", storageKey: "default", isDefault: true }, {
      customSkillDirectories: [], mcpServers: [], integrationEnvironment: { WEB_SEARCH_DISABLED: "1" },
      modelConfiguration: {
        configured: true, reuseCloudModels: false,
        registryConfig: {
          defaultProvider: "test", defaultModelKey: "flash",
          providers: { test: { kind: "openai-compatible", baseUrl: "https://provider.example.test/v1",
            apiKeyEnv: "TEST_KEY", defaultModel: "flash", protocol: "chat-completions" } },
          models: { flash: { providerKey: "test", providerModel: "flash", protocol: "chat-completions",
            contextWindowTokens: 128_000, maxOutputTokens: 8_192, maxAttempts: 1 } },
        },
        environment: { TEST_KEY: "local-test-secret" },
      },
    }, join(root, "workspace"), join(root, "uploads"));
    try {
      const execution = runtime.runs.executeConversation("owner", "你好", { modelKey: "local:flash" });
      if (outcome === "failed") {
        await assert.rejects(execution, (error: unknown) => (error as { code?: string }).code === "MODEL_ERROR");
      } else {
        const run = await execution;
        assert.equal(run.status, "completed");
      }
      const row = await runtime.database.prepare("SELECT id FROM runs ORDER BY created_at DESC LIMIT 1").get() as { id: string };
      const events = (await runtime.runs.events("owner", row.id)).filter((event) => event.type === `model.request.${outcome}`);
      assert.ok(requests > 0);
      assert.ok(events.length > 0);
      for (const event of events) {
        assert.equal(event.data.providerGatewayRequestId, gatewayId);
        assert.equal(event.data.providerRequestId, undefined);
        if (outcome === "completed") assert.equal(event.data.providerResponseId, "local-completion-id");
      }
      const requestLines = lines.filter((line) => line.includes(`event=model.request.${outcome}`));
      assert.equal(requestLines.length, events.length);
      for (const line of requestLines) {
        assert.ok(line.startsWith("[local-runtime:local-log-runtime] [agentloop]"));
        assert.ok(line.includes(`providerGatewayRequestId=${JSON.stringify(gatewayId)}`));
        if (outcome === "completed") assert.ok(line.includes('providerResponseId="local-completion-id"'));
      }
      assert.doesNotMatch(lines.join("\n"), /local-test-secret/);
    } finally {
      runtime.database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
