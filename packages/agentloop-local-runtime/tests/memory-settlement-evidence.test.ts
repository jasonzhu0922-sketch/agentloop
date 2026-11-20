import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase, RuntimeActionRepository, RuntimeResultRepository, createRuntimeResult, createCapabilityGrant, createExecutionInsightTool, createMemoryRecallTool, type AgentLoopMemoryPlugin } from "@zhujun/agentloop";
import { settlementMethodView } from "../../agentloop-memory/src/method-evidence.ts";
import { LocalMemorySettlementReader } from "../src/memory/local-memory-settlement-reader.ts";

async function setup(t: { after(fn: () => unknown): void }) {
  const db = new AppDatabase(":memory:");
  t.after(() => db.close());
  await db.ready();
  await db.prepare("INSERT INTO conversations(id,owner_user_id,title,visible_directories_json,created_at,updated_at) VALUES ('c','alice','task','[]',1,1)").run();
  for (const [id, owner] of [["r", "alice"], ["later", "alice"], ["foreign", "bob"]]) {
    await db.prepare("INSERT INTO runs(id,owner_user_id,conversation_id,depth,status,input,created_at) VALUES (?,?,'c',0,'completed','task',1)").run(id, owner);
  }
  await db.prepare("INSERT INTO run_outcomes(run_id,status,result_ref,reason_code,committed_at) VALUES ('r','completed','outcome','response_only_completed',1)").run();
  let seq = 0;
  const event = (type: string, payload: unknown, runId = "r") => db.prepare("INSERT INTO run_events(run_id,seq,type,payload_json,created_at) VALUES (?,?,?,?,1)").run(runId, ++seq, type, JSON.stringify(payload));
  const reader = new LocalMemorySettlementReader(db, "device");
  const read = () => reader.read({ tenantId: "device", ownerUserId: "alice", runId: "r", terminalCommitRef: "outcome" });
  return { db, event, reader, read };
}

test("settlement preserves rejected requests, valid empty results and nonempty results as distinct compact observations", async t => {
  const { db, read } = await setup(t);
  const results = [
    { exitCode: 1, stdout: JSON.stringify({ status: "rejected", error: { code: "request_invalid", message: "Request must provide nonempty bindings; token=private-value", diagnostic: { phase: "request.plan", code: "bindings_missing", body: "RAW_DIAGNOSTIC_BODY" } } }) },
    { exitCode: 0, stdout: JSON.stringify({ status: "completed", row_count: 0, dataset: { rows: [] } }) },
    { exitCode: 0, stdout: JSON.stringify({ status: "completed", row_count: 180, dataset: { rows: [{ value: "RAW_ROW_VALUE" }] } }) },
  ];
  for (const [index, result] of results.entries()) await db.prepare(`INSERT INTO runtime_actions(id,run_id,kind,state,attempt,max_attempts,replay_policy,fence,revision,metadata_json,created_at,updated_at)
    VALUES (?,'r','tool_call','succeeded',1,1,'safe',1,1,?,?,?)`).run(`result-${index}`, JSON.stringify({ toolName: "resource.query", runtimeResult: { payload: { content: JSON.stringify(result) } } }), index + 1, index + 1);
  const value = (await read())!, observations = settlementMethodView(value).observations;
  assert.equal(observations[0]!.status, "failed");
  const diagnostics = observations[0]!.details!.resultDiagnostics as any[];
  assert.ok(diagnostics.some(row => row.status === "rejected"));
  assert.ok(diagnostics.some(row => row.code === "bindings_missing" && row.phase === "request.plan"));
  assert.match(JSON.stringify(diagnostics), /nonempty bindings/);
  assert.ok((observations[1]!.details!.resultProfile as any[]).some(row => row.count === 0 && row.pointer === "/stdout/row_count"));
  assert.ok((observations[2]!.details!.resultProfile as any[]).some(row => row.count === 180));
  assert.doesNotMatch(JSON.stringify(value), /private-value|RAW_DIAGNOSTIC_BODY|RAW_ROW_VALUE/);
  assert.ok(JSON.stringify(diagnostics).length < 1000);
});

test("accepted HIL preserves original choices, selected identity, scope and task-only intent", async t => {
  const { db, event, reader, read } = await setup(t);
  const options = Array.from({ length: 30 }, (_, i) => ({ id: `option-${i}`, label: `Metric ${i}`, identityRefs: [`catalog:metric:${i}`],
    ...(i === 29 ? { password: "private-value" } : {}) }));
  await db.prepare(`INSERT INTO human_loop_requests(id,run_id,origin,kind,title,prompt,rationale,evidence_refs_json,response_schema_json,resume_json,status,revision,created_at)
    VALUES ('choice','r','planner','selection','Choose a metric','Select the definition for this task','Multiple definitions exist','["catalog:evidence"]',?,'{}','answered',2,1)`)
    .run(JSON.stringify({ type: "select", minSelections: 1, maxSelections: 1, options }));
  await event("human_loop.answered", { requestId: "choice", requestRevision: 1, value: ["option-29"] });
  await event("human_loop.answered", { value: ["malformed"] });
  const value = await read();
  assert.ok(value);
  const decision = value.observations!.find(item => item.status === "user_confirmed")!;
  assert.equal(decision.details!.question, "Select the definition for this task");
  assert.equal(decision.details!.persistenceIntent, "task_only");
  assert.deepEqual(decision.details!.evidenceRefs, ["catalog:evidence"]);
  assert.deepEqual((decision.details!.selectedOptions as any[])[0].identityRefs, ["catalog:metric:29"]);
  assert.deepEqual(decision.details!.candidateCoverage, { total: 30, retained: 24, omitted: 6 });
  assert.equal(JSON.stringify(value).includes("private-value"), false);
  assert.equal((decision.details!.selectedOptions as any[])[0].password, "[REDACTED]");
  assert.equal(decision.sourceRefs[0]!.sourceId, "r:1");
  assert.equal(await reader.read({ tenantId: "device", ownerUserId: "bob", runId: "r", terminalCommitRef: "outcome" }), undefined);
});

test("Result inheritance and Memory recall stay distinct from independent execution and adoption", async t => {
  const { event, read } = await setup(t);
  await event("conversation.turn.resolved", { mode: "execute", relation: "continue_prior", inputMode: "prior_result", effectiveGoal: "Use the earlier report",
    targetRunId: "original", targetResult: { resultId: "result-1" }, userConstraints: ["Only the approved scope"] });
  await event("memory.recalled", { projectionId: "projection", memoryRevisionIds: ["revision-1"] });
  const value = await read();
  assert.deepEqual(value!.dependencies!.map(item => ({ kind: item.kind, id: item.id })), [{ kind: "prior_result", id: "result-1" }, { kind: "memory", id: "revision-1" }]);
  assert.equal(value!.dependencies![0]!.sourceRunId, "original");
  const interpreted = value!.observations!.find(item => item.status === "interpreted")!;
  assert.equal(interpreted.details!.authority, "model_interpretation");
  assert.deepEqual(interpreted.details!.userConstraints, ["Only the approved scope"]);
});

test("later corrections are owner-scoped and all decisions survive settlement intake", async t => {
  const { event, read } = await setup(t);
  await event("conversation.outcome.disputed", { targetRunId: "r" }, "foreign");
  assert.equal((await read())!.quality.laterDisputed, false);
  await event("conversation.outcome.superseded", { targetRunId: "r", relation: "correct_prior" }, "later");
  for (let i = 0; i < 30; i++) await event("conversation.turn.resolved", { mode: "execute", effectiveGoal: `Goal ${i}` });
  const value = await read();
  assert.equal(value!.quality.laterCorrected, true);
  assert.equal(value!.quality.laterDisputed, false);
  assert.equal(value!.coverage!.omittedObservations, 0);
  assert.equal(value!.observations!.filter(item => item.kind === "decision").length, 30);
  assert.equal(value!.coverage!.totalObservations, value!.coverage!.omittedObservations + value!.coverage!.retainedObservations);
  assert.ok(value!.observations!.some(item => item.kind === "feedback"));
});

test("refinement and unknown replacements preserve context without inventing correction", async t => {
  const { event, read } = await setup(t);
  await event("conversation.outcome.superseded", { targetRunId: "r", relation: "refine_prior" }, "later");
  await event("conversation.outcome.superseded", { targetRunId: "r" }, "later");
  const value = (await read())!;
  assert.equal(value.quality.laterCorrected, false);
  assert.equal(value.quality.laterDisputed, false);
  const feedback = settlementMethodView(value).observations.filter(item => item.kind === "feedback");
  assert.deepEqual(feedback.map(item => item.details!.feedbackEffect), ["refined", "unknown"]);
  assert.ok(feedback.every(item => item.status === "context"));
});

test("delivery statement and request survive a later empty probe without becoming source truth", async t => {
  const { db, read } = await setup(t);
  await db.prepare("UPDATE runs SET input='Produce the requested six-section document' WHERE id='r'").run();
  const final = { schema: "agentloop.runtimeResult/v1", kind: "run", publication: { status: "published" }, producer: { runId: "r" }, ref: { resultId: "outcome" }, inputs: [],
    payload: { content: "Delivered all six sections.\n| Internal value |\n| PRIVATE_ROW |\n```text\nPRIVATE_FILE_BODY\n```\nThe optional reference search returned no matches. token=private-value" } };
  await db.prepare("UPDATE run_outcomes SET result_json=? WHERE run_id='r'").run(JSON.stringify(final));
  await db.prepare(`INSERT INTO runtime_actions(id,run_id,kind,state,attempt,max_attempts,replay_policy,fence,revision,metadata_json,created_at,updated_at)
    VALUES ('probe','r','tool_call','succeeded',1,1,'safe',1,1,?,1,1)`).run(JSON.stringify({ toolName: "reference.search", runtimeResult: { payload: { content: JSON.stringify({ row_count: 0 }) } } }));
  const value = (await read())!, view = settlementMethodView(value);
  assert.equal(value.taskRequest!.authority, "user_request");
  assert.match(value.taskRequest!.text, /six-section/);
  const delivery = view.observations.find(item => item.kind === "delivery")!;
  assert.match(String(delivery.details!.statementExcerpt), /Delivered all six/);
  assert.match(String(delivery.details!.statementExcerpt), /optional reference search/);
  assert.equal(delivery.sourceRefs[0]!.authority, "model_interpretation");
  assert.equal(delivery.details!.inputLinkage, "unknown");
  assert.equal(view.observations.find(item => item.kind === "action")!.details!.deliveryRelation, "unknown");
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_ROW|PRIVATE_FILE_BODY|private-value/);
});

test("method handoff binds only to later dispatched actions in the exact admitted step", async t => {
  const { db, event, read } = await setup(t);
  await db.prepare("INSERT INTO plans(id,run_id,version,goal,selected_skill_ids_json,status,created_at,updated_at) VALUES ('p','r',1,'Render and verify a document','[]','completed',1,1)").run();
  for (const [id, position] of [["s1", 0], ["s2", 1]] as const) {
    await db.prepare(`INSERT INTO plan_steps(plan_id,step_id,position,objective,dependencies_json,skill_ids_json,recommended_tool_names_json,success_criteria_json,status)
      VALUES ('p',?,?,'Execute current workflow','[]','[]','[]','[]','completed')`).run(id, position);
  }
  await db.prepare("UPDATE run_outcomes SET plan_id='p' WHERE run_id='r'").run();
  const bindings = [{ memoryRevisionId: "revision", knowledgeId: "path" }];
  const augmentation = { id: "memory:methods:projection", source: "local_memory", provenance: { schema: "agentloop.memoryMethodHandoff/v1", projectionId: "projection", bindings } };
  await event("tool.planned", { toolCallId: "before", arguments: {} });
  await event("prompt_augmentation.activated", { stepId: "s1", augmentationIds: [augmentation.id], augmentations: [augmentation] });
  await event("tool.planned", { toolCallId: "after", arguments: {} });
  await event("tool.planned", { toolCallId: "other-step", arguments: {} });
  // A producer that names an augmentation without actually activating it
  // cannot manufacture another method identity in the evidence reader.
  await event("prompt_augmentation.activated", { stepId: "s1", augmentationIds: [], augmentations: [{ ...augmentation, provenance: { ...augmentation.provenance, bindings: [{ memoryRevisionId: "revision", knowledgeId: "inactive" }] } }] });
  for (const [id, step] of [["before", "s1"], ["after", "s1"], ["other-step", "s2"], ["unplanned", "s1"]]) {
    await db.prepare(`INSERT INTO runtime_actions(id,run_id,plan_id,step_id,kind,state,attempt,max_attempts,replay_policy,fence,revision,metadata_json,created_at,updated_at)
      VALUES (?,'r','p',?,'tool_call','succeeded',1,1,'safe',1,1,?,1,1)`).run(id, step, JSON.stringify({ toolName: "workflow.execute", toolCallId: id }));
  }
  const value = await read();
  const action = (id: string) => value!.observations!.find(item => item.sourceRefs.some(ref => ref.type === "action" && ref.sourceId === id))!;
  assert.equal(action("before").details!.memoryGuidance, undefined);
  assert.equal(action("other-step").details!.memoryGuidance, undefined);
  assert.equal(action("unplanned").details!.memoryGuidance, undefined);
  assert.deepEqual(action("after").details!.memoryGuidance, [{ projectionId: "projection", memoryRevisionId: "revision", knowledgeId: "path",
    sourceRef: { type: "event", runId: "r", sourceId: "r:2" } }]);
});

test("large executions retain middle actions and method handoffs after the former 200-event limit", async t => {
  const { db, event, read } = await setup(t);
  await db.prepare("INSERT INTO plans(id,run_id,version,goal,selected_skill_ids_json,status,created_at,updated_at) VALUES ('p','r',1,'Process and verify every item','[]','completed',1,1)").run();
  await db.prepare("INSERT INTO plan_steps(plan_id,step_id,position,objective,dependencies_json,skill_ids_json,recommended_tool_names_json,success_criteria_json,status) VALUES ('p','s',0,'Process every item','[]','[]','[]','[]','completed')").run();
  await db.prepare("UPDATE run_outcomes SET plan_id='p' WHERE run_id='r'").run();
  for (let i = 0; i < 210; i++) {
    if (i === 205) await event("prompt_augmentation.activated", {stepId: "s", augmentationIds: ["late-method"], augmentations: [{id: "late-method", source: "local_memory",
      provenance: {schema: "agentloop.memoryMethodHandoff/v1", projectionId: "projection", bindings: [{memoryRevisionId: "revision", knowledgeId: "path"}]}}]});
    await event("tool.planned", {toolCallId: `call-${i}`, arguments: {command: "python3", args: ["scripts/workflow.py", "verify", "--item"]}});
    await db.prepare(`INSERT INTO runtime_actions(id,run_id,plan_id,step_id,kind,state,attempt,max_attempts,replay_policy,fence,revision,metadata_json,created_at,updated_at)
      VALUES (?,'r','p','s','tool_call','succeeded',1,1,'safe',1,1,?,?,?)`).run(`action-${i}`, JSON.stringify({toolName: "workflow.execute", toolCallId: `call-${i}`}), i + 1, i + 1);
  }
  for (let i = 0; i < 12; i++) {
    await db.prepare(`INSERT INTO skill_compliance_assessments(id,plan_id,step_id,attempt,approved,criteria_json,skills_json,evidence_digest,feedback,created_at)
      VALUES (?,'p','s',?,1,?,'[]','digest','Current evidence verified',?)`).run(`assessment-${i}`, i + 1, JSON.stringify([{ evidenceRefs: [`call-${i}`] }]), i + 1);
  }
  const value = (await read())!;
  assert.deepEqual(value.coverage, {totalObservations: 222, retainedObservations: 222, omittedObservations: 0});
  const action = (index: number) => value.observations!.find(row => row.sourceRefs.some(ref => ref.sourceId === `action-${index}`))!;
  assert.match(action(105).summary, /workflow.py verify --item/);
  assert.match(action(209).summary, /workflow.py verify --item/);
  assert.equal(action(204).details?.memoryGuidance, undefined);
  assert.equal((action(205).details?.memoryGuidance as any[])[0].knowledgeId, "path");
  const assessments = value.observations!.filter(row => row.kind === "assessment");
  assert.equal(assessments.length, 12);
  assert.deepEqual(assessments.find(row => row.sourceRefs[0]!.sourceId === "assessment-0")!.relatedObservationIds, [action(0).id]);
});

test("method paths place the user decision between the actions it actually separated", async t => {
  const { db, event, read } = await setup(t);
  await event("tool.planned", { toolCallId: "before", arguments: { command: "inspect" } });
  await db.prepare(`INSERT INTO human_loop_requests(id,run_id,origin,kind,title,prompt,rationale,evidence_refs_json,response_schema_json,resume_json,status,revision,created_at)
    VALUES ('choice','r','planner','selection','Choose scope','Select the current scope','Multiple scopes exist','[]','{"type":"select","options":[{"id":"current","label":"Current"}]}','{}','answered',2,20)`).run();
  await event("human_loop.answered", { requestId: "choice", value: ["current"] });
  await event("tool.planned", { toolCallId: "after", arguments: { command: "inspect" } });
  await db.prepare("UPDATE run_events SET created_at=seq*10 WHERE run_id='r'").run();
  for (const [id, at] of [["before", 10], ["after", 30]] as const) {
    await db.prepare(`INSERT INTO runtime_actions(id,run_id,kind,state,attempt,max_attempts,replay_policy,fence,revision,metadata_json,created_at,updated_at)
      VALUES (?,'r','tool_call','succeeded',1,1,'safe',1,1,?,?,?)`).run(id, JSON.stringify({ toolName: "workflow.execute", toolCallId: id }), at, at);
  }
  const value = (await read())!;
  assert.deepEqual(value.observations!.map(row => row.sourceRefs[0]!.sourceId), ["before", "r:2", "after"]);
});

for (const [domain, purpose, finding, nextAction] of [
  ["data", "Locate records under current filters", "No rows under the current filters", "Inspect source coverage before broadening filters"],
  ["code", "Reproduce the reported defect", "The focused reproduction did not trigger the failure", "Inspect the affected caller before changing implementation"],
  ["documents", "Verify rendered content fits", "The requested page overflows", "Adjust layout and render the same page again"],
  ["research", "Locate an authoritative source", "The current search returned no primary source", "Search the issuing organization's catalog"],
]) test(`${domain}: receipt-linked public findings survive Reader and method compaction without raw logs`, async t => {
  const { db, event, read } = await setup(t);
  await db.prepare("UPDATE runs SET status='running' WHERE id='r'").run();
  await db.prepare("INSERT INTO plans(id,run_id,version,goal,selected_skill_ids_json,status,created_at,updated_at) VALUES ('p','r',1,'Execute and verify the task','[]','completed',1,1)").run();
  await db.prepare("INSERT INTO plan_steps(plan_id,step_id,position,objective,dependencies_json,skill_ids_json,recommended_tool_names_json,success_criteria_json,status) VALUES ('p','s',0,'Acquire and verify evidence','[]','[]','[]','[]','completed')").run();
  await db.prepare("UPDATE run_outcomes SET plan_id='p' WHERE run_id='r'").run();
  const actions = new RuntimeActionRepository(db);
  let resultId = "";
  const dispatch = async (toolName: string, toolCallId: string, args: unknown, execute: () => Promise<unknown>) => {
    await db.prepare("INSERT INTO run_events(run_id,seq,type,payload_json,created_at) SELECT 'r',COALESCE(MAX(seq),0)+1,'tool.planned',?,? FROM run_events WHERE run_id='r'")
      .run(JSON.stringify({ toolName, toolCallId, arguments: args }), Date.now());
    return actions.execute({ runId: "r", planId: "p", stepId: "s", kind: "tool_call", replayPolicy: "safe", deadlineMs: 2000,
      metadata: { toolName, toolCallId }, prepareResult: async (value, action) => {
        const result = createRuntimeResult({ kind: "tool", producer: { runId: "r", planId: "p", stepId: "s", actionId: action.id, toolCallId, toolName },
          value, publication: { status: "committed" } }); resultId = result.ref.resultId; return result;
      } }, execute);
  };
  await dispatch("workflow.execute", "initial", { command: "python3", args: ["scripts/workflow.py", "inspect", "--request-json", "PRIVATE_REQUEST"] },
    async () => ({ exitCode: 0, stdout: JSON.stringify({ rows: [], summary: "RAW_TOOL_SUMMARY", body: "RAW_BODY" }), stderr: "RAW_STDERR" }));
  const tool = createExecutionInsightTool(new RuntimeResultRepository(db));
  const grant = createCapabilityGrant({ actorUserId: "alice", runId: "r", planId: "p", stepId: "s", depth: 0, allowedToolNames: [tool.name], allowedSkillIds: [] });
  const args = { resultIds: [resultId], purpose, finding, informationStatus: "unfulfilled", nextAction };
  await dispatch(tool.name, "insight", args, () => tool.execute({ grant }, tool.parse(args)));
  await dispatch("workflow.execute", "changed", { command: "python3", args: ["scripts/workflow.py", "inspect", "--request-json", "DIFFERENT_PRIVATE_REQUEST"] },
    async () => ({ exitCode: 0, stdout: JSON.stringify({ rows: [{ value: "RAW_ROW" }] }), stderr: "" }));
  const evidence = (await read())!;
  const view = settlementMethodView(evidence);
  const insight = view.observations.find(row => row.toolName === tool.name)!;
  assert.equal(insight.kind, "decision");
  assert.equal(insight.details!.finding, finding);
  assert.equal(insight.details!.purpose, purpose);
  assert.equal(insight.details!.nextAction, nextAction);
  assert.equal(insight.details!.authority, "model_interpretation");
  assert.deepEqual(insight.relatedObservationIds, ["method_1"]);
  assert.deepEqual(view.observations[0]!.details!.resultProfile, [{ pointer: "/stdout/rows", items: 0 }]);
  assert.deepEqual(view.observations[2]!.details!.resultProfile, [{ pointer: "/stdout/rows", items: 1 }]);
  assert.equal(view.observations.length, 3);
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_REQUEST|RAW_BODY|RAW_ROW|RAW_STDERR|RAW_TOOL_SUMMARY/);
});

test("unresolvable interpretation references stay an explicit gap and cannot supply execution support", async t => {
  const { db, event, read } = await setup(t);
  await event("tool.planned", { toolCallId: "insight", arguments: {} });
  await db.prepare(`INSERT INTO runtime_actions(id,run_id,kind,state,attempt,max_attempts,replay_policy,fence,revision,metadata_json,created_at,updated_at)
    VALUES ('insight','r','tool_call','succeeded',1,1,'safe',1,1,?,1,1)`).run(JSON.stringify({ toolName: "record_execution_insight", toolCallId: "insight",
      runtimeResult: { payload: { content: JSON.stringify({ schema: "agentloop.executionInsight/v1", authority: "model_interpretation",
        purpose: "Find a source", finding: "UNSUPPORTED_FINDING", resultIds: ["missing-result"], informationStatus: "fulfilled" }) } } }));
  const observation = (await read())!.observations![0]!;
  assert.deepEqual(observation.details, { grounding: "unresolved" });
  assert.equal(observation.sourceRefs[0]!.authority, "model_interpretation");
  assert.doesNotMatch(JSON.stringify(observation), /UNSUPPORTED_FINDING/);
});

async function plannedWorkflow(t: { after(fn: () => unknown): void }) {
  const fixture = await setup(t), { db } = fixture;
  await db.prepare("UPDATE runs SET status='running' WHERE id='r'").run();
  await db.prepare("INSERT INTO plans(id,run_id,version,goal,selected_skill_ids_json,status,created_at,updated_at) VALUES ('p','r',1,'Verify current inputs','[]','completed',1,1)").run();
  for (const [id, position] of [["s", 0], ["other", 1]] as const) await db.prepare("INSERT INTO plan_steps(plan_id,step_id,position,objective,dependencies_json,skill_ids_json,recommended_tool_names_json,success_criteria_json,status) VALUES ('p',?,?,'Acquire and verify evidence','[]','[]','[]','[]','completed')").run(id, position);
  await db.prepare("UPDATE run_outcomes SET plan_id='p' WHERE run_id='r'").run();
  const actions = new RuntimeActionRepository(db);
  const dispatch = async (toolName: string, toolCallId: string, args: unknown, execute: () => Promise<unknown>, stepId = "s") => {
    await db.prepare("INSERT INTO run_events(run_id,seq,type,payload_json,created_at) SELECT 'r',COALESCE(MAX(seq),0)+1,'tool.planned',?,? FROM run_events WHERE run_id='r'")
      .run(JSON.stringify({ toolName, toolCallId, arguments: args }), Date.now());
    let resultId = "";
    await actions.execute({ runId: "r", planId: "p", stepId, kind: "tool_call", replayPolicy: "safe", deadlineMs: 2000,
      metadata: { toolName, toolCallId }, prepareResult: async (value, action) => {
        const result = createRuntimeResult({ kind: "tool", producer: { runId: "r", planId: "p", stepId, actionId: action.id, toolCallId, toolName }, value, publication: { status: "committed" } });
        resultId = result.ref.resultId; return result;
      } }, execute);
    return resultId;
  };
  const grant = createCapabilityGrant({ actorUserId: "alice", runId: "r", planId: "p", stepId: "s", depth: 0, allowedToolNames: ["record_execution_insight", "recall_task_knowledge"], allowedSkillIds: [] });
  return { ...fixture, dispatch, grant };
}

test("delivery provenance follows canonical Step inputs rather than the last executed probe", async t => {
  const { db, dispatch, read } = await plannedWorkflow(t);
  const main = await dispatch("document.render", "main", {}, async () => ({ status: "completed", count: 6 }));
  await dispatch("reference.search", "probe", {}, async () => ({ status: "completed", count: 0 }));
  const step = createRuntimeResult({ kind: "step", producer: { runId: "r", planId: "p", stepId: "s" }, value: "Document delivered", publication: { status: "published", assessmentRef: "inspection", decision: "approved" }, inputs: [{ schema: "agentloop.resultRef/v1", resultId: main }] });
  await db.prepare("UPDATE plan_steps SET evidence_json=? WHERE plan_id='p' AND step_id='s'").run(JSON.stringify({ publishedResult: step }));
  const final = createRuntimeResult({ kind: "run", producer: { runId: "r", planId: "p" }, value: "Delivered six sections; the optional reference search was empty", publication: { status: "published" }, inputs: [step.ref] });
  // Keep the fixture's terminal commit reference while using valid producer inputs.
  await db.prepare("UPDATE run_outcomes SET result_json=? WHERE run_id='r'").run(JSON.stringify({ ...final, ref: { schema: "agentloop.resultRef/v1", resultId: "outcome" } }));
  const value = (await read())!;
  const delivery = value.observations!.find(row => row.kind === "delivery")!;
  const mainAction = value.observations!.find(row => row.toolName === "document.render")!;
  const probe = value.observations!.find(row => row.toolName === "reference.search")!;
  assert.deepEqual(delivery.relatedObservationIds, [mainAction.id]);
  assert.equal(mainAction.details!.deliveryRelation, "declared_input");
  assert.equal(probe.details!.deliveryRelation, "unknown");
  assert.equal(delivery.details!.inputLinkage, "declared_provenance");
  assert.equal(delivery.sourceRefs[0]!.authority, "model_interpretation");
});

test("selected source metadata survives as a separately citable observation without raw result bodies or interpretation authority", async t => {
  const { db, dispatch, grant, read } = await plannedWorkflow(t);
  const resultId = await dispatch("resource.inspect", "inspect", {}, async () => ({ metadata: { revision: "v1", inputCheck: "verify --input {{input}}" }, rawBody: "RAW_RESULT_BODY" }));
  const tool = createExecutionInsightTool(new RuntimeResultRepository(db));
  const args = { resultIds: [resultId], purpose: "Find the resource verification entry", finding: "Current metadata defines an input checker",
    informationStatus: "fulfilled", evidence: [{ resultId, pointer: "/metadata" }] };
  await dispatch(tool.name, "insight", args, () => tool.execute({ grant }, tool.parse(args)));
  const evidence = (await read())!, grounded = evidence.observations!.find(row => row.details?.grounding === "exact_result_selection")!;
  assert.ok(grounded);
  assert.deepEqual(grounded.details!.value, { revision: "v1", inputCheck: "verify --input {{input}}" });
  assert.equal(grounded.sourceRefs[0]!.pointer, "/metadata");
  assert.equal(grounded.sourceRefs[0]!.resultId, resultId);
  assert.equal(grounded.sourceRefs[0]!.authority, undefined);
  assert.equal(evidence.observations!.find(row => row.toolName === tool.name)!.sourceRefs[0]!.authority, "model_interpretation");
  const view = settlementMethodView(evidence);
  assert.equal(view.observations.find(row => row.details?.grounding === "exact_result_selection")!.sourceRefs[0]!.sourceId, grounded.sourceRefs[0]!.sourceId);
  assert.doesNotMatch(JSON.stringify(evidence), /RAW_RESULT_BODY/);
});

test("on-demand knowledge handoff begins after committed retrieval and applies only to later actions in the admitted step", async t => {
  const { dispatch, grant, read } = await plannedWorkflow(t);
  const memory = { name: "fixture", recall: async () => ({ target: "execution", id: "projection", knowledgeCards: [{ memoryRevisionId: "revision", knowledgeId: "strategy", layer: "strategy" }] }) } as unknown as AgentLoopMemoryPlugin;
  const tool = createMemoryRecallTool(memory, async () => {});
  const args = { query: "How to verify inputs" };
  await dispatch("workflow.execute", "before", {}, async () => ({}));
  await dispatch(tool.name, "recall", args, async () => {
    await dispatch("workflow.execute", "before-recall-commit", {}, async () => ({}));
    return tool.execute({ grant }, tool.parse(args));
  });
  await dispatch("workflow.execute", "after", {}, async () => ({}));
  await dispatch("workflow.execute", "other-step", {}, async () => ({}), "other");
  const value = (await read())!;
  const actions = value.observations!.filter(row => row.kind === "action");
  assert.equal(actions.filter(row => row.details?.memoryGuidance).length, 1);
  assert.equal((actions.find(row => row.details?.memoryGuidance)!.details!.memoryGuidance as any[])[0].knowledgeId, "strategy");
  assert.ok(value.dependencies!.some(item => item.kind === "memory" && item.id === "revision"));
});

test("structured reads retain root and late selectors within the Runtime's 20-query contract", async t => {
  const { db, event, read } = await setup(t);
  const queries = Array.from({ length: 20 }, (_, i) => ({ sourcePointer: i ? `/section_${i}` : "", value: i === 19 ? [] : ["RAW_VALUE"], totalItems: i === 19 ? 0 : 1, nextOffset: null }));
  await event("tool.planned", { toolCallId: "read", arguments: { path: "source.json", queries: queries.map(row => ({ pointer: row.sourcePointer })) } });
  await db.prepare(`INSERT INTO runtime_actions(id,run_id,kind,state,attempt,max_attempts,replay_policy,fence,revision,metadata_json,created_at,updated_at)
    VALUES ('read','r','tool_call','succeeded',1,1,'safe',1,1,?,1,1)`).run(JSON.stringify({ toolName: "computer_read_json", toolCallId: "read",
      runtimeResult: { payload: { content: JSON.stringify({ schema: "agentloop.jsonRead/v1", queries }) } } }));
  const evidence = (await read())!;
  const profile = evidence.observations![0]!.details!.resultProfile as any[];
  assert.equal((evidence.observations![0]!.details!.method as any).selectors.length, 20);
  assert.equal(profile.length, 20);
  assert.deepEqual(profile[0], { pointer: "", returnedItems: 1, totalItems: 1, hasMore: false });
  assert.deepEqual(profile[19], { pointer: "/section_19", returnedItems: 0, totalItems: 0, hasMore: false });
  assert.doesNotMatch(JSON.stringify(evidence), /RAW_VALUE/);
});

test("Runtime stop decisions bind earlier failed observations and only knowledge available before the stop in the same leaf", async t => {
  const { db, event, read } = await setup(t);
  await db.prepare("INSERT INTO plans(id,run_id,version,goal,selected_skill_ids_json,status,created_at,updated_at) VALUES ('p','r',1,'Acquire current evidence','[]','failed',1,1)").run();
  for (const [step, pos] of [["s1", 0], ["s2", 1]] as const) {
    await db.prepare(`INSERT INTO plan_steps(plan_id,step_id,position,objective,dependencies_json,skill_ids_json,recommended_tool_names_json,success_criteria_json,status)
      VALUES ('p',?,?,'Acquire evidence','[]','[]','[]','[]','failed')`).run(step, pos);
  }
  await db.prepare("UPDATE run_outcomes SET plan_id='p',status='failed' WHERE run_id='r'").run();
  const result = createRuntimeResult({ kind: "tool", producer: { runId: "r", planId: "p", stepId: "s1", actionId: "failed-operation", toolName: "resource.inspect" },
    value: { exitCode: 1 }, publication: { status: "committed" } });
  await event("tool.planned", { toolCallId: "failed-operation", arguments: {} });
  await db.prepare(`INSERT INTO runtime_actions(id,run_id,plan_id,step_id,kind,state,attempt,max_attempts,replay_policy,fence,revision,metadata_json,created_at,updated_at)
    VALUES ('failed-operation','r','p','s1','tool_call','failed',1,1,'safe',1,1,?,1,1)`).run(JSON.stringify({ toolName: "resource.inspect", toolCallId: "failed-operation", runtimeResult: result }));
  const activate = async (stepId: string, name: string) => {
    const augmentation = { id: name, source: "local_memory", provenance: { schema: "agentloop.memoryMethodHandoff/v1", projectionId: name,
      bindings: [{ memoryRevisionId: name, knowledgeId: name }] } };
    await event("prompt_augmentation.activated", { stepId, augmentationIds: [name], augmentations: [augmentation] });
  };
  await activate("s1", "before");
  await activate("s2", "other-leaf");
  await event("candidate.repair_stopped", { failedBoundary: { stepId: "s1", suggestedRepairShape: "fail", reusableEvidenceRefs: ["failed-operation"] } });
  await activate("s1", "after");
  await event("candidate.repair_stopped", { failedBoundary: { stepId: "s2", suggestedRepairShape: "fail", reusableEvidenceRefs: ["failed-operation"] } });
  const value = (await read())!, controls = value.observations!.filter(item => item.details?.executionDecision === "stop");
  assert.equal(controls.length, 1);
  assert.equal(controls[0]!.stepOrder, 1);
  assert.equal(controls[0]!.status, "observed");
  assert.deepEqual((controls[0]!.details!.memoryGuidance as any[]).map(row => row.knowledgeId), ["before"]);
  const action = value.observations!.find(item => item.toolName === "resource.inspect")!;
  assert.deepEqual(controls[0]!.relatedObservationIds, [action.id]);
  assert.equal(settlementMethodView(value).observations.find(item => item.details?.executionDecision === "stop")?.status, "observed");
});
