import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { RuntimeResultRepository } from "../src/runtime/runtime-result-repository.ts";
import { createRuntimeResult } from "../src/runtime/runtime-result.ts";
import { AppError } from "../src/shared/errors.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { createResultTool } from "../src/tools/result-tool.ts";

test("read_result reads only an explicitly bound completed Outcome in the same conversation", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = "user-result-reader";
    const conversationId = "conversation-result-reader";
    const otherConversationId = "conversation-result-other";
    const output = "accepted semantic outcome ".repeat(1_000);
    const now = Date.now();
    await database.prepare(`INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(conversationId, owner, "Result reader", now, now);
    await database.prepare(`INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(otherConversationId, owner, "Other result reader", now, now);
    const completed = await insertRunOutcome(database, { runId: "completed-result", owner, conversationId, status: "completed", output, now });
    const unbound = await insertRunOutcome(database, { runId: "unbound-result", owner, conversationId, status: "completed", output, now });
    const failed = await insertRunOutcome(database, { runId: "failed-result", owner, conversationId, status: "failed", output, now });
    const other = await insertRunOutcome(database, { runId: "other-conversation-result", owner, conversationId: otherConversationId, status: "completed", output, now });
    await insertCurrentPlan(database, {
      runId: "current-run",
      planId: "current-plan",
      stepId: "consume-prior",
      owner,
      conversationId,
      resultId: completed.ref.resultId,
      now,
    });

    const tool = createResultTool(new RuntimeResultRepository(database));
    const grant = createCapabilityGrant({
      actorUserId: owner,
      runId: "current-run",
      planId: "current-plan",
      stepId: "consume-prior",
      conversationId,
      depth: 0,
      allowedToolNames: [tool.name],
      allowedSkillIds: [],
    });
    const read = await tool.execute({ grant }, tool.parse({
      resultId: completed.ref.resultId,
      characterOffset: 12,
      characterLimit: 55,
    })) as { content: string; returnedCharacters: number; nextCharacterOffset: number | null };
    assert.equal(read.content, output.slice(12, 67));
    assert.equal(read.returnedCharacters, 55);
    assert.equal(read.nextCharacterOffset, 67);

    await database.prepare("UPDATE plans SET input_bindings_json = ? WHERE id = ?").run(JSON.stringify([{
      schema: "agentloop.conversationInputBinding/v1",
      result: completed.ref,
      relation: "continue_prior",
    }]), "current-plan");
    await assert.rejects(
      () => tool.execute({ grant }, tool.parse({ resultId: completed.ref.resultId })),
      (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
    );

    const publishedStep = createRuntimeResult({
      kind: "step",
      producer: { runId: "failed-with-step-result", planId: "failed-plan", stepId: "accepted-step" },
      value: "accepted step result from a failed run",
      publication: { status: "published", assessmentRef: "assessment-accepted-step", decision: "approved" },
      createdAt: now,
    });
    await insertPublishedStepResult(database, {
      owner,
      conversationId,
      result: publishedStep,
      now,
    });
    await database.prepare("UPDATE plans SET input_bindings_json = ? WHERE id = ?").run(JSON.stringify([{
      schema: "agentloop.resultBinding/v1",
      result: publishedStep.ref,
      relation: "continue_prior",
    }]), "current-plan");
    const resumedStep = await tool.execute({ grant }, tool.parse({ resultId: publishedStep.ref.resultId })) as { content: string };
    assert.equal(resumedStep.content, "accepted step result from a failed run");

    const unboundPublishedStep = createRuntimeResult({
      kind: "step",
      producer: { runId: "failed-with-unbound-step-result", planId: "unbound-step-plan", stepId: "unbound-step" },
      value: "must not be readable without an explicit binding",
      publication: { status: "published", assessmentRef: "assessment-unbound-step", decision: "approved" },
      createdAt: now,
    });
    await insertPublishedStepResult(database, {
      owner,
      conversationId,
      result: unboundPublishedStep,
      now,
    });
    await assert.rejects(
      () => tool.execute({ grant }, tool.parse({ resultId: unboundPublishedStep.ref.resultId })),
      (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
    );

    for (const resultId of [unbound.ref.resultId, failed.ref.resultId, other.ref.resultId]) {
      await assert.rejects(
        () => tool.execute({ grant }, tool.parse({ resultId })),
        (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
      );
    }
  } finally {
    await database.close();
  }
});

async function insertRunOutcome(
  database: AppDatabase,
  input: { runId: string; owner: string; conversationId: string; status: "completed" | "failed"; output: string; now: number },
) {
  const result = createRuntimeResult({
    kind: "run",
    producer: { runId: input.runId },
    value: input.output,
    publication: { status: "published" },
    createdAt: input.now,
  });
  await database.prepare(`
    INSERT INTO runs(id, owner_user_id, conversation_id, parent_run_id, depth, allow_dangerous_tools, model_key, status, input, output, error_code, created_at, finished_at)
    VALUES (?, ?, ?, NULL, 0, 0, NULL, ?, 'prior input', ?, NULL, ?, ?)
  `).run(input.runId, input.owner, input.conversationId, input.status, input.output, input.now, input.now);
  await database.prepare(`
    INSERT INTO run_outcomes(run_id, plan_id, status, output, result_ref, result_json, reason_code, committed_at)
    VALUES (?, NULL, ?, ?, ?, ?, 'test', ?)
  `).run(
    input.runId,
    input.status,
    input.output,
    result.ref.resultId,
    JSON.stringify(result),
    input.now,
  );
  return result;
}

async function insertPublishedStepResult(database: AppDatabase, input: {
  owner: string;
  conversationId: string;
  result: ReturnType<typeof createRuntimeResult>;
  now: number;
}): Promise<void> {
  await database.prepare(`
    INSERT INTO runs(id, owner_user_id, conversation_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at, finished_at)
    VALUES (?, ?, ?, NULL, 0, 0, 'failed', 'failed after accepted step', ?, ?)
  `).run(input.result.producer.runId, input.owner, input.conversationId, input.now, input.now);
  await database.prepare(`
    INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, input_bindings_json, status, created_at, updated_at)
    VALUES (?, ?, 1, 'publish accepted step', '[]', '[]', 'failed', ?, ?)
  `).run(input.result.producer.planId, input.result.producer.runId, input.now, input.now);
  await database.prepare(`
    INSERT INTO plan_steps(
      plan_id, step_id, kind, position, objective, dependencies_json, refinement_state, required_facts_json,
      skill_ids_json, required_capabilities_json, recommended_tool_names_json, execution_binding_json,
      success_criteria_json, status, output, evidence_json, started_at, finished_at
    ) VALUES (?, ?, 'leaf', 0, 'accepted boundary', '[]', 'not_refinable', '[]', '[]', '[]', '[]', ?, '[]', 'completed', ?, ?, ?, ?)
  `).run(
    input.result.producer.planId,
    input.result.producer.stepId,
    JSON.stringify({
      schema: "agentloop.stepExecutionBinding/v1",
      requiredCapabilities: [],
      resolvedToolNames: [],
      sourceKinds: [],
      sideEffect: "none",
      evidenceKinds: [],
    }),
    input.result.payload.content,
    JSON.stringify({ candidateOutput: input.result.payload.content, publishedResult: input.result, toolCalls: [], modelSteps: 1 }),
    input.now,
    input.now,
  );
}

async function insertCurrentPlan(database: AppDatabase, input: {
  runId: string;
  planId: string;
  stepId: string;
  owner: string;
  conversationId: string;
  resultId: string;
  now: number;
}): Promise<void> {
  await database.prepare(`
    INSERT INTO runs(id, owner_user_id, conversation_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
    VALUES (?, ?, ?, NULL, 0, 0, 'running', 'continue prior', ?)
  `).run(input.runId, input.owner, input.conversationId, input.now);
  await database.prepare(`
    INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, input_bindings_json, status, created_at, updated_at)
    VALUES (?, ?, 1, 'continue prior', '[]', ?, 'running', ?, ?)
  `).run(input.planId, input.runId, JSON.stringify([{
    schema: "agentloop.resultBinding/v1",
    result: { schema: "agentloop.resultRef/v1", resultId: input.resultId },
    relation: "continue_prior",
  }]), input.now, input.now);
  await database.prepare(`
    INSERT INTO plan_steps(
      plan_id, step_id, kind, position, objective, dependencies_json, refinement_state, required_facts_json,
      skill_ids_json, required_capabilities_json, recommended_tool_names_json, execution_binding_json,
      success_criteria_json, status
    ) VALUES (?, ?, 'leaf', 0, 'consume prior', '[]', 'not_refinable', '[]', '[]', '[]', '[]', ?, '[]', 'running')
  `).run(input.planId, input.stepId, JSON.stringify({
    schema: "agentloop.stepExecutionBinding/v1",
    requiredCapabilities: [],
    resolvedToolNames: ["read_result"],
    sourceKinds: ["conversation_workset"],
    sideEffect: "none",
    evidenceKinds: [],
  }));
}
