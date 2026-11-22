import assert from "node:assert/strict";
import test from "node:test";
import { createCanonicalRunState, understandTask, type PrivateSkill, type RuntimeEvent, type TaskSpec } from "@zhujun/agentloop";
import { fixedDataAnalysisPlanner } from "../src/fixed-planner.ts";
import { createDataAgent } from "../src/agent.ts";

const skill = { id: "discovered:data-analysis", name: "data-analysis", agentLoop: { executionProfiles: ["local_script"] } } as unknown as PrivateSkill;
const xlsx = { id: "discovered:xlsx", name: "xlsx", agentLoop: { artifactKinds: ["spreadsheet"], roles: ["primary_builder"] } } as unknown as PrivateSkill;
test("fixed application workflow binds its main Skill even outside lexical recommendations", async () => {
  const understanding = understandTask({ objective: "查询经营指标", resolvedTaskIntent: {
    schema: "agentloop.conversationTaskIntent/v1", operation: "lookup", requiresExecution: true,
    deliverables: [{ targetId: "answer", purpose: "回答指标", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }],
  } });
  const canonicalState = createCanonicalRunState({ runId: "fixed-run", userInput: "查询经营指标", understanding, now: 1 });
  const events: RuntimeEvent[] = [];
  const proposal = await fixedDataAnalysisPlanner(skill, [], { maxPlanningTurns: 8 }).plan(
    { canonicalState, availableSkills: [], availableToolNames: [] } as unknown as TaskSpec,
    undefined,
    event => { events.push(event); },
  );
  assert.deepEqual(events.map(event => event.type), ["planning.started", "planning.turn.started", "planning.turn.completed"]);
  assert.equal(events[0].data.maxPlanningTurns, 8);
  assert.equal(events[1].data.deterministic, true);
  assert.equal(events[2].data.deterministic, true);
  assert.deepEqual(proposal.selectedSkillIds, [skill.id]);
  assert.equal(proposal.steps.length, 1);
  assert.deepEqual(proposal.steps[0].skillIds, [skill.id]);
  assert.deepEqual(proposal.steps[0].targetIds, ["answer"]);
  assert.deepEqual(proposal.steps[0].evidenceContract?.requiredKinds, ["source_summary"]);
  assert.ok(proposal.steps[0].requiredCapabilities.includes(`skill_source_provider.database.${skill.id}`));
  assert.match(proposal.steps[0].objective, /实体、指标、期间和粒度/);
  assert.equal(proposal.steps[0].successCriteria?.find(criteria => criteria.id === "semantic-plan-contract")?.blocking, true);
});
test("file delivery binds data-analysis and the matching writer Skill", async () => {
  const understanding = understandTask({ objective: "查询经营指标并导出 Excel", resolvedTaskIntent: {
    schema: "agentloop.conversationTaskIntent/v1", operation: "create_artifact", requiresExecution: true,
    deliverables: [{ targetId: "answer-file", purpose: "导出 Excel", expectedArtifactCount: 1, action: "create", kind: "spreadsheet", format: "xlsx", surface: "workspace_artifact" }],
  } });
  const canonicalState = createCanonicalRunState({ runId: "file-run", userInput: "查询经营指标并导出 Excel", understanding, now: 1 });
  const proposal = await fixedDataAnalysisPlanner(skill, [xlsx]).plan({ canonicalState, availableSkills: [], availableToolNames: [] } as unknown as TaskSpec);
  assert.deepEqual(proposal.selectedSkillIds, [skill.id, xlsx.id]);
  assert.deepEqual(proposal.steps[0].skillIds, [skill.id, xlsx.id]);
  assert.ok(proposal.steps[0].requiredCapabilities.includes("workspace_artifact_write"));
  assert.ok(proposal.steps[0].requiredCapabilities.includes("artifact_acceptance"));
  assert.equal(proposal.steps[0].requiredCapabilities.includes("conversation_delivery"), false);
  assert.match(proposal.steps[0].objective, /xlsx/);
});
test("fixed planner refuses an unavailable or wrong application capability", () => {
  assert.throws(() => fixedDataAnalysisPlanner({ ...skill, name: "other-skill" }), /requires/);
  assert.throws(() => fixedDataAnalysisPlanner({ ...skill, agentLoop: undefined }), /requires/);
  assert.throws(() => fixedDataAnalysisPlanner(skill, [], { maxPlanningTurns: 0 }), /maxPlanningTurns/);
});
test("application rejects any non-TiDB persistence before initializing a runtime", async () => {
  await assert.rejects(createDataAgent({ connection: { dialect: "sqlite" } } as never), /仅支持 TiDB/);
});
