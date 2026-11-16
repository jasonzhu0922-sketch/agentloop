import assert from "node:assert/strict";
import test from "node:test";
import { buildStepSystemPrompt, RunService } from "../src/runtime/run-service.ts";
import { buildTaskProfile } from "../src/runtime/dynamic-prompt.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { buildRuntimeDeliveryCandidate } from "../src/runtime/delivery-candidate.ts";
import { USER_DELIVERY_SCOPE_INSTRUCTION } from "../src/runtime/user-authority.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS, testOwner } from "./runtime-test-helpers.ts";

test("intermediate and clarification steps do not receive chart presentation instructions", () => {
  const profile = buildTaskProfile({ phase: "execution", intent: "execute" });
  for (const prompt of [buildStepSystemPrompt("", profile, false, false), buildStepSystemPrompt("", profile, true, true)]) {
    assert.match(prompt, /Do not add presentation charts/);
    assert.doesNotMatch(prompt, /fenced chart block/);
  }
});

test("internal evidence identifiers stay traceable without becoming answer text", () => {
  const output = "2025年1月2日，某企业的采购价格为2240元/吨。来源：行情数据。";
  const candidate = buildRuntimeDeliveryCandidate({
    output,
    stepSemanticFrame: { completionBoundary: ["explicit_caveats"], evidenceMode: "acquire_new_evidence", phaseRole: "delivery" },
    deliveryTargets: [{ targetId: "answer", surface: "conversation" }],
    toolEvidence: [{
      toolCallId: "lookup-price",
      toolName: "computer_run_command",
      result: JSON.stringify({
        query_id: "query_price",
        catalog_revision: "catalog-hash",
        dataset: { columns: ["price"], rows: [[2240]], row_count: 1 },
        evidenceKinds: { satisfied: ["record_counts"], caveated: ["explicit_caveats"], failed: [] },
      }),
      isError: false,
    }],
  });
  assert.equal(candidate.output, output);
  assert.deepEqual(candidate.caveats, []);
  assert.deepEqual(candidate.sourceToolCallIds, ["lookup-price"]);
  assert.deepEqual(candidate.deliveryClaims, [{ targetId: "answer", evidenceRefs: ["lookup-price"] }]);
  assert.deepEqual(candidate.evidenceKinds, { satisfied: ["record_counts"], caveated: ["explicit_caveats"], failed: [] });
});

test("actual limitations remain visible and are not duplicated when stated inline", () => {
  const caveat = "目标日期无记录，使用前一交易日价格。";
  const output = "采购价格为2240元/吨。";
  const input = { output, caveats: [caveat], toolEvidence: [] };
  const candidate = buildRuntimeDeliveryCandidate(input);
  assert.deepEqual(candidate.caveats, [caveat]);
  assert.ok(candidate.output.includes(caveat));
  const inline = `${output}${caveat}`;
  assert.equal(buildRuntimeDeliveryCandidate({ ...input, output: inline }).output, inline);
});

for (const scenario of [
  { name: "concise answer", input: "第一期收入1万元、第二期3万元，核对后总结变化。", output: "第二期收入比第一期增加2万元。" },
  { name: "requested audit", input: "第一期收入1万元、第二期3万元，核对后总结变化。附内部编号query_income供审计。", output: "第二期收入比第一期增加2万元。内部编号：`query_income`。" },
]) {
  test(`final delivery preserves the requested scope for ${scenario.name}`, async () => {
    const database = new AppDatabase(":memory:");
    const owner = testOwner().user.id;
    try {
      const runs = new RunService({
        database,
        skills: new SkillService(database),
        plannerFactory: singleStepTestPlanner,
        assessorFactory: approvingTestAssessor,
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
          assert.match(request.systemPrompt, /Internal traceability does not require displaying/);
          assert.match(request.systemPrompt, /when the user requests provenance, audit, or debugging/);
          return { content: scenario.output, finishReason: "stop", toolCalls: [] };
        } }),
      });
      const run = await runs.execute(owner, scenario.input);
      assert.equal(run.status, "completed");
      assert.equal(run.output, scenario.output);
      const completed = (await runs.events(owner, run.id)).find((event) => event.type === "run.completed");
      assert.equal(completed?.data.output, scenario.output);
    } finally {
      await database.close();
    }
  });
}

test("resolver-added disclosure wording stays subordinate to the original user request at execution", async () => {
  const database = new AppDatabase(":memory:");
  const owner = testOwner().user.id;
  const input = "已知1月2日采购价格为2240元/吨，告诉我这天的价格。";
  const output = "1月2日的采购价格为2240元/吨。";
  let executionObserved = false;
  try {
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      plannerFactory: singleStepTestPlanner,
      assessorFactory: approvingTestAssessor,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        assert.ok(request.systemPrompt.includes(USER_DELIVERY_SCOPE_INSTRUCTION));
        if (request.runId.startsWith("conversation-turn:")) {
          return { content: "", finishReason: "tool_calls", toolCalls: [{
            id: "resolve", name: "resolve_conversation_turn", arguments: {
              mode: "reply", relation: "new_goal", inputMode: "none",
              effectiveGoal: "给出当日采购价格，并注明计价口径、来源数据口径及查询证据链。",
              taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: false,
                deliverables: [{ targetId: "price", purpose: "回复价格、数据口径和查询证据链", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
              evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
              userConstraints: ["需给出价格数值并注明计价口径与来源证据链"],
              memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
            },
          }] };
        }
        const context = request.runtimeContext?.content ?? "";
        assert.ok(context.includes(input), "execution must retain the original request alongside expanded Plan text");
        assert.match(context, /userAuthority/);
        assert.match(request.systemPrompt, /does not make inferred presentation requirements into user requests/);
        executionObserved = true;
        return { content: output, finishReason: "stop", toolCalls: [] };
      } }),
    });
    const run = await runs.executeConversation(owner, input);
    assert.equal(executionObserved, true);
    assert.equal(run.status, "completed");
    assert.equal(run.output, output);
  } finally {
    await database.close();
  }
});

test("final delivery considers rich expression and terminal commit preserves the chart verbatim", async () => {
  const database = new AppDatabase(":memory:");
  const final = '结论：第二期增加了 2 万元。\n\n```chart\n{"type":"line","title":"收入","yLabel":"万元","labels":["第一期","第二期"],"series":[{"name":"收入","values":[1,3]}]}\n```\n\n来源：用户提供的两个期间收入。';
  const prompts: string[] = [];
  const owner = testOwner().user.id;
  try {
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      plannerFactory: singleStepTestPlanner,
      assessorFactory: approvingTestAssessor,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        prompts.push(request.systemPrompt);
        return { content: final, finishReason: "stop", toolCalls: [] };
      } }),
    });
    const run = await runs.execute(owner, "第一期收入1万元、第二期3万元，核对后总结变化。");
    assert.equal(run.status, "completed");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /final user-facing summary/);
    assert.match(prompts[0]!, /when useful for the user's needs/);
    assert.match(prompts[0]!, /fenced chart block/);
    assert.doesNotMatch(prompts[0]!, /summarize the completed work in 2-4 short sentences/);
    assert.equal(run.output, final);
    const completed = (await runs.events(owner, run.id)).find((event) => event.type === "run.completed");
    assert.equal(completed?.data.output, final);
  } finally {
    await database.close();
  }
});
