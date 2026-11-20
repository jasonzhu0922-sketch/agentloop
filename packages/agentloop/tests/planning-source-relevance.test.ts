import assert from "node:assert/strict";
import test from "node:test";
import { selectPlanningSkillRoles } from "../src/runtime/run-service.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import type { PrivateSkill } from "../src/skills/skill-service.ts";
import type { UploadedSourceSummary } from "../src/runtime/contracts.ts";
import { ModelPlanner } from "../src/planning/planner.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";

const businessAnalysis = {
  id: "discovered:data-analysis", name: "data-analysis",
  description: "面向集团经营分析和采购销售库存演示场景，分析财务报表、经营指标实际与计划、人力月报、钢联行情、采购合同，以及销售、库存、生产、应收应付和收付款数据。",
  agentLoop: { roles: ["primary_builder", "source_provider"], artifactKinds: ["none"], sourceKinds: ["database"], qaKinds: [],
    semanticTags: ["data-analysis", "nl2sql", "business-metrics", "data-query"], producesEvidenceKinds: ["source_summary", "record_counts"],
    intentExamples: ["在集团经营分析场景中，查询某公司某月的财务报表项目值。", "分析集团经营指标的实际值、计划值、完成率和差异。",
      "查询集团某组织某月的员工人数并比较各组织差异。", "分析集团场景中某钢联行情指标的历史走势。",
      "统计集团采购合同数量、金额及供应商分布。", "在采购销售库存演示场景中，分析销售趋势、库存和应收应付情况。"],
  },
} as PrivateSkill;

for (const withOldUpload of [false, true]) test(`current market request does not bind an unrelated business database (old upload=${withOldUpload})`, () => {
  const sources = withOldUpload ? [{ id: "old-design", originalName: "旧设计稿.md", extension: ".md", mimeType: "text/markdown", status: "ready" } as UploadedSourceSummary] : [];
  for (const objective of ["帮我分析一下今天 A 股的情况", "分析今天（截至当前运行时刻）A 股市场的情况，并在对话中用中文给出分析结论。 帮我分析一下今天 A 股的情况", "帮我分析一下今天 A 股的表现"]) {
    const understanding = understandTask({ objective, evidenceDemand: "source_grounded", uploadedSources: sources });
    assert.deepEqual(selectPlanningSkillRoles([businessAnalysis], understanding, [], sources), [], objective);
  }
});

test("source-domain recall retains business coverage and explicit user selection", () => {
  for (const objective of ["分析集团经营指标的实际值、计划值和完成率", "查询某公司某月的财务报表项目值", "使用 data-analysis 分析今天 A 股的情况"]) {
    const selected = selectPlanningSkillRoles([businessAnalysis], understandTask({ objective, evidenceDemand: "source_grounded" }), []);
    assert.equal(selected[0]?.skill.id, businessAnalysis.id, objective);
  }
});

test("nested substrings of one shared word do not corroborate domain relevance", () => {
  const provider = { ...businessAnalysis, agentLoop: { ...businessAnalysis.agentLoop!, intentExamples: ["统计采购完成率"] } } as PrivateSkill;
  assert.deepEqual(selectPlanningSkillRoles([provider], understandTask({ objective: "分析今天公路建设完成率", evidenceDemand: "source_grounded" }), []), []);
});

test("current-events conversation can acquire and explain evidence in one admitted leaf", async () => {
  const objective = "帮我分析一下今天 A 股的情况";
  const runId = "current-events-single-leaf";
  let profile: Record<string, unknown> | undefined;
  const plan = await new ModelPlanner({
    limits: { contextWindowTokens: 40000, maxOutputTokens: 4096 },
    complete: async () => ({ content: "", finishReason: "tool_calls", toolCalls: [{ id: "answer", name: "submit_outcome_plan", arguments: {
      schema: "agentloop.outcomePlan/v2", goal: objective, shape: "single_leaf", selectedSkillRoles: [],
      leaves: [{ id: "answer", objective, dependsOn: [], role: "deliver", skillIds: [], targetIds: ["market-analysis"],
        requiredCapabilities: ["web_research", "conversation_delivery"],
        evidenceContract: { requiredKinds: ["source_summary", "source_urls"], caveatPolicy: "mark_unverified_facts" } }],
    } }] }),
  }, { maxPlanningTurns: 1 }).plan({
    runId, canonicalState: createCanonicalRunState({ runId, userInput: objective, now: 1,
      understanding: understandTask({ objective, evidenceDemand: "source_grounded", resolvedTaskIntent: {
        schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true,
        deliverables: [{ targetId: "market-analysis", purpose: objective, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }],
      } }),
    }), availableSkills: [], availableToolNames: ["websearch", "webfetch"],
  }, undefined, async event => { if (event.type === "planning.profile.created") profile = event.data; });
  assert.equal(profile?.planShape, "single_leaf");
  assert.equal(profile?.planTopology, undefined);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.role, "deliver");
  assert.ok(plan.steps[0]?.requiredCapabilities.includes("web_research"));
});
