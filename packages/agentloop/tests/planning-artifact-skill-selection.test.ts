import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { selectPlanningSkillRoles } from "../src/runtime/run-service.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { inspectSkillPackage } from "../src/skills/skill-package.ts";
import type { PrivateSkill } from "../src/skills/skill-service.ts";
import { ModelPlanner } from "../src/planning/planner.ts";
import { admitPlan } from "../src/planning/admission.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { planningCapabilitiesFromToolNames, planningCapabilitiesFromSkills } from "../src/planning/step-execution-binding.ts";
import type { ConversationTurnResolution, TaskSpec } from "../src/planning/contracts.ts";

const documentSkills = Promise.all(["docx", "pdf"].map(async (name) => {
  const inspected = await inspectSkillPackage(resolve(import.meta.dirname, "../../agentloop-skills/skills", name));
  return {
    id: `discovered:${name}`, name, description: inspected.description, agentLoop: inspected.agentLoop,
  } as PrivateSkill;
}));

test("PDF follow-ups retain their resolved format when document wording is removed from the subject", async () => {
  const skills = await documentSkills;
  for (const objective of [
    "你把第二部分和第三部分合并为一个文件，第二部分在前",
    "把前面分拆的 pdf 文件的第二部分和第三部分文件合并为一个文件",
  ]) {
    const understanding = understandTask({
      objective, evidenceDemand: "none", targetArtifactKind: "document",
      resolvedTaskIntent: {
        schema: "agentloop.conversationTaskIntent/v1", operation: "transform_artifact", requiresExecution: true,
        deliverables: [{ targetId: "merged", purpose: objective, expectedArtifactCount: 1,
          action: "transform", kind: "document", format: "pdf", surface: "workspace_artifact" }],
      },
    });
    assert.equal(understanding.format, "pdf");
    assert.equal(understanding.deliverable.kind, "document");
    assert.doesNotMatch(understanding.subject.text, /pdf/iu);
    for (const catalog of [skills, [...skills].reverse()]) {
      assert.deepEqual(selectPlanningSkillRoles(catalog, understanding, []).map(({ skill }) => skill.id), ["discovered:pdf"]);
    }
  }
});

test("a document category without a concrete format preserves both native workflow candidates", async () => {
  const skills = await documentSkills;
  const understanding = understandTask({
    objective: "Modify the document", evidenceDemand: "none", targetArtifactKind: "document",
    resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1", operation: "transform_artifact", requiresExecution: true,
      deliverables: [{ targetId: "edited", purpose: "Modify the document", expectedArtifactCount: 1,
        action: "modify", kind: "document", surface: "workspace_artifact" }],
    },
  });
  assert.equal(understanding.format, undefined);
  for (const catalog of [skills, [...skills].reverse()]) {
    assert.deepEqual(new Set(selectPlanningSkillRoles(catalog, understanding, []).map(({ skill }) => skill.id)),
      new Set(["discovered:docx", "discovered:pdf"]));
  }
});

test("structured document formats select their own builders without changing source-provider recall", async () => {
  const skills = await documentSkills;
  const source = {
    id: "data", name: "workforce-data", description: "Query workforce records and employee headcount.",
    agentLoop: { roles: ["source_provider"], artifactKinds: ["none"], sourceKinds: ["database"], qaKinds: [],
      intentExamples: ["查询员工人数"] },
  } as PrivateSkill;
  for (const [format, owner] of [["pdf", "pdf"], ["docx", "docx"], ["word", "docx"], [".pdf", "pdf"]]) {
    const understanding = understandTask({
      objective: "查询员工人数并生成报告", evidenceDemand: "source_grounded",
      resolvedTaskIntent: {
        schema: "agentloop.conversationTaskIntent/v1", operation: "composite", requiresExecution: true,
        deliverables: [{ targetId: "report", purpose: "员工人数报告", expectedArtifactCount: 1,
          action: "create", kind: "document", format, surface: "workspace_artifact" }],
      },
    });
    const selected = selectPlanningSkillRoles([...skills, source], understanding, []);
    assert.deepEqual(new Set(selected.map(({ skill }) => skill.id)), new Set([`discovered:${owner}`, source.id]));
    assert.equal(selected.find(({ skill }) => skill.id === source.id)?.selection.role, "source_provider");
  }
});

test("prior PDF transformation repairs the missing native Skill binding and passes final Admission", async () => {
  const goal = "你把第二部分和第三部分合并为一个文件，第二部分在前";
  const resolution: ConversationTurnResolution = {
    schema: "agentloop.conversationTurnResolution/v1", source: "model_guarded", mode: "execute",
    relation: "refine_prior", inputMode: "prior_artifact", targetRunId: "prior",
    targetArtifact: { runId: "prior", path: "outputs/part2.pdf" }, effectiveGoal: goal,
    taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "transform_artifact", requiresExecution: true,
      deliverables: [{ targetId: "merged", purpose: goal, expectedArtifactCount: 1, action: "transform",
        kind: "document", format: "pdf", surface: "workspace_artifact" }] },
    evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, evidenceDemand: "none",
    userConstraints: [], memoryAction: "none", memoryIntents: [],
  };
  const understanding = understandTask({ objective: goal, evidenceDemand: "none", targetArtifactKind: "document",
    resolvedTaskIntent: resolution.taskIntent });
  const selected = selectPlanningSkillRoles(await documentSkills, understanding, []);
  const skills = selected.map(({ skill }) => skill);
  const names = ["load_skill", "computer_read_file", "computer_write_file", "computer_run_command", "verify_artifact_acceptance"];
  const capabilities = [...planningCapabilitiesFromToolNames(names), ...planningCapabilitiesFromSkills(skills)];
  const runId = "merge-prior-pdf";
  const task: TaskSpec = {
    runId, canonicalState: createCanonicalRunState({ runId, userInput: goal, understanding, turnResolution: resolution, now: 1 }),
    availableSkills: skills, availableToolNames: names, availableCapabilities: capabilities,
    selectedSkillRoles: selected.map(({ selection }) => selection),
    conversationWorkingSet: { schema: "conversation.workset/v1", conversationId: "conversation", runCount: 1,
      planCursors: [], failedBoundaries: [], recommendedCapabilities: { skillIds: [], capabilityIds: [] },
      reusableArtifacts: [2, 3].map((part) => ({ runId: "prior", path: `outputs/part${part}.pdf`,
        name: `part${part}.pdf`, bytes: 1024, mimeType: "application/pdf", sourceTool: "computer_run_command", reusable: true })) },
  };
  let calls = 0;
  const planner = new ModelPlanner({
    limits: { contextWindowTokens: 40000, maxOutputTokens: 4096 },
    async complete(request) {
      calls += 1;
      if (calls === 2) {
        assert.match(request.runtimeContext?.content ?? "", /Eligible primary-builder Skill IDs:.*discovered:pdf/u);
        assert.doesNotMatch(request.runtimeContext?.content ?? "", /discovered:docx/u);
      }
      return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `plan-${calls}`, name: "submit_outcome_plan", arguments: {
        schema: "agentloop.outcomePlan/v2", goal, shape: "single_leaf", roundScope: null,
        selectedSkillRoles: calls === 1 ? [] : [{ skillId: "discovered:pdf", role: "primary_builder", reason: "Native PDF workflow." }],
        leaves: [{ id: "merge", objective: "Merge outputs/part2.pdf followed by outputs/part3.pdf and verify the resulting PDF.",
          requiredFacts: [], dependsOn: [], role: "produce", skillIds: calls === 1 ? [] : ["discovered:pdf"],
          requiredCapabilities: ["skill_instruction_load", "workspace_command_computation", "workspace_artifact_write", "artifact_acceptance"],
          sourceConstraint: null, targetIds: ["merged"], evidenceContract: {
            requiredKinds: ["artifact_path", "artifact_non_empty", "format_matches_request", "artifact_acceptance"], caveatPolicy: "none" } }],
      } }] };
    },
  }, { maxPlanningTurns: 2 });
  const proposal = await planner.plan(task);
  const plan = admitPlan({ runId, canonicalState: task.canonicalState, proposal, availableSkills: skills,
    availableToolNames: new Set(names), availableCapabilities: capabilities });
  assert.equal(calls, 2);
  assert.deepEqual(plan.steps[0]?.skillIds, ["discovered:pdf"]);
});
