import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { PrivateSkill } from "@zhujun/agentloop";
import { fixedSkillExecutionPolicy } from "../src/skill-policy.ts";

test("fixed package policy admits declared entrypoints and keeps credentials private", async () => {
  const skill = { name: "data-analysis", package: { root: fileURLToPath(new URL("../skills/data-analysis", import.meta.url)) } } as PrivateSkill;
  const policy = await fixedSkillExecutionPolicy(skill);
  const decision = async (tool: string, input: unknown) => await policy.evaluate({ tool: { name: tool }, input } as never);
  const check = async (tool: string, input: unknown) => (await decision(tool, input)).decision;
  assert.equal(await check("computer_run_command", { command: "python3", args: ["scripts/data_client.py", "catalog"], cwd: "@skills/data-analysis" }), "allow");
  assert.equal(await check("computer_run_command", {
    command: "python3", args: ["scripts/result_compute.py", "compute-result", "--request-json", "{}", "--output", "@workspace/result.json"], cwd: "@skills/data-analysis",
  }), "allow");
  const missingPlan = await decision("computer_run_command", {
    command: "python3", args: ["scripts/data_client.py", "execute", "--request-json", JSON.stringify({ sql: "SELECT 1" }), "--output", "@workspace/result.json"], cwd: "@skills/data-analysis",
  });
  assert.equal(missingPlan.decision, "deny");
  if (missingPlan.decision === "deny") assert.equal(missingPlan.code, "SEMANTIC_QUERY_PLAN_REQUIRED");
  assert.equal(await check("computer_run_command", {
    command: "python3", args: ["scripts/data_client.py", "execute", "--request-json", JSON.stringify({ sql: "SELECT 1", params: [], query_plan: { schema: "nl2sql.query-plan/v1" } }), "--output", "@workspace/result.json"], cwd: "@skills/data-analysis",
  }), "allow");
  assert.equal(await check("computer_run_command", {
    command: "python3", args: ["scripts/data_client.py", "execute", "--request-json", "@workspace/exec_request.json", "--output", "@workspace/result.json"], cwd: "@skills/data-analysis",
  }), "allow");
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
