import assert from "node:assert/strict";
import type { ModelAdapter, ModelInvocation } from "@zhujun/agentloop";
import type { LocalModelProviderPort } from "@zhujun/agentloop-local-runtime";

/** Exercises the real Kernel with deterministic model responses, never a provider/network. */
export function greetingModel(onInvocation: (input: ModelInvocation) => void = () => {}): ModelAdapter {
  return {
    limits: { contextWindowTokens: 128_000, maxOutputTokens: 8192 },
    async complete(input) {
      onInvocation(input);
      if (input.tools.some(tool => tool.name === "resolve_conversation_turn")) return {
        content: "", finishReason: "tool_calls", toolCalls: [{ id: "intent", name: "resolve_conversation_turn", arguments: {
          mode: "reply", relation: "new_goal", inputMode: "none", effectiveGoal: "Greet the user.",
          taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: false,
            deliverables: [{ targetId: "greeting", purpose: "Greet the user.", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
          evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [],
          memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
        } }],
      };
      const assessment = input.tools.find(tool => tool.name === "submit_assessment");
      if (assessment) {
        const schema = assessment.inputSchema as { properties: { criteria: { items: { properties: { criterionId: { enum: string[] } } } } } };
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "assessment", name: "submit_assessment", arguments: {
          criteria: schema.properties.criteria.items.properties.criterionId.enum.map(criterionId => ({
            criterionId, satisfied: true, rationale: "The greeting is present.", evidenceRefs: ["candidateOutput"],
            contractCheck: { status: "valid", rationale: "A conversation greeting needs no artifact." },
          })), skills: [], feedback: "", failedBoundary: null,
        } }] };
      }
      return { content: "你好，本机 Runtime 已完成这次回复。", finishReason: "stop", toolCalls: [] };
    },
  };
}

export function modelPort(model = greetingModel()): LocalModelProviderPort {
  return { modelKeys: () => ["test"], create(key) { assert.equal(key, "test"); return model; } };
}
