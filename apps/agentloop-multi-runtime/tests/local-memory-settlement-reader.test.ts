import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { LocalMemorySettlementReader } from "../local-agent-runtime/src/persistence/local-memory-settlement-reader.ts";

test("Memory reader preserves observed methods, failures and true artifact checks without leaking tool bodies", async (t) => {
  const db = new AppDatabase(":memory:");
  t.after(() => db.close());
  await db.ready();
  await db.prepare(`INSERT INTO runs(id,owner_user_id,depth,status,input,created_at) VALUES ('r','alice',0,'completed','private input',1)`).run();
  await db.prepare(`INSERT INTO plans(id,run_id,version,goal,selected_skill_ids_json,status,created_at,updated_at) VALUES ('p','r',1,?,?,'completed',1,1)`)
    .run("查询分析测试企业的员工画像，匹配组织代码和最新月份", JSON.stringify(["discovered:hr-data"]));
  await db.prepare(`INSERT INTO plan_steps(plan_id,step_id,position,objective,dependencies_json,skill_ids_json,recommended_tool_names_json,success_criteria_json,status)
    VALUES ('p','s',0,?,'[]',?,'["never.called"]','["来源组织代码与月份一致"]','completed')`)
    .run("读取测试企业的员工数据，先匹配组织代码和最新月份，不混用汇总口径", JSON.stringify(["discovered:hr-data"]));
  await db.prepare(`INSERT INTO canonical_run_states(run_id,state_id,intent_id,revision,state_json,created_at,updated_at) VALUES ('r','state','intent',1,?,1,1)`)
    .run(JSON.stringify({ intent: { understanding: { operation: "composite", operationProfiles: ["data_analysis"], deliverable: { kind: "html" } } } }));
  await db.prepare(`INSERT INTO skill_compliance_assessments(id,plan_id,step_id,attempt,approved,criteria_json,skills_json,evidence_digest,feedback,created_at)
    VALUES ('assessment','p','s',1,1,'[]','[]','hash','范围和月份一致',1)`).run();
  await db.prepare(`INSERT INTO run_outcomes(run_id,plan_id,status,result_ref,reason_code,committed_at) VALUES ('r','p','completed','outcome','plan_assessed_and_completed',1)`).run();
  for (const [id, state, tool, content, error] of [
    ["failed", "failed", "computer_run_command", { exitCode: 1, error: "invalid_month" }, "invalid_month"],
    ["loaded", "succeeded", "load_skill", { content: "RAW_SKILL_BODY token=abc123" }, null],
    ["read", "succeeded", "computer_run_command", { exitCode: 0, stdout: "PRIVATE_EMPLOYEE_ROWS" }, null],
    ["verify", "succeeded", "verify_artifact_acceptance", { checks: [{ id: "artifact_non_empty", status: "passed" }, { id: "format_matches_request", status: "passed" }, { id: "artifact_openable", status: "failed" }] }, null],
  ] as const) {
    await db.prepare(`INSERT INTO runtime_actions(id,run_id,plan_id,step_id,kind,state,attempt,max_attempts,replay_policy,fence,revision,metadata_json,error_code,created_at,updated_at)
      VALUES (?,'r','p','s','tool_call',?,1,1,'safe',1,1,?,?,1,1)`).run(id, state, JSON.stringify({ toolName: tool, toolCallId: id, runtimeResult: { payload: { content: JSON.stringify(content) } } }), error);
  }
  await db.prepare(`INSERT INTO run_events(run_id,seq,type,payload_json,created_at) VALUES ('r',1,'tool.planned',?,1)`)
    .run(JSON.stringify({ toolCallId: "read", arguments: { command: "python3", args: ["scripts/hr_data.py", "fetch", "--org", "private-org", "--api-key", "private-key"] } }));
  const reader = new LocalMemorySettlementReader(db, "device");
  const value = await reader.read({ tenantId: "device", ownerUserId: "alice", runId: "r", terminalCommitRef: "outcome" });
  assert.ok(value);
  assert.equal(value.quality.assessmentApproved, true);
  assert.equal(value.quality.artifactVerified, false, "an approved Assessment does not prove artifact openability");
  assert.match(value.strategy!, /组织代码和最新月份/);
  assert.equal(JSON.stringify(value).includes("测试企业"), false);
  assert.equal(JSON.stringify(value).includes("PRIVATE_EMPLOYEE_ROWS"), false);
  assert.equal(JSON.stringify(value).includes("RAW_SKILL_BODY"), false);
  assert.equal(JSON.stringify(value).includes("private-key"), false);
  assert.match(value.observations!.find((item) => item.id === "observation_3")!.summary, /scripts\/hr_data.py fetch --org/);
  assert.ok(value.observations!.some((item) => item.status === "failed" && item.summary.includes("invalid_month")));
  assert.equal((value.planSkeleton![0]!.toolNames as string[]).includes("never.called"), false);
  await assert.rejects(reader.read({ tenantId: "device", ownerUserId: "alice", runId: "r", terminalCommitRef: "different" }), /terminal_commit_mismatch/);
  assert.equal(await reader.read({ tenantId: "device", ownerUserId: "bob", runId: "r", terminalCommitRef: "outcome" }), undefined);
});
