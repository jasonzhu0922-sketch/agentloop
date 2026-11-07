import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { discoverSkillDirectory } from "../src/skills/skill-directory.ts";
import { selectPlanningSkillRoles } from "../src/runtime/run-service.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import type { PrivateSkill } from "../src/skills/skill-service.ts";
import { inspectSkillPackage } from "../src/skills/skill-package.ts";
import { ModelPlanner } from "../src/planning/planner.ts";
import { admitPlan } from "../src/planning/admission.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { planningCapabilitiesFromSkills, planningCapabilitiesFromToolNames } from "../src/planning/step-execution-binding.ts";
import type { ModelAdapter } from "../src/runtime/contracts.ts";

async function packageSkill(path: string): Promise<PrivateSkill> {
  const inspection = await inspectSkillPackage(resolve(import.meta.dirname, "..", "..", path));
  return { id: `discovered:${inspection.name}`, name: inspection.name, description: inspection.description, agentLoop: inspection.agentLoop } as PrivateSkill;
}

test("bundled research guidance is discoverable without binding a source or executor", async () => {
  const directory = resolve(import.meta.dirname, "..", "..", "agentloop-skills", "skills");
  const research = (await discoverSkillDirectory(directory)).find((entry) => entry.inspection.name === "research");
  assert.ok(research);
  assert.deepEqual(research.inspection.declaration.workflow.roles, ["primary_builder"]);
  assert.deepEqual(research.inspection.declaration.workflow.sourceKinds, []);
  assert.deepEqual(research.inspection.declaration.workflow.requiredSkills, []);
  assert.equal(research.inspection.declaration.execution, undefined);
});

test("a source-grounded Chinese investigation exposes research to the planner", async () => {
  const directory = resolve(import.meta.dirname, "..", "..", "agentloop-skills", "skills");
  const research = (await discoverSkillDirectory(directory)).find((entry) => entry.inspection.name === "research");
  assert.ok(research);
  const skill = { id: "discovered:research", name: research.inspection.name, description: research.inspection.description, agentLoop: research.inspection.agentLoop } as PrivateSkill;
  const task = understandTask({ objective: "你帮我查查宝武共享这家单位在宝武集团的业务地位", evidenceDemand: "source_grounded" });
  const selected = selectPlanningSkillRoles([skill], task, []);
  assert.deepEqual(selected.map(({ skill: candidate, selection }) => [candidate.id, selection.role]), [[skill.id, "primary_builder"]]);
});

test("news research and impact analysis exposes the research workflow alongside unrelated providers", async () => {
  const research = await packageSkill("agentloop-skills/skills/research");
  const provider = await packageSkill("../apps/agentloop-multi-runtime/custom-skills/hr-report-data");
  const objective = "搜索美国中期选举（2026年美国中期选举）结果相关的最新新闻，并在此基础上研究分析该选举结果对中国宏观经济的影响。 你帮我搜索美国中期选举结果相关新闻，并研究分析一下对中国宏观经济的影响";
  const task = understandTask({ objective, userConstraints: ["需检索美国中期选举结果相关新闻", "需在此基础上研究分析对中国宏观经济的影响"], evidenceDemand: "source_grounded", resolvedTaskIntent: {
    schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true,
    deliverables: [{ targetId: "analysis", purpose: objective, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }],
  } });
  const selected = selectPlanningSkillRoles([research, provider], task, []);
  assert.ok(selected.some(({ skill }) => skill.id === research.id));
});

test("structured data lookup retains its source provider without nominating general research", async () => {
  const research = await packageSkill("agentloop-skills/skills/research");
  const provider = await packageSkill("../apps/agentloop-multi-runtime/custom-skills/data-platform-query");
  const task = understandTask({ objective: "查询数据中台订单表的字段、主键和上下游表级血缘", evidenceDemand: "source_grounded" });
  const selected = selectPlanningSkillRoles([research, provider], task, []);
  assert.ok(selected.some(({ skill, selection }) => skill.id === provider.id && selection.role === "source_provider"));
  assert.ok(!selected.some(({ skill }) => skill.id === research.id));
});

test("research for a presentation exposes both research and presentation workflow candidates", async () => {
  const research = await packageSkill("agentloop-skills/skills/research");
  const presentation = await packageSkill("agentloop-skills/skills/pptx");
  const task = understandTask({ objective: "调研新能源汽车行业的发展情况，分析主要趋势并制作 PPTX 演示文稿", evidenceDemand: "source_grounded" });
  const selected = selectPlanningSkillRoles([research, presentation], task, []);
  assert.ok(selected.some(({ skill }) => skill.id === research.id));
  assert.ok(selected.some(({ skill }) => skill.id === presentation.id));
});

test("domain data analysis retains its workflow and database companion alongside general research", async () => {
  const research = await packageSkill("agentloop-skills/skills/research");
  const analysis = await packageSkill("../apps/agentloop-multi-runtime/custom-skills/steel-market-analysis");
  const data = await packageSkill("../apps/agentloop-multi-runtime/custom-skills/mysql-steel-data");
  const task = understandTask({ objective: "分析上海热轧卷板近三个月的价格走势和涨跌幅", evidenceDemand: "source_grounded" });
  const selected = selectPlanningSkillRoles([research, analysis, data], task, []);
  assert.ok(selected.some(({ skill, selection }) => skill.id === analysis.id && selection.role === "primary_builder"));
  assert.ok(selected.some(({ skill, selection }) => skill.id === data.id && selection.role === "source_provider"));
  assert.ok(!selected.some(({ skill }) => skill.id === research.id));
});

test("research and presentation can be bound to separate admitted plan steps", async () => {
  const research = await packageSkill("agentloop-skills/skills/research");
  const pptx = await packageSkill("agentloop-skills/skills/pptx");
  const skills = [research, pptx];
  const objective = "Research industry developments and create a PPTX presentation.";
  const runId = "research-presentation";
  const understanding = understandTask({ objective, evidenceDemand: "source_grounded", resolvedTaskIntent: {
    schema: "agentloop.conversationTaskIntent/v1", operation: "composite", requiresExecution: true,
    deliverables: [{ targetId: "deck", purpose: objective, expectedArtifactCount: 1, action: "create", kind: "presentation", format: "pptx", surface: "workspace_artifact" }],
  } });
  const canonicalState = createCanonicalRunState({ runId, userInput: objective, now: 1, understanding });
  const roles = skills.map((skill) => ({ skillId: skill.id, role: "primary_builder" as const, reason: "Owns this step's workflow." }));
  const names = ["load_skill", "websearch", "webfetch", "computer_write_file", "verify_artifact_acceptance"];
  const capabilities = [...planningCapabilitiesFromToolNames(names), ...planningCapabilitiesFromSkills(skills)];
  const model: ModelAdapter = { limits: { contextWindowTokens: 40000, maxOutputTokens: 4096 }, async complete() {
    return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "plan", name: "submit_outcome_plan", arguments: {
      schema: "agentloop.outcomePlan/v2", goal: objective, shape: "fact_then_produce", selectedSkillRoles: roles,
      leaves: [
        { id: "research", objective: "Research industry developments using relevant sources.", dependsOn: [], role: "fact_acquisition", skillIds: [research.id], requiredCapabilities: ["skill_instruction_load", "web_research"], targetIds: [], evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" } },
        { id: "deck", objective: "Create a PPTX presentation from the research.", dependsOn: ["research"], role: "produce", skillIds: [pptx.id], requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write", "artifact_acceptance"], targetIds: ["deck"], evidenceContract: { requiredKinds: ["artifact_path", "artifact_non_empty"], caveatPolicy: "none" } },
      ],
    } }] };
  } };
  const proposal = await new ModelPlanner(model).plan({ runId, canonicalState, availableSkills: skills, availableToolNames: names, selectedSkillRoles: roles, availableCapabilities: capabilities });
  const plan = admitPlan({ runId, canonicalState, proposal, availableSkills: skills, availableToolNames: new Set(names), availableCapabilities: capabilities });
  assert.deepEqual(plan.steps.find((step) => step.id === "research")?.skillIds, [research.id]);
  assert.deepEqual(plan.steps.find((step) => step.id === "deck")?.skillIds, [pptx.id]);
});

test("enterprise DCMM training request exposes research as an upstream stage and PPTX as the artifact stage", async () => {
  const research = await packageSkill("agentloop-skills/skills/research");
  const pptx = await packageSkill("agentloop-skills/skills/pptx");
  const task = understandTask({ objective: "生成一份企业 DCMM 内部的 PPTX 培训资料", evidenceDemand: "source_grounded" });
  const selected = selectPlanningSkillRoles([research, pptx], task, []);
  assert.deepEqual(new Set(selected.map(({ skill }) => skill.id)), new Set([research.id, pptx.id]));
  assert.equal(research.agentLoop?.artifactKinds.includes("none"), true);
  assert.equal(pptx.agentLoop?.artifactKinds.includes("presentation"), true);
});

test("the full DCMM wording keeps PPTX as a presentation producer candidate after format normalization", async () => {
  const research = await packageSkill("agentloop-skills/skills/research");
  const pptx = await packageSkill("agentloop-skills/skills/pptx");
  const objective = "研究企业 DCMM（数据管理能力成熟度模型）国家标准，结合企业内部培训场景，生成一份 PPTX 培训资料。资料需包含 DCMM 模型框架、8 个能力域及成熟度等级的讲解内容，并标注信息来源和待确认内容。";
  const task = understandTask({ objective, evidenceDemand: "source_grounded", resolvedTaskIntent: {
    schema: "agentloop.conversationTaskIntent/v1", operation: "composite", requiresExecution: true,
    deliverables: [{ targetId: "dcmm_training", purpose: objective, expectedArtifactCount: 1, action: "create", kind: "presentation", surface: "workspace_artifact" }],
  } });
  const selected = selectPlanningSkillRoles([research, pptx], task, []);
  assert.ok(selected.some(({ skill }) => skill.id === research.id));
  assert.ok(selected.some(({ skill }) => skill.id === pptx.id));
});

test("research handoff requires structured decisions and does not ask for prose approval", async () => {
  const directory = resolve(import.meta.dirname, "..", "..", "agentloop-skills", "skills");
  const research = (await discoverSkillDirectory(directory)).find((entry) => entry.inspection.name === "research");
  assert.ok(research);
  assert.match(research.inspection.instructions, /original request authorizes the requested downstream artifact/);
  assert.match(research.inspection.instructions, /structured human-decision workflow/);
  assert.match(research.inspection.instructions, /never present a prose question/);
});
