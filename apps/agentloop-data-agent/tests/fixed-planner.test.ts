import assert from "node:assert/strict";
import test from "node:test";
import { createCanonicalRunState, understandTask, type PrivateSkill, type TaskSpec } from "@zhujun/agentloop";
import { fixedDataAnalysisPlanner } from "../src/fixed-planner.ts";
import { createDataAgent } from "../src/agent.ts";

const skill = { id: "discovered:data-analysis", name: "data-analysis", agentLoop: { executionProfiles: ["local_script"] } } as unknown as PrivateSkill;
test("fixed application workflow binds its main Skill even outside lexical recommendations", async () => {
  const understanding = understandTask({ objective: "查询经营指标", resolvedTaskIntent: {
    schema: "agentloop.conversationTaskIntent/v1", operation: "lookup", requiresExecution: true,
    deliverables: [{ targetId: "answer", purpose: "回答指标", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }],
  } });
  const canonicalState = createCanonicalRunState({ runId: "fixed-run", userInput: "查询经营指标", understanding, now: 1 });
  const proposal = await fixedDataAnalysisPlanner(skill).plan({ canonicalState, availableSkills: [], availableToolNames: [] } as unknown as TaskSpec);
  assert.deepEqual(proposal.selectedSkillIds, [skill.id]);
  assert.equal(proposal.steps.length, 1);
  assert.deepEqual(proposal.steps[0].skillIds, [skill.id]);
  assert.deepEqual(proposal.steps[0].targetIds, ["answer"]);
  assert.deepEqual(proposal.steps[0].evidenceContract?.requiredKinds, ["source_summary"]);
  assert.ok(proposal.steps[0].requiredCapabilities.includes(`skill_source_provider.database.${skill.id}`));
  assert.match(proposal.steps[0].objective, /实体、指标、期间和粒度/);
});
test("fixed planner refuses an unavailable or wrong application capability", () => {
  assert.throws(() => fixedDataAnalysisPlanner({ ...skill, name: "other-skill" }), /requires/);
  assert.throws(() => fixedDataAnalysisPlanner({ ...skill, agentLoop: undefined }), /requires/);
});
test("application rejects any non-TiDB persistence before initializing a runtime", async () => {
  await assert.rejects(createDataAgent({ connection: { dialect: "sqlite" } } as never), /仅支持 TiDB/);
});
