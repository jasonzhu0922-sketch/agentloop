import assert from "node:assert/strict";
import test from "node:test";
import { planningMemoryPromptAugmentation } from "../src/runtime/memory-guidance.ts";
import type { PlanningMemoryProjection } from "../src/runtime/memory-plugin.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import type { RuntimeEvent } from "../src/runtime/contracts.ts";
import { TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

function projection(): PlanningMemoryProjection {
  return { schema: "agentloop.memoryProjection/v1", id: "projection", runId: "r", target: "planner", memoryEpoch: 1,
    memoryRevisionIds: ["revision"], retrievalReasons: [], contentHash: "hash", createdAt: 1, expiresAt: 10,
    relevantFacts: [], preferenceConstraints: [], planningPriors: [{ schema: "agentloop.planningPrior/v1", id: "prior", source: "experience_procedure",
      applicability: "Current document tool is compatible", strategy: "Render a document and inspect its pages",
      suggestedSteps: [{ objective: "Render {{document}} and inspect every page", toolNames: ["unavailable.render"], conditions: ["Current renderer is compatible"], verification: "Every current page is readable" }],
      scope: { conditions: ["Current renderer is compatible"], exclusions: ["Unverified renderer versions"] },
      reuse: { parameters: [{ name: "document", description: "Current document" }], verifiedScope: ["The verified renderer"], unverifiedScope: ["Other renderers"] },
      reusableKnowledge: [{ rule: "Check all pages" }, { rule: "UNVERIFIED RULE" }],
      failureLessons: [{ trigger: "Renderer v3", nextAction: "Recheck the current interface before retrying", applicability: ["Only the verified renderer version"] }],
      knowledgeBindings: [{ knowledgeId: "path", section: "classicPath" }, { knowledgeId: "rule", section: "reusableKnowledge", index: 0 }, { knowledgeId: "lesson", section: "failureLessons", index: 0 }],
      evidenceExpectations: [], warnings: ["Recheck renderer version"], confidence: 0.7, sourceRefs: ["revision"] }] };
}

test("execution receives only identity-bound knowledge and retains scope, rechecks and current-task parameters", async () => {
  const snapshot = projection(), before = JSON.stringify(snapshot);
  const augmentation = planningMemoryPromptAugmentation(snapshot)!;
  assert.match(augmentation.content, /Render \{\{document\}\}/);
  assert.match(augmentation.content, /Unverified renderer versions/);
  assert.match(augmentation.content, /Current Skill\/Tool contracts take precedence/);
  assert.match(augmentation.content, /Recheck renderer version/);
  assert.match(augmentation.content, /Only the verified renderer version/);
  assert.doesNotMatch(augmentation.content, /UNVERIFIED RULE/);
  assert.deepEqual(augmentation.provenance!.bindings, [
    { memoryRevisionId: "revision", knowledgeId: "path" }, { memoryRevisionId: "revision", knowledgeId: "rule" }, { memoryRevisionId: "revision", knowledgeId: "lesson" },
  ]);
  const events: RuntimeEvent[] = [], contexts: string[] = [];
  const state = createCanonicalRunState({ runId: "r", userInput: "Explain the current method", understanding: understandTask({ objective: "Explain the current method", toolNames: [] }), now: 1 });
  await runAgentLoop({ runId: "r", systemPrompt: "Explain the current method", input: "Explain the method", maxSteps: 1,
    currentDecisionContext: () => ({ canonicalState: state, stepId: "step-current" }),
    model: { limits: TEST_MODEL_LIMITS, complete: async request => { assert.deepEqual(request.tools, [], "a remembered tool name grants no capability"); contexts.push(request.runtimeContext!.content); return { content: "The current method", finishReason: "stop", toolCalls: [] }; } },
    grant: { runId: "r", actorUserId: "alice", depth: 0, allowedToolNames: new Set(), allowedSkillIds: new Set(), visibleDirectories: [], uploadedSources: [], skillExecutionRoots: [] },
    tools: new ToolRegistry([]), initialRuntimePromptAugmentations: [augmentation], emit: event => { events.push(event); } });
  assert.match(contexts[0]!, /recalled_method_guidance/);
  const activation = events.find(event => event.type === "prompt_augmentation.activated")!;
  assert.equal(activation.data.stepId, "step-current");
  assert.deepEqual((activation.data.augmentations as any[])[0].provenance, augmentation.provenance);
  assert.equal(JSON.stringify(snapshot), before);
});

test("identity-free and mismatched historical methods cannot manufacture an execution handoff", () => {
  const old = projection(); delete (old.planningPriors[0] as any).knowledgeBindings;
  assert.equal(planningMemoryPromptAugmentation(old), undefined);
  const foreign = projection(); (foreign.planningPriors[0] as any).sourceRefs = ["foreign-revision"];
  assert.equal(planningMemoryPromptAugmentation(foreign), undefined);
});
