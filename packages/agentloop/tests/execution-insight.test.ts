import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionInsightTool } from "../src/tools/execution-insight-tool.ts";
import { RuntimeResultRepository } from "../src/runtime/runtime-result-repository.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { createRuntimeResult } from "../src/runtime/runtime-result.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { ComputerExecutor } from "../src/computer/computer-executor.ts";
import { createCoreTools } from "../src/tools/compose.ts";

test("execution insights bind committed current-step Results without copying their contents or asserting verification", async t => {
  const db = new AppDatabase(":memory:"); t.after(() => db.close()); await db.ready();
  await db.prepare("INSERT INTO runs(id,owner_user_id,depth,status,input,created_at) VALUES ('r','alice',0,'running','task',1)").run();
  await db.prepare("INSERT INTO plans(id,run_id,version,goal,selected_skill_ids_json,status,created_at,updated_at) VALUES ('p','r',1,'Inspect sources','[]','running',1,1)").run();
  for (const [stepId, position] of [["s", 0], ["other", 1]] as const) {
    await db.prepare("INSERT INTO plan_steps(plan_id,step_id,position,objective,dependencies_json,skill_ids_json,recommended_tool_names_json,success_criteria_json,status) VALUES ('p',?,?,'Inspect evidence','[]','[]','[]','[]','pending')").run(stepId, position);
  }
  const actions = new RuntimeActionRepository(db), repository = new RuntimeResultRepository(db);
  const refs: string[] = [];
  for (const [stepId, toolName] of [["s", "source.search"], ["other", "source.search"], ["s", "record_execution_insight"], ["s", "recall_task_knowledge"]]) {
    await actions.execute({ runId: "r", planId: "p", stepId, kind: "tool_call", replayPolicy: "safe", deadlineMs: 1000,
      metadata: { toolName }, prepareResult: async (value, action) => {
        const result = createRuntimeResult({ kind: "tool", producer: { runId: "r", planId: "p", stepId, actionId: action.id, toolName },
          value, publication: { status: "committed" } }); refs.push(result.ref.resultId); return result;
      } }, async () => ({ rows: [], metadata: { version: "v1", check: "verify --input {{input}}" }, privateBody: "RAW_ROWS_MUST_STAY_OUT", large: "x".repeat(601) }));
  }
  const tool = createExecutionInsightTool(repository);
  const executor = new ComputerExecutor("/tmp");
  assert.equal(createCoreTools({ executor, results: repository }).some(item => item.name === tool.name), false);
  assert.equal(createCoreTools({ executor, results: repository, executionInsights: true }).some(item => item.name === tool.name), true);
  const grant = createCapabilityGrant({ actorUserId: "alice", runId: "r", planId: "p", stepId: "s", depth: 0,
    allowedToolNames: [tool.name], allowedSkillIds: [] });
  const input = { resultIds: [refs[0]], purpose: "Find a source", finding: "No candidates under this filter",
    informationStatus: "unfulfilled", nextAction: "Check coverage before broadening the search" };
  const value = await tool.execute({ grant }, tool.parse(input)) as any;
  assert.equal(value.authority, "model_interpretation");
  assert.equal(value.informationStatus, "unfulfilled");
  assert.equal(value.sourceRefs[0].toolName, "source.search");
  assert.ok(value.sourceRefs[0].actionId);
  assert.doesNotMatch(JSON.stringify(value), /RAW_ROWS_MUST_STAY_OUT|evidenceKinds|assessmentApproved/);
  const grounded = await tool.execute({ grant }, tool.parse({ ...input, evidence: [{ resultId: refs[0], pointer: "/metadata" }] })) as any;
  assert.deepEqual(grounded.groundedEvidence[0].value, { version: "v1", check: "verify --input {{input}}" });
  assert.equal(grounded.groundedEvidence[0].actionId, value.sourceRefs[0].actionId);
  assert.doesNotMatch(JSON.stringify(grounded), /RAW_ROWS_MUST_STAY_OUT/);
  for (const pointer of ["/missing", "/__proto__", "/large"]) await assert.rejects(tool.execute({ grant }, tool.parse({ ...input, evidence: [{ resultId: refs[0], pointer }] })), /pointer|600/);
  assert.throws(() => tool.parse({ ...input, evidence: [{ resultId: refs[1], pointer: "/metadata" }] }), /cited resultIds/);
  assert.throws(() => tool.parse({ ...input, evidence: [{ resultId: refs[0], pointer: "/metadata/~x" }] }), /pointers/);
  for (const id of [refs[1], refs[2], refs[3], "rr_00000000-0000-4000-8000-000000000099"]) {
    await assert.rejects(tool.execute({ grant }, tool.parse({ ...input, resultIds: [id] })), /not found/i);
  }
  const foreign = createCapabilityGrant({ actorUserId: "bob", runId: "r", planId: "p", stepId: "s", depth: 0,
    allowedToolNames: [tool.name], allowedSkillIds: [] });
  await assert.rejects(tool.execute({ grant: foreign }, tool.parse(input)), /not found/i);
  assert.throws(() => tool.parse({ ...input, resultIds: [refs[0], refs[0]] }), /distinct/);
  assert.throws(() => tool.parse({ ...input, finding: "x".repeat(601) }), /600/);
  assert.throws(() => tool.parse({ ...input, reasoning: "private reasoning" }), /unknown/);
});
