import assert from "node:assert/strict";
import test from "node:test";
import { admitPlan } from "../src/planning/admission.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ContextAssembler } from "../src/runtime/context-assembler.ts";
import type { ModelMessage } from "../src/runtime/contracts.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import { reconstructRecoveryTranscript } from "../src/runtime/recovery-transcript.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { RuntimeResultRepository } from "../src/runtime/runtime-result-repository.ts";
import { createRuntimeResult, parseRuntimeResult, type RuntimeResultRef } from "../src/runtime/runtime-result.ts";
import { StepResultCommitter } from "../src/runtime/step-result-committer.ts";
import { AppError } from "../src/shared/errors.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { createResultTool } from "../src/tools/result-tool.ts";
import { ToolRegistry, type RuntimeTool } from "../src/tools/tool-registry.ts";
import { singleStepTestPlanner, testOwner } from "./runtime-test-helpers.ts";

const runId = "tool-result-ref-run";
const planId = "tool-result-ref-plan";
const stepId = "inspect-values";

async function seedRun(database: AppDatabase): Promise<void> {
  const owner = testOwner();
  const now = Date.now();
  await database.prepare(`
    INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
    VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
  `).run(runId, owner.user.id, "inspect exact values", now);
  await database.prepare(`
    INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, input_bindings_json, status, created_at, updated_at)
    VALUES (?, ?, 1, ?, '[]', '[]', 'running', ?, ?)
  `).run(planId, runId, "inspect exact values", now, now);
}

test("successful Tool Actions atomically bind a unified opaque result ref and authorize exact bounded reads", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await seedRun(database);
    const actions = new RuntimeActionRepository(database);
    const results = new RuntimeResultRepository(database);
    let ref: RuntimeResultRef | undefined;
    const value = await actions.execute({
      runId,
      planId,
      stepId,
      kind: "tool_call",
      replayPolicy: "safe",
      deadlineMs: 1_000,
      metadata: { toolCallId: "read-values", toolName: "computer_read_json" },
      prepareResult: async (result, action) => {
        const runtimeResult = createRuntimeResult({
          kind: "tool",
          producer: {
            actionId: action.id,
            runId,
            planId,
            stepId,
            toolCallId: "read-values",
            toolName: "computer_read_json",
          },
          value: result,
          publication: { status: "committed" },
        });
        ref = runtimeResult.ref;
        return runtimeResult;
      },
    }, async () => ({
      schema: "agentloop.jsonRead/v1",
      queries: [{ pointer: "/records", value: [{ id: 7, amount: 12.5 }, { id: 8, amount: 19.75 }] }],
    }));
    assert.equal(value.queries[0]?.value[1]?.amount, 19.75);
    assert.ok(ref);

    const action = (await actions.list(runId))[0];
    assert.equal(action?.state, "succeeded");
    assert.equal(action?.resultRef, ref.resultId);
    const committed = await database.prepare(`
      SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'action.result_committed'
    `).get(runId) as { payload_json: string };
    assert.equal(JSON.parse(committed.payload_json).resultRef, ref.resultId);

    const reader = new ToolRegistry([createResultTool(results)]).materialize(createCapabilityGrant({
      actorUserId: testOwner().user.id,
      runId,
      planId,
      stepId,
      depth: 0,
      allowedToolNames: ["read_result"],
      allowedSkillIds: [],
    }));
    const prepared = reader.prepare({
      id: "recover-values",
      name: "read_result",
      arguments: { resultId: ref.resultId, pointer: "/queries/0/value", offset: 1, limit: 1 },
    });
    const recovered = await prepared.tool.execute({ grant: createCapabilityGrant({
      actorUserId: testOwner().user.id,
      runId,
      planId,
      stepId,
      depth: 0,
      allowedToolNames: ["read_result"],
      allowedSkillIds: [],
    }) }, prepared.input) as Record<string, any>;
    assert.deepEqual(recovered.value, [{ id: 8, amount: 19.75 }]);
    assert.deepEqual(recovered.sourceResultRef, ref);
    assert.equal(JSON.stringify(prepared.input).includes("sha256"), false);
    assert.equal(JSON.stringify(prepared.input).includes(".agentloop"), false);

    const wrongStep = await results.readAuthorized({ resultId: ref.resultId, runId, planId, stepId: "other-step" });
    assert.equal(wrongStep, undefined, "an opaque ref must not cross the granted Plan step");
  } finally {
    await database.close();
  }
});

test("Runtime result parsing rejects payloads whose Runtime-owned integrity metadata was altered", () => {
  const result = createRuntimeResult({
    kind: "run",
    producer: { runId: "integrity-run" },
    value: "canonical output",
    publication: { status: "published" },
  });
  assert.equal(parseRuntimeResult(result)?.ref.resultId, result.ref.resultId);
  assert.equal(parseRuntimeResult({
    ...result,
    payload: { ...result.payload, content: "altered output" },
  }), undefined);
});

test("AgentLoop exposes the Runtime-owned ref alongside the current exact result", async () => {
  const ref = { schema: "agentloop.resultRef/v1", resultId: "rr_00000000-0000-4000-8000-000000000001" } as const;
  let turns = 0;
  const result = await runAgentLoop({
    runId,
    input: "read one exact value",
    systemPrompt: "Use the Tool result.",
    tools: new ToolRegistry([{
      name: "computer_read_json",
      description: "test structured read",
      inputSchema: { type: "object" },
      executionMode: "parallel",
      replaySafe: true,
      parse: (input) => input,
      execute: async () => ({
        schema: "agentloop.jsonRead/v1",
        queries: [{ pointer: "/rows", value: [{ name: "alpha", score: 97 }] }],
        caveats: [],
      }),
    }]),
    availableSkills: [],
    maxSteps: 2,
    grant: createCapabilityGrant({
      actorUserId: "owner",
      runId,
      planId,
      stepId,
      depth: 0,
      allowedToolNames: ["computer_read_json"],
      allowedSkillIds: [],
    }),
    actionTracker: {
      executeToolCall: async (_input, operation) => ({ value: await operation(), resultRef: ref }),
    },
    model: {
      limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
      complete: async (input) => {
        turns += 1;
        if (turns === 1) return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "read", name: "computer_read_json", arguments: {} }],
        };
        const tool = input.messages.findLast((message) => message.role === "tool");
        assert.ok(tool && tool.role === "tool");
        const parsed = JSON.parse(tool.content);
        assert.equal(parsed.queries[0].value[0].score, 97);
        assert.deepEqual(parsed.resultRef, ref);
        return { content: "score=97", finishReason: "stop", toolCalls: [] };
      },
    },
  });
  assert.equal(result.output, "score=97");
});

test("RunService gives every successful Tool Action a persisted ref and emits it with the Tool result", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const skills = new SkillService(database);
    const tool: RuntimeTool<unknown> = {
      name: "structured_read",
      description: "Return exact structured values",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      executionMode: "parallel",
      replaySafe: true,
      parse: (input) => input,
      execute: async () => ({ schema: "example.values/v1", values: [3, 5, 8] }),
    };
    let calls = 0;
    const runs = new RunService({
      database,
      skills,
      tools: [tool],
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => ({
        assess: async (input) => ({
          id: "assessment",
          planId: input.planId,
          stepId: input.step.id,
          attempt: input.attempt,
          assessmentProfile: input.assessmentProfile,
          assessmentMethod: "model" as const,
          approved: true,
          criteria: input.step.successCriteria.map((criterion) => ({ criterionId: criterion.id, satisfied: true, evidenceRefs: ["structured"] })),
          skills: [],
          evidenceDigest: "structured-read",
          feedback: "approved",
          createdAt: Date.now(),
        }),
      }),
      modelFactory: () => ({
        limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
        complete: async (input) => {
          calls += 1;
          if (calls === 1) return {
            content: "",
            finishReason: "tool_calls" as const,
            toolCalls: [{ id: "values-1", name: "structured_read", arguments: {} }],
          };
          const result = input.messages.findLast((message) => message.role === "tool" && message.name === "structured_read");
          assert.ok(result && result.role === "tool");
          assert.equal(JSON.parse(result.content).values[2], 8);
          return { content: "values inspected", finishReason: "stop" as const, toolCalls: [] };
        },
      }),
      maxSteps: 2,
    });
    const run = await runs.execute(owner.user.id, "inspect values");
    assert.equal(run.status, "completed");
    const action = (await runs.actionsForRun(owner.user.id, run.id)).find((item) => item.kind === "tool_call");
    assert.match(action?.resultRef ?? "", /^rr_/u);
    const row = await database.prepare("SELECT metadata_json FROM runtime_actions WHERE id = ?")
      .get(action!.id) as { metadata_json: string };
    const storedResult = JSON.parse(row.metadata_json).runtimeResult;
    assert.equal(storedResult.ref.resultId, action?.resultRef);
    assert.deepEqual(JSON.parse(storedResult.payload.content).values, [3, 5, 8]);
    const completed = (await runs.events(owner.user.id, run.id)).find((event) =>
      event.type === "tool.completed" && event.data.toolCallId === "values-1"
    );
    assert.equal((completed?.data.resultRef as { resultId?: string } | undefined)?.resultId, action?.resultRef);
    assert.equal(JSON.parse(String(completed?.data.result)).resultRef, undefined);
  } finally {
    await database.close();
  }
});

test("recovery reconstructs the model-visible ref from canonical Tool result plus persisted ref metadata", () => {
  const ref = { schema: "agentloop.resultRef/v1", resultId: "rr_00000000-0000-4000-8000-000000000003" } as const;
  const transcript = reconstructRecoveryTranscript({
    userInput: "inspect values",
    stepId,
    events: [
      { seq: 1, type: "plan.step.started", data: { stepId } },
      { seq: 2, type: "assistant.committed", data: {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "values", name: "structured_read", arguments: {} }],
      } },
      { seq: 3, type: "tool.completed", data: {
        toolCallId: "values",
        toolName: "structured_read",
        result: JSON.stringify({ schema: "example.values/v1", values: [13, 21] }),
        resultRef: ref,
        invocationStatus: "completed",
        operationStatus: "succeeded",
        isError: false,
      } },
    ],
  });
  const result = transcript.messages.find((message) => message.role === "tool");
  assert.ok(result && result.role === "tool");
  assert.deepEqual(JSON.parse(result.content).resultRef, ref);
});

test("consumed and compacted structured reads keep a deterministic Tool result catalog even when the summary omits it", async () => {
  const ref = { schema: "agentloop.resultRef/v1", resultId: "rr_00000000-0000-4000-8000-000000000002" } as const;
  const messages: ModelMessage[] = [
    { role: "user", content: "inspect records" },
    { role: "assistant", content: "", toolCalls: [{ id: "read", name: "computer_read_json", arguments: { path: "data.json" } }] },
    { role: "tool", toolCallId: "read", name: "computer_read_json", isError: false, content: JSON.stringify({
      schema: "agentloop.jsonRead/v1",
      path: "data.json",
      sha256: "a".repeat(64),
      root: { type: "object" },
      queries: [{ pointer: "/records", offset: 0, limit: 2, value: [{ id: 1 }, { id: 2 }] }],
      caveats: [],
      resultRef: ref,
    }) },
    { role: "assistant", content: "I consumed the exact rows. " + "old reasoning ".repeat(5_000), toolCalls: [{ id: "next", name: "noop", arguments: {} }] },
    { role: "tool", toolCallId: "next", name: "noop", isError: false, content: JSON.stringify({ ok: true }) },
  ];
  let summaryCalls = 0;
  const context = new ContextAssembler({
    runId,
    systemPrompt: "Inspect evidence.",
    runtimeContext: { phase: "execution", content: "Continue the admitted step." },
    policy: { proactiveCompactionTokens: 3_000, preserveRecentTokens: 1_000, pruneProtectTokens: 100 },
    model: {
      limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
      complete: async () => {
        summaryCalls += 1;
        return {
          content: "## Goal\nInspect records\n## Progress\n### Done\n- Read records\n### In Progress\n- Continue\n### Blocked\n- none\n## Key Decisions\n- none\n## Evidence\n- intentionally omitted id\n## Next Steps\n1. Continue\n## Critical Context\n- none",
          finishReason: "stop",
          toolCalls: [],
        };
      },
    },
  });
  context.setPromptProjectionPolicy({
    schema: "agentloop.promptProjectionPolicy/v1",
    policyId: "tool-result-ref-test",
    instruction: "",
    mode: "action_aware",
    largeToolResultProjectionCharacters: 2_048,
    largeToolResultPreviewCharacters: 800,
  });
  const assembly = await context.assemble(messages, []);
  assert.ok(summaryCalls > 0);
  assert.match(assembly.runtimeContext.content, /agentloop\.runtimeResultCatalog\/v1/);
  assert.match(assembly.runtimeContext.content, new RegExp(ref.resultId));
  assert.match(assembly.runtimeContext.content, /read_result/);
  assert.doesNotMatch(assembly.runtimeContext.content, /\.agentloop\/content-refs/);
  assert.doesNotMatch(assembly.runtimeContext.content, /"sha256":"a{64}"/);

  const restarted = new ContextAssembler({
    runId,
    systemPrompt: "Inspect evidence.",
    runtimeContext: { phase: "execution", content: "Continue the admitted step." },
    model: { limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 }, complete: async () => {
      throw new Error("restart should not compact this bounded transcript");
    } },
  });
  const restored = await restarted.assemble(messages.slice(0, 3), []);
  assert.match(restored.runtimeContext.content, new RegExp(ref.resultId));
});

test("an assessed Step result becomes the next Step's formal readable input", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const skills = new SkillService(database);
    let dependencyResultId = "";
    let consumed = false;
    const runs = new RunService({
      database,
      skills,
      plannerFactory: () => ({
        plan: async (task) => ({
          schema: "agentloop.outcomePlan/v2",
          shape: "fact_then_produce",
          goal: task.input,
          selectedSkillIds: [],
          selectedSkillRoles: [],
          steps: [{
            id: "produce-result",
            objective: "Publish the exact first-step value.",
            dependencies: [],
            role: "fact_acquisition",
            skillIds: [],
            requiredCapabilities: ["conversation_delivery"],
            successCriteria: [{ id: "produced", description: "The value is published.", source: "planner" }],
          }, {
            id: "consume-result",
            objective: "Read and use the formal first-step result.",
            dependencies: ["produce-result"],
            role: "deliver",
            skillIds: [],
            requiredCapabilities: ["conversation_delivery"],
            successCriteria: [{ id: "consumed", description: "The published value is consumed.", source: "planner" }],
          }],
        }),
      }),
      assessorFactory: () => ({
        assess: async (input) => ({
          id: `assessment-${input.step.id}`,
          planId: input.planId,
          stepId: input.step.id,
          attempt: input.attempt,
          assessmentProfile: input.assessmentProfile,
          assessmentMethod: "model" as const,
          approved: true,
          criteria: input.step.successCriteria.map((criterion) => ({
            criterionId: criterion.id,
            satisfied: true,
            evidenceRefs: ["candidateOutput"],
          })),
          skills: [],
          evidenceDigest: input.step.id,
          feedback: "approved",
          createdAt: Date.now(),
        }),
      }),
      modelFactory: () => ({
        limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
        complete: async (request) => {
          const context = request.runtimeContext?.content ?? "";
          if (context.includes('"id":"produce-result"')) {
            return { content: "first-step-value=42", finishReason: "stop" as const, toolCalls: [] };
          }
          const toolResult = request.messages.findLast((message) => message.role === "tool" && message.name === "read_result");
          if (toolResult?.role === "tool") {
            const read = JSON.parse(toolResult.content) as { content: string };
            assert.equal(read.content, "first-step-value=42");
            consumed = true;
            return { content: `consumed:${read.content}`, finishReason: "stop" as const, toolCalls: [] };
          }
          const match = /"resultId":"(rr_[0-9a-f-]{36})"/u.exec(context);
          assert.ok(match?.[1], "the downstream context must bind the published dependency result");
          dependencyResultId = match[1];
          return {
            content: "",
            finishReason: "tool_calls" as const,
            toolCalls: [{ id: "read-dependency", name: "read_result", arguments: { resultId: dependencyResultId } }],
          };
        },
      }),
      maxSteps: 3,
    });

    const run = await runs.execute(owner.user.id, "publish then consume one formal result");
    assert.equal(run.status, "completed");
    assert.equal(consumed, true);
    const plan = await new PlanRepository(database).getByRun(run.id);
    const first = plan.steps.find((step) => step.id === "produce-result")!;
    const second = plan.steps.find((step) => step.id === "consume-result")!;
    assert.equal(first.evidence?.publishedResult?.ref.resultId, dependencyResultId);
    assert.equal(first.evidence?.publishedResult?.publication.assessmentRef, "assessment-produce-result");
    assert.ok(second.evidence?.publishedResult?.inputs.some((ref) => ref.resultId === dependencyResultId));
  } finally {
    await database.close();
  }
});

test("Step result publication accepts only Assessment-owned non-blocking caveats", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES ('step-result-publication-run', 'result-owner', NULL, 0, 0, 'running', 'publish assessed results', ?)
    `).run(Date.now());
    const plans = new PlanRepository(database);
    let plan = await plans.create(admitPlan({
      runId: "step-result-publication-run",
      proposal: {
        goal: "publish assessed results",
        selectedSkillIds: [],
        steps: [{
          id: "caveated",
          objective: "Publish with a non-blocking caveat.",
          dependencies: [],
          skillIds: [],
          requiredCapabilities: [],
          successCriteria: [{
            id: "quality",
            description: "Quality can be reported as unverified.",
            source: "planner",
            blocking: false,
          }],
        }, {
          id: "blocked",
          objective: "Do not publish a blocking rejection.",
          dependencies: [],
          skillIds: [],
          requiredCapabilities: [],
          successCriteria: [{
            id: "required",
            description: "Required result must be present.",
            source: "planner",
          }, {
            id: "optional-quality",
            description: "Optional quality signal may be unavailable.",
            source: "planner",
            blocking: false,
          }],
        }],
      },
      availableSkills: [],
      availableToolNames: new Set(),
    }));
    const committer = new StepResultCommitter(plans);

    plan = await plans.startStep(plan.id, "caveated");
    await plans.saveAssessment({
      id: "assessment-caveated",
      planId: plan.id,
      stepId: "caveated",
      attempt: 1,
      approved: false,
      criteria: [{
        criterionId: "quality",
        satisfied: false,
        status: "unverified",
        blocking: false,
        rationale: "The optional quality signal is unavailable.",
        evidenceRefs: [],
      }],
      skills: [],
      evidenceDigest: "caveated",
      feedback: "Publish with an explicit caveat.",
      createdAt: Date.now(),
    });
    const published = await committer.commit({
      runId: plan.runId,
      plan,
      step: plan.steps.find((step) => step.id === "caveated")!,
      evidence: { candidateOutput: "usable result", toolCalls: [], modelSteps: 1 },
    });
    assert.equal(published.result.publication.decision, "caveated");
    plan = published.plan;

    plan = await plans.startStep(plan.id, "blocked");
    await plans.saveAssessment({
      id: "assessment-blocked",
      planId: plan.id,
      stepId: "blocked",
      attempt: 1,
      approved: false,
      criteria: [{
        criterionId: "required",
        satisfied: false,
        status: "conflict",
        blocking: true,
        rationale: "The required result conflicts with evidence.",
        evidenceRefs: [],
      }, {
        criterionId: "optional-quality",
        satisfied: false,
        status: "unverified",
        blocking: false,
        rationale: "An optional signal is unavailable but cannot mask the blocking conflict.",
        evidenceRefs: [],
      }],
      skills: [],
      evidenceDigest: "blocked",
      feedback: "Blocking evidence conflict.",
      createdAt: Date.now(),
    });
    await assert.rejects(
      () => committer.commit({
        runId: plan.runId,
        plan,
        step: plan.steps.find((step) => step.id === "blocked")!,
        evidence: {
          candidateOutput: "must not publish",
          toolCalls: [],
          modelSteps: 1,
          completionCaveat: { reason: "unverified_quality", feedback: "Do not override Assessment." },
        },
      }),
      (error: unknown) => error instanceof AppError && error.code === "ASSESSMENT_ERROR",
    );
  } finally {
    await database.close();
  }
});
