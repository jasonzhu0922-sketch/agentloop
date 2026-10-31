import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase, RunService, SkillService } from "@zhujun/agentloop";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "../../agentloop/tests/runtime-test-helpers.ts";
import { createLocalMemoryPlugin } from "../src/plugin.ts";

test("an omitted Memory decision is repaired before an unseen preference is committed, applied, revised, and recalled", async () => {
  const database = new AppDatabase(":memory:");
  const skills = new SkillService(database);
  const observedContexts: string[] = [];
  const owner = "memory-owner";
  const input = "还有，以后我会称呼你为玄武，你就是玄武，知道吗？";
  const nameQuery = "你叫什么名字？";
  const rename = "以后我就叫你小武";
  let establishingResolverAttempts = 0;
  let runs: RunService;
  const memory = await createLocalMemoryPlugin({
    database,
    resolveRunScope: async (runId) => {
      const run = await runs.get(owner, runId);
      return { runId, tenantId: "tenant", ownerUserId: run.ownerUserId };
    },
  });
  try {
    runs = new RunService({
      database, skills, memory,
      plannerFactory: singleStepTestPlanner,
      assessorFactory: approvingTestAssessor,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if (request.runId.startsWith("conversation-turn:")) {
          const latest = request.messages.at(-1)?.content;
          const establishing = latest === input;
          const queryingName = latest === nameQuery;
          const renaming = latest === rename;
          if (establishing && ++establishingResolverAttempts === 1) {
            return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "resolve-omitted-memory", name: "resolve_conversation_turn", arguments: {
              mode: "reply", relation: "new_goal", inputMode: "none",
              effectiveGoal: "确认用户今后以玄武称呼助手，助手应将其视为自己的名字。",
              taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: false,
                deliverables: [{ targetId: "answer", purpose: input, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
              evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
              userConstraints: ["助手的名字是玄武"], requiredCapabilityReferences: [],
            } }] };
          }
          if (!establishing) {
            const prior = JSON.parse((request.runtimeContext?.content ?? "").split("\n")[1]).priorPreferences;
            assert.equal(prior[0].subtype, "interaction.assistant_name");
            assert.equal(prior[0].value.name, renaming || queryingName ? "玄武" : "小武");
          }
          const replyOnly = establishing || queryingName || renaming;
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "resolve", name: "resolve_conversation_turn", arguments: {
            mode: replyOnly ? "reply" : "execute", relation: "new_goal", inputMode: "none", effectiveGoal: latest,
            taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: replyOnly ? "answer" : "analysis", requiresExecution: !replyOnly,
              deliverables: [{ targetId: "answer", purpose: latest, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
            evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [], requiredCapabilityReferences: [],
            memoryAction: establishing || renaming ? "commit" : "none",
            memoryIntents: establishing || renaming ? [{
              schema: "agentloop.memoryIntentCandidate/v1", kind: "preference", subtype: "interaction.assistant_name", canonicalKey: "interaction.assistant_name",
              value: { subject: "assistant", name: renaming ? "小武" : "玄武" }, contentMarkdown: `用户称呼助手为${renaming ? "小武" : "玄武"}。`,
              sourceQuote: renaming ? rename : "以后我会称呼你为玄武，你就是玄武",
              persistenceIntent: "future_oriented", sensitivity: "normal", applicationTargets: ["response", "human_loop"], confidence: 1,
            }] : [],
          } }] };
        }
        const context = request.runtimeContext?.content ?? "";
        observedContexts.push(context);
        assert.match(context, /interaction\.assistant_name/u);
        if (observedContexts.length === 1 || observedContexts.length === 3) assert.match(context, /status: committed/u);
        assert.match(context, observedContexts.length <= 2 ? /玄武/u : /小武/u);
        const outputs = ["好的，以后你可以叫我玄武。", "我叫玄武。", "好的，可以叫我小武。", "2 + 3 = 5。"];
        return { content: outputs[observedContexts.length - 1]!, finishReason: "stop", toolCalls: [] };
      } }),
    });
    const first = await runs.executeConversation(owner, input);
    assert.equal(first.status, "completed");
    const recalledName = await runs.executeConversation(owner, nameQuery);
    assert.equal(recalledName.status, "completed");
    assert.equal(recalledName.output, "我叫玄武。");
    const revision = await runs.executeConversation(owner, rename);
    assert.equal(revision.status, "completed");
    const second = await runs.executeConversation(owner, "计算 2 + 3");
    assert.equal(second.status, "completed");
    assert.equal(observedContexts.length, 4);
    const active = await memory.store.active({ tenantId: "tenant", ownerUserId: owner });
    assert.equal(active.length, 1);
    assert.equal(active[0].revision.revision, 2);
    const firstEvents = await runs.events(owner, first.id);
    assert.ok(firstEvents.some((event) => event.type === "conversation.turn.resolution_rejected"
      && event.data.feedback === "memoryAction must be none or commit and is required for every turn."));
    assert.ok(firstEvents.some((event) => event.type === "memory.explicit_commit"));
    assert.equal(establishingResolverAttempts, 2);
  } finally {
    await database.close();
  }
});
