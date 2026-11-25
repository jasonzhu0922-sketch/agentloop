import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeResultRepository } from "../src/runtime/runtime-result-repository.ts";

const identity = { runId: "run", planId: "plan", stepId: "leaf" };
// Exercise the production event reader, with an already-authorized anchor.
// The Result contract suite separately verifies anchor ownership and grants.
function fixture() {
  const events: { seq: number; type: string; payload_json: string; created_at: number }[] = [];
  const reader = Object.create(RuntimeResultRepository.prototype) as RuntimeResultRepository;
  Object.assign(reader, { database: { records: { find: async () => events } },
    readAuthorized: async () => ({ kind: "tool", producer: identity }) });
  const add = (type: string, data: object) => events.push({ seq: events.length + 1, type, payload_json: JSON.stringify(data), created_at: events.length });
  const begin = (stepId = "leaf") => add("plan.step.started", { planId: "plan", stepId });
  const early = (step: number, id = "call", args: object = { revision: step }) => add("assistant.tool_call.committed", { step, toolCallId: id, name: "inspect", arguments: args });
  const checkpoint = (step: number, id = "call", stepId = "leaf", effect = "read", args: object = { revision: step }) => {
    add("assistant.committed", { step, content: "Compare original evidence", privateReasoningContent: "PRIVATE",
      toolCalls: [{ id, name: "inspect", arguments: args }], executionHistoryBasis: { identity: { ...identity, stepId }, toolEffects: { inspect: effect } } });
    return events.length;
  };
  const receipt = (step: number, result: string, id = "call", status = "succeeded") => add("tool.completed", {
    step, toolCallId: id, toolName: "inspect", result, invocationStatus: "completed", operationStatus: status,
  });
  const read = (assistantEventSeq?: number) => reader.readHistoryAuthorized({ ...identity, resultId: "authorized", toolCallId: "call", assistantEventSeq }) as Promise<any>;
  return { events, begin, early, checkpoint, receipt, read, add };
}

test("streamed completed receipts survive both checkpoint orders and reconstruction", async () => {
  for (const streamed of [true, false]) {
    const f = fixture(); f.begin(); f.early(2);
    if (streamed) f.receipt(2, "Exact original result; coverage B unknown");
    f.checkpoint(2);
    if (!streamed) f.receipt(2, "Exact original result; coverage B unknown");
    const result = await f.read();
    assert.equal(result.outcome.result, "Exact original result; coverage B unknown");
    assert.deepEqual(result.gaps, []);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    assert.deepEqual(await f.read(), result);
  }
});

test("streamed reused call IDs require exact incarnation and preserve failed write warnings", async () => {
  const f = fixture(); f.begin(); f.early(1); f.receipt(1, "version 1"); const first = f.checkpoint(1);
  f.early(2); f.receipt(2, "partial write", "call", "failed"); const second = f.checkpoint(2, "call", "leaf", "write");
  assert.match((await f.read()).gaps[0], /Ambiguous/);
  assert.equal((await f.read(first)).outcome.result, "version 1");
  const last = await f.read(second); assert.equal(last.outcome.result, "partial write"); assert.ok(last.gaps.length);
});

test("orphan, mismatched, other-Step and cancelled receipts cannot attach to a later call", async () => {
  for (const kind of ["orphan", "other-step", "wrong-arguments", "wrong-turn", "no-receipt"] as const) {
    const f = fixture(); f.begin();
    if (kind === "other-step") { f.begin("other"); f.early(1); f.receipt(1, "UNAUTHORIZED"); f.begin(); }
    else if (kind === "orphan") f.receipt(1, "UNRELATED");
    else { f.early(kind === "wrong-turn" ? 2 : 1, "call", kind === "wrong-arguments" ? { revision: 9 } : { revision: 1 });
      if (kind !== "no-receipt") f.receipt(kind === "wrong-turn" ? 2 : 1, "MISMATCH"); }
    f.checkpoint(1);
    const result = await f.read(); assert.equal(result.outcome, undefined, kind); assert.ok(result.gaps.length);
  }
});
