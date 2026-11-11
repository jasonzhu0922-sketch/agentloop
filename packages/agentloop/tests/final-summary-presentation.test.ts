import assert from "node:assert/strict";
import test from "node:test";
import { buildStepSystemPrompt, RunService } from "../src/runtime/run-service.ts";
import { buildTaskProfile } from "../src/runtime/dynamic-prompt.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS, testOwner } from "./runtime-test-helpers.ts";

test("intermediate and clarification steps do not receive chart presentation instructions", () => {
  const profile = buildTaskProfile({ phase: "execution", intent: "execute" });
  for (const prompt of [buildStepSystemPrompt("", profile, false, false), buildStepSystemPrompt("", profile, true, true)]) {
    assert.match(prompt, /Do not add presentation charts/);
    assert.doesNotMatch(prompt, /fenced chart block/);
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
