import assert from 'node:assert/strict';
import test from 'node:test';
import { AppDatabase } from '../src/storage/database.ts';
import { PlanRepository } from '../src/planning/plan-repository.ts';
import { RunService } from '../src/runtime/run-service.ts';
import { SkillService } from '../src/skills/skill-service.ts';
import { ModelPlanner } from '../src/planning/planner.ts';
import { admitPlan } from '../src/planning/admission.ts';
import { createCanonicalRunState } from '../src/runtime/canonical-run-state.ts';
import { understandTask } from '../src/runtime/task-intent.ts';
import { planningCapabilitiesFromToolNames } from '../src/planning/step-execution-binding.ts';
import type { PlanProposal, RoundScope } from '../src/planning/contracts.ts';
import { TEST_MODEL_LIMITS, approvingTestAssessor } from './runtime-test-helpers.ts';

const goal = 'Research the supplied records, then decide how to explain the main problem and deliver an action plan.';
const scope: RoundScope = { kind: 'prerequisite', targetIds: ['report'], purpose: 'Identify the material problems before choosing a solution',
  completionBoundary: 'Record evidence-backed findings and remaining uncertainties', continuation: 'Plan actions based on the findings' };

function state() {
  return createCanonicalRunState({ runId: 'research-run', userInput: goal, understanding: understandTask({ objective: goal, evidenceDemand: 'source_grounded', resolvedTaskIntent: {
    schema: 'agentloop.conversationTaskIntent/v1', operation: 'analysis', requiresExecution: true,
    deliverables: [{ targetId: 'report', purpose: goal, expectedArtifactCount: 1, action: 'none', kind: 'none', surface: 'conversation' }],
  } }) });
}

function proposal(): PlanProposal {
  return { goal, roundScope: scope, selectedSkillIds: [], steps: [{ id: 'research', objective: scope.purpose, dependencies: [], role: 'fact_acquisition',
    skillIds: [], requiredCapabilities: ['web_research'], targetIds: [], evidenceContract: { requiredKinds: ['source_summary'], caveatPolicy: 'mark_unverified_facts' },
    successCriteria: [{ id: 'findings', description: scope.completionBoundary, source: 'planner' }] }] };
}

const toolNames = ['websearch', 'webfetch'];
const capabilities = planningCapabilitiesFromToolNames(toolNames);

test('an explicit prerequisite Round can advance one final target without owning or accepting it', () => {
  const canonicalState = state();
  const plan = admitPlan({ runId: canonicalState.runId, canonicalState, proposal: proposal(), availableSkills: [], availableToolNames: new Set(toolNames), availableCapabilities: capabilities });
  assert.equal(plan.roundScope?.kind, 'prerequisite');
  assert.deepEqual(plan.steps[0]!.executionBinding.targetIds, []);
  assert.equal(canonicalState.targets.report?.status, 'open');
  assert.ok(plan.steps[0]!.successCriteria.some((criterion) => criterion.id === 'round_completion'));
  for (const invalid of [
    { ...proposal(), roundScope: { ...scope, targetIds: ['invented'] } },
    { ...proposal(), steps: proposal().steps.map(step => ({ ...step, targetIds: ['report'] })) },
    { ...proposal(), steps: proposal().steps.map(step => ({ ...step, evidenceContract: undefined })) },
    { ...proposal(), roundScope: undefined },
  ]) assert.throws(() => admitPlan({ runId: canonicalState.runId, canonicalState, proposal: invalid, availableSkills: [], availableToolNames: new Set(toolNames), availableCapabilities: capabilities }));
});

test('ModelPlanner can submit a research-only Round and its scope survives Plan persistence', async () => {
  const canonicalState = state();
  const database = new AppDatabase(':memory:');
  try {
    const planner = new ModelPlanner({ limits: TEST_MODEL_LIMITS, complete: async () => ({ content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'research-plan', name: 'submit_outcome_plan', arguments: {
      schema: 'agentloop.outcomePlan/v2', goal, shape: 'single_leaf', roundScope: scope, selectedSkillRoles: [],
      leaves: [{ id: 'research', objective: scope.purpose, requiredFacts: [], dependsOn: [], role: 'fact_acquisition', skillIds: [], requiredCapabilities: ['web_research'],
        sourceConstraint: null, targetIds: [], evidenceContract: { requiredKinds: ['source_summary'], caveatPolicy: 'mark_unverified_facts' } }],
    } }] }) });
    const planned = await planner.plan({ runId: canonicalState.runId, canonicalState, availableSkills: [], availableToolNames: toolNames, availableCapabilities: capabilities });
    const plan = admitPlan({ runId: canonicalState.runId, canonicalState, proposal: planned, availableSkills: [], availableToolNames: new Set(toolNames), availableCapabilities: capabilities });
    await database.prepare("INSERT INTO runs(id, owner_user_id, depth, allow_dangerous_tools, status, input, created_at) VALUES (?, 'owner', 0, 0, 'running', ?, 1)").run(canonicalState.runId, goal);
    const stored = await new PlanRepository(database).create(plan);
    assert.deepEqual(stored.roundScope, scope);
    assert.deepEqual((await new PlanRepository(database).get(stored.id)).roundScope, scope);
  } finally { await database.close(); }
});

test('ModelPlanner admits Steer planning when the existing Plan and conversation bind the same prior Result', async () => {
  const original = state();
  const result = { schema: 'agentloop.resultRef/v1' as const, resultId: 'rr_2a24dead-6f66-49be-bc38-c29cc65d488c' };
  const canonicalState = { ...original, intent: { ...original.intent, turnResolution: {
    schema: 'agentloop.conversationTurnResolution/v1' as const, mode: 'execute' as const, relation: 'refine_prior' as const,
    inputMode: 'prior_result' as const, targetResult: result, effectiveGoal: goal,
    taskIntent: { schema: 'agentloop.conversationTaskIntent/v1' as const, operation: 'analysis' as const, requiresExecution: true,
      deliverables: [{ targetId: 'report', purpose: goal, expectedArtifactCount: 1, action: 'none' as const, kind: 'none' as const, surface: 'conversation' as const }] },
    evidenceStrategy: 'source_grounded' as const, evidenceDemand: 'source_grounded' as const,
    sourceBinding: { mode: 'none' as const, visibleDirectoryIds: [] }, userConstraints: [], memoryAction: 'none' as const, memoryIntents: [], source: 'model' as const,
  } } };
  let calls = 0;
  const planner = new ModelPlanner({ limits: TEST_MODEL_LIMITS, complete: async () => {
    calls++;
    return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'research-plan', name: 'submit_outcome_plan', arguments: {
      schema: 'agentloop.outcomePlan/v2', goal, shape: 'single_leaf', roundScope: scope, selectedSkillRoles: [],
      leaves: [{ id: 'research', objective: scope.purpose, requiredFacts: [], dependsOn: [], role: 'fact_acquisition', skillIds: [], requiredCapabilities: ['web_research'],
        sourceConstraint: null, targetIds: [], evidenceContract: { requiredKinds: ['source_summary'], caveatPolicy: 'mark_unverified_facts' } }],
    } }] };
  } });
  const planned = await planner.plan({ runId: canonicalState.runId, canonicalState, availableSkills: [], availableToolNames: toolNames,
    availableCapabilities: capabilities, roundResultBindings: [{ schema: 'agentloop.resultBinding/v1', result, relation: 'refine_prior' }] });
  assert.equal(planned.steps.length, 1);
  assert.equal(calls, 1, 'the Runtime must not ask the model to repair its own duplicate binding');
});

test('a single-target Run researches in Round one and reads its committed result before planning delivery', async () => {
  const database = new AppDatabase(':memory:');
  let planningCalls = 0, reads = 0, readPrior = false;
  let priorId = '';
  try {
    const runs = new RunService({ database, skills: new SkillService(database), assessorFactory: () => approvingTestAssessor(),
      tools: [{ name: 'read_records', description: 'Read input records', inputSchema: { type: 'object' }, executionMode: 'parallel', replaySafe: true,
        source: { id: 'records', transport: 'api', capabilities: [{ id: 'records.lookup', category: 'source_acquisition', sourceKinds: ['api'], producesEvidenceKinds: ['source_summary'] }] },
        parse: value => value, execute: async () => { reads++; return { value: { problem: 'Duplicate processing', total: 42 }, evidenceReceipt: {
          schema: 'agentloop.toolEvidenceReceipt/v1', sourceType: 'api', evidenceKinds: { satisfied: ['source_summary'], caveated: [], failed: [] } } }; } }],
      plannerFactory: () => ({ plan: async task => {
        planningCalls++;
        if (planningCalls === 1) return { ...proposal(), steps: proposal().steps.map(step => ({ ...step, requiredCapabilities: ['records.lookup'] })) };
        assert.equal(task.priorRoundResult?.roundNumber, 1);
        assert.deepEqual(task.targetScopeIds, ['report']);
        priorId = task.roundResultBindings![0]!.result.resultId;
        return { goal, selectedSkillIds: [], steps: [{ id: 'deliver', objective: 'Deliver actions based on the research result', dependencies: [], role: 'deliver',
          skillIds: [], requiredCapabilities: ['conversation_delivery'], targetIds: ['report'], successCriteria: [{ id: 'actions', description: 'Explain the problem and actions', source: 'task' }] }] };
      } }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        if (request.runId.startsWith('conversation-turn:')) return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'intent', name: 'resolve_conversation_turn', arguments: {
          mode: 'execute', relation: 'new_goal', inputMode: 'none', effectiveGoal: goal,
          taskIntent: { schema: 'agentloop.conversationTaskIntent/v1', operation: 'analysis', requiresExecution: true,
            deliverables: [{ targetId: 'report', purpose: goal, expectedArtifactCount: 1, action: 'none', kind: 'none', surface: 'conversation' }] },
          evidenceStrategy: 'none', sourceBinding: { mode: 'none', visibleDirectoryIds: [] }, userConstraints: [], memoryAction: 'none', memoryIntents: [], requiredCapabilityReferences: [],
        } }] };
        if (planningCalls === 1 && reads === 0) return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'source', name: 'read_records', arguments: {} }] };
        if (planningCalls === 2 && !readPrior) { readPrior = true; return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'prior', name: 'read_result', arguments: { resultId: priorId } }] }; }
        return { content: planningCalls === 1 ? 'Records show duplicate processing in 42 records.' : 'Reduce duplicate processing with one shared intake and measure the reduction.', finishReason: 'stop', toolCalls: [] };
      } }),
    });
    const start = await runs.executeConversation('owner', goal);
    for (let attempt = 0; attempt < 400 && (await runs.get('owner', start.id)).status === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    const finished = await runs.get('owner', start.id);
    assert.equal(finished.status, 'completed', JSON.stringify((await runs.events('owner', start.id)).filter(event => /fail|waiting|plan.proposed/.test(event.type))));
    assert.equal(planningCalls, 2); assert.equal(reads, 1); assert.equal(readPrior, true);
    assert.deepEqual((await runs.roundHistory('owner', start.id)).map(round => round.result?.decision.kind), ['next_round', 'complete_goal']);
    const events = await runs.events('owner', start.id);
    assert.ok(events.some(event => event.type === 'tool.completed' && event.data.toolName === 'read_result'));
  } finally { await database.close(); }
});
