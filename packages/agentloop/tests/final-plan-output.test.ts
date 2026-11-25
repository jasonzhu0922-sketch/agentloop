import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { admitPlan } from "../src/planning/admission.ts";
import type { ExecutionPlan } from "../src/planning/contracts.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import { acceptedCanonicalDelivery, createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { CanonicalRunStateRepository } from "../src/runtime/canonical-run-state-repository.ts";
import { finalPlanOutput, RunService } from "../src/runtime/run-service.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { approvingTestAssessor, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

function conversationDeliverables(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    targetId: `answer-${index}`, purpose: `独立结果 ${index + 1}`, expectedArtifactCount: 1,
    action: "none" as const, kind: "none" as const, surface: "conversation" as const,
  }));
}

function outputFixture(outputs: readonly (string | undefined)[]) {
  const goal = "分别交付所有独立结果。";
  const deliverables = conversationDeliverables(outputs.length);
  const state = createCanonicalRunState({ runId: "final-output", userInput: goal,
    understanding: understandTask({ objective: goal, resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true, deliverables,
    } }) });
  const admitted = admitPlan({ runId: state.runId, canonicalState: state, availableSkills: [], availableToolNames: new Set(),
    proposal: { goal, selectedSkillIds: [], steps: outputs.map((_output, index) => ({
      id: `terminal-${index}`, objective: deliverables[index].purpose, dependencies: [], skillIds: [],
      requiredCapabilities: ["conversation_delivery"], targetIds: [deliverables[index].targetId],
      successCriteria: [{ id: "answer", description: "交付独立结果。", source: "task" }],
    })) } });
  const plan: ExecutionPlan = { ...admitted, status: "completed", steps: admitted.steps.map((step, index) => ({
    ...step, status: "completed", output: outputs[index], finishedAt: 100 - index,
  })) };
  return { plan, state };
}

test("terminal outputs use plan order, omit empty text and keep Markdown intact", () => {
  const { plan, state } = outputFixture(["  ## 结果 A\n\n- 第一项  ", undefined, " \n ", "**结果 B**\n\n第二项"]);
  const output = finalPlanOutput(plan, state);
  assert.equal(output, "## 结果 A\n\n- 第一项\n\n**结果 B**\n\n第二项");
  assert.throws(() => JSON.parse(output));
  assert.doesNotMatch(output, /"stepId"|terminal-/);
});

test("identical terminal outputs remain separate independent deliveries", () => {
  const { plan, state } = outputFixture(["结果相同", "结果相同"]);
  assert.equal(finalPlanOutput(plan, state), "结果相同\n\n结果相同");
});

test("one terminal output retains its original whitespace and Markdown bytes", () => {
  const original = "  ## 结果 A\n\n- 保留结尾两个空格  \n\n";
  const { plan, state } = outputFixture([original]);
  assert.equal(finalPlanOutput(plan, state), original);
});

test("only active terminal leaves contribute text after step retirement", () => {
  const { plan, state } = outputFixture(["中间结果", "结果 A", "结果 B"]);
  const retired = { ...plan.steps[1], id: "retired", retiredAt: 1, output: "过时的末端正文" };
  const milestone = { ...plan.steps[1], id: "milestone", kind: "milestone" as const, output: "内部里程碑" };
  const revised = { ...plan, steps: [retired, milestone, plan.steps[0],
    { ...plan.steps[1], dependencies: [plan.steps[0].id] }, plan.steps[2]] };
  assert.equal(finalPlanOutput(revised, state), "结果 A\n\n结果 B");
});

for (const outputs of [["结果 A", "结果 B"], ["相同结果", "相同结果"], ["## 单个结果\n\n正文"]]) {
  test(`Run completion persists readable output without an extra model summary (${outputs.length} terminals, ${outputs[0]})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agentloop-final-output-"));
    const database = new AppDatabase(":memory:");
    const deliverables = conversationDeliverables(outputs.length);
    const stepIds = outputs.map((_output, index) => `terminal-${index}`);
    const executionCalls: string[] = [];
    const goal = "分别给出每个独立目标的结果。";
    try {
      const runs = new RunService({ database, workspaceRoot: root, skills: new SkillService(database),
        plannerFactory: () => ({ plan: async () => ({ goal, selectedSkillIds: [], steps: stepIds.map((id, index) => ({
          id, objective: deliverables[index].purpose, dependencies: [], skillIds: [],
          requiredCapabilities: ["conversation_delivery"], targetIds: [deliverables[index].targetId],
          successCriteria: [{ id: "answer", description: "交付独立结果。", source: "task" }],
        })) }) }),
        assessorFactory: approvingTestAssessor,
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
          if (request.runId.startsWith("conversation-turn:")) return { content: "", finishReason: "tool_calls", toolCalls: [{
            id: "resolve", name: "resolve_conversation_turn", arguments: {
              mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: goal,
              evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
              userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
              taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true, deliverables },
            },
          }] };
          const frame = JSON.parse(request.runtimeContext!.content.match(/<loop_step_frame source="server">\n([^\n]+)\n/)![1]);
          const stepId = frame.currentDecisionView.identity.stepId;
          assert.ok(stepIds.includes(stepId), "no new summary step is permitted");
          executionCalls.push(stepId);
          return { content: outputs[stepIds.indexOf(stepId)], finishReason: "stop", toolCalls: [] };
        } }),
      });
      const run = await runs.executeConversation("owner", goal);
      const expected = outputs.join("\n\n");
      assert.equal(run.status, "completed");
      assert.equal(run.output, expected);
      assert.doesNotMatch(run.output!, /^\s*\[|"stepId"|terminal-/);
      assert.deepEqual(executionCalls, stepIds, "only the original terminal steps call the model");
      assert.equal((await database.prepare("SELECT output FROM runs WHERE id = ?").get<{ output: string }>(run.id))!.output, expected);
      const events = await runs.events("owner", run.id);
      for (const type of ["terminal.delivery_committed", "run.completed"]) {
        assert.equal(events.find(event => event.type === type)?.data.output, expected);
      }
      const { plan } = await runs.plan("owner", run.id);
      assert.deepEqual(plan.steps.map(step => ({ stepId: step.id, output: step.output })), stepIds.map((stepId, index) => ({ stepId, output: outputs[index] })));
      assert.deepEqual(events.filter(event => event.type === "plan.step.completed").map(event => event.data.stepId), stepIds);
    } finally { database.close(); await rm(root, { recursive: true, force: true }); }
  });
}

for (const recovery of [false, true]) {
  test(`independent accepted artifact targets and unique final links survive completion (recovery=${recovery})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agentloop-final-artifacts-"));
    const database = new AppDatabase(":memory:");
    const goal = "交付两份独立 HTML 文件及各自的说明。";
    const artifacts = ["first", "second"].map(id => ({ targetId: id, purpose: `${id} file`, expectedArtifactCount: 1,
      action: "create" as const, kind: "html" as const, surface: "workspace_artifact" as const }));
    const deliverables = [...artifacts, ...conversationDeliverables(2)];
    const html = "<!doctype html><html><meta charset='utf-8'><title>Result</title><body><h1>Result</h1><p>Supplied data.</p></body></html>";
    const outputs = ["结果 A\n\n[第一份](first.html)", "结果 B"];
    const written = new Set<string>();
    let acceptedBefore: unknown;
    let recoveries = 0;
    try {
      const steps = ["first", "second"].map((id, index) => ({ id, objective: `交付第 ${index + 1} 份文件和说明。`,
        dependencies: [], skillIds: [], requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance", "conversation_delivery"],
        targetIds: [id, `answer-${index}`], successCriteria: [{ id: "delivery", description: "交付文件和说明。", source: "task" as const }],
      }));
      const runs = new RunService({ database, workspaceRoot: root, skills: new SkillService(database), maxSteps: 6,
        plannerFactory: () => ({ plan: async () => ({ goal, selectedSkillIds: [], steps: recovery ? [{
          ...steps[0], id: "mixed", objective: goal, targetIds: deliverables.map(target => target.targetId),
        }] : steps }) }),
        assessorFactory: () => ({ assess: async input => {
          const base = await approvingTestAssessor().assess(input);
          if (input.step.id !== "mixed") return base;
          return { ...base, approved: false,
            criteria: base.criteria.map(criterion => criterion.targetId?.startsWith("answer-") ? { ...criterion, satisfied: false } : criterion),
            feedback: "保留已接受的文件，只修复未完成的说明。", failedBoundary: { stepId: "mixed", missingEvidenceKinds: [],
              violatedSkillRequirements: [], reusableEvidenceRefs: [], suggestedRepairShape: "revise_plan" as const,
              unmetCriteria: [0, 1].map(index => ({ criterionId: `delivery_target:answer-${index}`, targetId: `answer-${index}`,
                status: "unverified" as const, rationale: "说明待修复。", evidenceRefs: [] })),
            } };
        } }),
        recoveryPlannerFactory: () => ({ decide: async input => {
          recoveries += 1;
          acceptedBefore = artifacts.map(target => input.canonicalState.targets[target.targetId]);
          assert.ok(artifacts.every(target => acceptedCanonicalDelivery(input.canonicalState.targets[target.targetId]) !== undefined));
          return { actionId: input.action.id, expectedActionRevision: input.action.revision, decision: "revise_plan" as const,
            rationale: "只替换未完成的说明，文件归 Run 所有。", evidenceRefs: [], planRevision: {
              shape: "recovery_patch" as const, goal, selectedSkillIds: [], retainedStepIds: [],
              steps: steps.map((step, index) => ({ ...step, id: `${step.id}-repair`, targetIds: [`answer-${index}`],
                requiredCapabilities: ["conversation_delivery"] })),
            } };
        } }),
        planRevisionAssessorFactory: () => ({ assess: async () => ({ approved: true, feedback: "", evidenceRefs: [] }) }),
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
          if (request.runId.startsWith("conversation-turn:")) return { content: "", finishReason: "tool_calls", toolCalls: [{
            id: "resolve", name: "resolve_conversation_turn", arguments: {
              mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: goal,
              evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
              userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
              taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true, deliverables },
            },
          }] };
          const frame = JSON.parse(request.runtimeContext!.content.match(/<loop_step_frame source="server">\n([^\n]+)\n/)![1]);
          const stepId = frame.currentDecisionView.identity.stepId;
          const fileIds = stepId === "mixed" ? ["first", "second"] : stepId.endsWith("-repair") ? [] : [stepId];
          const fileId = fileIds.find(id => !written.has(id));
          if (fileId !== undefined) {
            written.add(fileId);
            return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `write-${fileId}`, name: "computer_write_file",
              arguments: { path: `${fileId}.html`, content: html, deliveryTargetId: fileId } }] };
          }
          return { content: stepId === "mixed" ? "已淘汰步骤的旧正文" : outputs[stepId.startsWith("first") ? 0 : 1], finishReason: "stop", toolCalls: [] };
        } }),
      });
      const run = await runs.executeConversation("owner", goal, { allowDangerousTools: true });
      assert.equal(run.status, "completed");
      assert.equal(run.output, `${outputs.join("\n\n")}\n\n[second file](second.html)`);
      assert.doesNotMatch(run.output!, /"stepId"|mixed|repair|已淘汰/);
      assert.equal(recoveries, recovery ? 1 : 0);
      assert.equal(written.size, 2);
      const state = await new CanonicalRunStateRepository(database).get(run.id);
      assert.equal(state.phase, "completed");
      assert.ok(Object.values(state.targets).every(target => acceptedCanonicalDelivery(target) !== undefined));
      if (recovery) assert.deepEqual(artifacts.map(target => state.targets[target.targetId]), acceptedBefore);
      const events = await runs.events("owner", run.id);
      const workspace = String(events.find(event => event.type === "run.started")!.data.workspaceRoot);
      for (const { targetId } of artifacts) {
        const target = state.targets[targetId];
        const accepted = acceptedCanonicalDelivery(target)!;
        const binding = target.artifactBinding!;
        const content = await readFile(join(workspace, binding.path));
        assert.equal(binding.path, `${targetId}.html`);
        assert.ok(binding.versionId);
        assert.equal(binding.sha256, createHash("sha256").update(content).digest("hex"));
        assert.equal(binding.bytes, content.length);
        const realization = accepted.artifacts?.[0] ?? accepted.artifact!;
        assert.equal(realization.path, binding.path);
        assert.equal(realization.versionId, binding.versionId);
        assert.equal(realization.sha256, binding.sha256);
        assert.ok(realization.acceptanceToolCallId);
        assert.equal(run.output!.split(`](${targetId}.html)`).length - 1, 1);
      }
      const plan = await new PlanRepository(database).getByRun(run.id);
      assert.equal(plan.steps.find(step => step.id === "mixed")?.retiredAt !== undefined, recovery);
      assert.equal(events.filter(event => event.type === "terminal.delivery_committed").length, 1);
    } finally { database.close(); await rm(root, { recursive: true, force: true }); }
  });
}
