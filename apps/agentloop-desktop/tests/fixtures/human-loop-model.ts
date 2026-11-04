import assert from 'node:assert/strict';
import type { HumanLoopRequirement, ModelAdapter, ModelResponse } from '@zhujun/agentloop';
import { greetingModel } from '../../../../packages/agentloop-local-runtime/tests/fixtures/models.ts';

export const selectionRequirement: HumanLoopRequirement = {
  kind: 'selection', title: '请选择如何继续', prompt: '请选择要使用的信息范围。', rationale: '不同范围会影响结果。', evidenceRefs: [],
  responseSchema: { type: 'select', minSelections: 1, maxSelections: 1, options: [{ id: 'summary', label: '使用已有摘要' }, { id: 'details', label: '补充详细内容' }] },
  resume: { mode: 'continue_step' },
};

/** Deterministic provider, real planner/tool/persistence/recovery/assessment. */
export function humanLoopModel(requirement = selectionRequirement, onResume: (context: string) => void = () => {}): ModelAdapter {
  const base = greetingModel(); let asked = false;
  const call = (name: string, args: unknown): ModelResponse => ({ content: '', finishReason: 'tool_calls', toolCalls: [{ id: name, name, arguments: args }] });
  return { limits: base.limits, async complete(input, signal) {
    if (input.tools.some(tool => tool.name === 'resolve_conversation_turn')) {
      const response = await base.complete(input, signal);
      return { ...response, toolCalls: response.toolCalls.map(tool => ({ ...tool, arguments: {
        ...(tool.arguments as Record<string, unknown>), mode: 'execute', effectiveGoal: '请根据用户选择回答',
        taskIntent: { schema: 'agentloop.conversationTaskIntent/v1', operation: 'answer', requiresExecution: true,
          deliverables: [{ targetId: 'answer', purpose: '根据用户选择回答', expectedArtifactCount: 1, action: 'none', kind: 'none', surface: 'conversation' }] },
      } })) };
    }
    if (input.tools.some(tool => tool.name === 'submit_outcome_plan')) return call('submit_outcome_plan', {
      schema: 'agentloop.outcomePlan/v2', goal: '请根据用户选择回答', shape: 'single_leaf', selectedSkillRoles: [],
      leaves: [{ id: 'answer', objective: '根据用户选择回答', requiredFacts: [], dependsOn: [], role: 'deliver', skillIds: [], requiredCapabilities: [], sourceConstraint: null, evidenceContract: null, targetIds: ['answer'] }],
    });
    if (input.tools.some(tool => tool.name === 'submit_assessment')) return base.complete(input, signal);
    if (!asked) { asked = true; assert.ok(input.tools.some(tool => tool.name === 'request_human_loop')); return call('request_human_loop', requirement); }
    onResume(input.runtimeContext?.content ?? '');
    return { content: '已收到用户回答并完成原任务。', finishReason: 'stop', toolCalls: [] };
  } };
}
