import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { PrivateSkill } from "@zhujun/agentloop";
import { fixedSkillExecutionPolicy, gateRepairDecision, assessOriginalQuestion } from "../src/skill-policy.ts";

test("host question detects omitted literal month and wrong model question", () => {
  const actual = "请查 2026 年 2 月员工人数";
  const wrong = { business_intent: { question: "2026 年 3 月员工人数",
    time_range: { start: "2026-03-01", end: "2026-04-01" } } };
  assert.equal(assessOriginalQuestion(actual, wrong).status, "conflict");
  const aligned = { business_intent: { question: actual,
    time_range: { start: "2026-02-01", end: "2026-03-01" } } };
  assert.equal(assessOriginalQuestion(actual, aligned).status, "matched_limited");
  assert.equal(assessOriginalQuestion("查最近人数", aligned).status, "unproven");
});

test("original question check distinguishes absent and invalid model dates", () => {
  const prompt = "请查 2026 年 1 月和 2026 年 3 月人数";
  assert.equal(assessOriginalQuestion(prompt, { business_intent: { question: prompt } }).status, "unproven");
  const range = { business_intent: { question: prompt,
    time_range: { start: "2026-01-01", end: "2026-04-01" } } };
  assert.equal(assessOriginalQuestion(prompt, range).status, "unproven");
});

test("fixed package policy admits declared entrypoints and keeps credentials private", async () => {
  const skill = { name: "data-analysis", package: { root: fileURLToPath(new URL("../skills/data-analysis", import.meta.url)) } } as PrivateSkill;
  const policy = await fixedSkillExecutionPolicy(skill);
  const check = async (tool: string, input: unknown) => (await policy.evaluate({ tool: { name: tool }, input } as never)).decision;
  assert.equal(await check("computer_run_command", { command: "python3", args: ["scripts/data_client.py", "catalog"], cwd: "@skills/data-analysis" }), "allow");
  for (const input of [
    { command: "python3", args: ["-c", "print('bypass')"], cwd: "@skills/data-analysis" },
    { command: "sh", args: ["scripts/data_client.py"], cwd: "@skills/data-analysis" },
    { command: "python3", args: ["scripts/data_client.py"], cwd: "." },
  ]) assert.equal(await check("computer_run_command", input), "deny");
  for (const path of ["@skills/data-analysis/connections.json", "@skills/data-analysis/references/../connections.json", "@skills/data-analysis", "@skills/data-analysis/scripts/data_client.py", "@skills/data-analysis/references/../../other/connections.json"])
    assert.equal(await check("computer_search_text", { path }), "deny", path);
  for (const path of ["@skills/data-analysis/SKILL.md", "@skills/data-analysis/references/planning.md", "answer.json"])
    assert.equal(await check("computer_read_file", { path }), "allow", path);
});

test("enforce stops the same physical refusal after two corrections, but new evidence resets it", async () => {
  const rows: Array<{ type: string; payload_json: string }> = [];
  const event = (type: string, data: object) => rows.push({ type, payload_json: JSON.stringify(data) });
  const call = (id: string, action: string) => event("assistant.tool_call.committed", {
    toolCallId: id, arguments: { command: "python3", args: ["scripts/data_client.py", action] },
  });
  const result = (id: string, body: object) => event("tool.completed", { toolCallId: id,
    toolName: "computer_run_command", result: JSON.stringify({ stdout: JSON.stringify(body) }) });
  const refused = { status: "rejected", diagnostic: { origin: "query_gateway", sql_executed: false,
    code: "ratio_sql_mismatch", field: "ratio_binding.group_by", expected: "['period']", actual: "['org']" } };
  call("1", "execute"); result("1", refused);
  assert.equal(gateRepairDecision(rows).decision, "allow");
  call("2", "execute"); result("2", refused);
  assert.equal(gateRepairDecision(rows).decision, "allow");
  call("2b", "execute"); result("2b", refused);
  assert.equal(gateRepairDecision(rows).decision, "deny");
  call("3", "get-query-context"); result("3", { status: "completed", content: { catalog_revision: "new", table: "staff" } });
  assert.equal(gateRepairDecision(rows).decision, "allow");
  call("4", "execute"); result("4", refused);
  assert.equal(gateRepairDecision(rows).decision, "allow");
  call("5", "get-query-context"); result("5", { status: "completed", content: { catalog_revision: "new", table: "staff" } });
  call("6", "execute"); result("6", refused);
  assert.equal(gateRepairDecision(rows).decision, "allow");
  call("7", "execute"); result("7", refused);
  assert.equal(gateRepairDecision(rows).decision, "deny");
  event("human_loop.answered", { value: "confirmed" });
  assert.equal(gateRepairDecision(rows).decision, "allow");
});

test("large metadata receipts count once as evidence across output paths", () => {
  const rows: Array<{ type: string; payload_json: string }> = [];
  const event = (type: string, data: object) => rows.push({ type, payload_json: JSON.stringify(data) });
  const call = (id: string, action: string) => event("assistant.tool_call.committed", { toolCallId: id,
    arguments: { command: "python3", args: ["scripts/data_client.py", action] } });
  const receipt = (id: string, body: object) => event("tool.completed", { toolCallId: id,
    toolName: "computer_run_command", result: JSON.stringify({ stdout: JSON.stringify(body) }) });
  const refused = { status: "rejected", diagnostic: { origin: "query_gateway", sql_executed: false,
    code: "ratio_sql_mismatch", field: "ratio_binding.group_by", expected: "period", actual: "org" } };
  const evidence = (path: string, hash: string) => ({ status: "completed", path, sha256: hash, content_complete: false });
  call("1", "execute"); receipt("1", refused);
  call("2", "execute"); receipt("2", refused);
  call("3", "get-query-context"); receipt("3", evidence("a.json", "a".repeat(64)));
  call("4", "execute"); receipt("4", refused);
  assert.equal(gateRepairDecision(rows).decision, "allow");
  call("5", "get-query-context"); receipt("5", evidence("b.json", "a".repeat(64)));
  call("6", "execute"); receipt("6", refused);
  call("7", "execute"); receipt("7", refused);
  assert.equal(gateRepairDecision(rows).decision, "deny");
});

test("same root cause cannot reset the budget by changing SQL details", () => {
  const rows: Array<{ type: string; payload_json: string }> = [];
  const event = (type: string, data: object) => rows.push({ type, payload_json: JSON.stringify(data) });
  for (let index = 0; index < 3; index++) {
    const id = `retry-${index}`;
    event("assistant.tool_call.committed", { toolCallId: id,
      arguments: { command: "python3", args: ["scripts/data_client.py", "execute"] } });
    event("tool.completed", { toolCallId: id, toolName: "computer_run_command",
      result: JSON.stringify({ stdout: JSON.stringify({ status: "rejected", diagnostic: {
        origin: "query_gateway", sql_executed: false, code: "time_sql_mismatch",
        field: "time_bindings", expected: "2026-01", actual: `variation-${index}`,
      } }) }) });
  }
  assert.equal(gateRepairDecision(rows).decision, "deny");
});
