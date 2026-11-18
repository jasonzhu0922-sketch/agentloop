import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
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

test("later corrections are owner-scoped and compression reports omitted decisions", async t => {
  const { event, read } = await setup(t);
  await event("conversation.outcome.disputed", { targetRunId: "r" }, "foreign");
  assert.equal((await read())!.quality.laterDisputed, false);
  await event("conversation.outcome.superseded", { targetRunId: "r" }, "later");
  for (let i = 0; i < 30; i++) await event("conversation.turn.resolved", { mode: "execute", effectiveGoal: `Goal ${i}` });
  const value = await read();
  assert.equal(value!.quality.laterCorrected, true);
  assert.equal(value!.quality.laterDisputed, false);
  assert.ok(value!.coverage!.omittedObservations > 0);
  assert.equal(value!.coverage!.totalObservations, value!.coverage!.omittedObservations + value!.coverage!.retainedObservations);
  assert.ok(value!.observations!.some(item => item.kind === "feedback"));
});
