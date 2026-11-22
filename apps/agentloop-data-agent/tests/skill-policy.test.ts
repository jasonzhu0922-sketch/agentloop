import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { PrivateSkill } from "@zhujun/agentloop";
import { fixedSkillExecutionPolicy } from "../src/skill-policy.ts";

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

test("business execution always carries its semantic query plan", async () => {
  const skill = { name: "data-analysis", package: { root: fileURLToPath(new URL("../skills/data-analysis", import.meta.url)) } } as PrivateSkill;
  const policy = await fixedSkillExecutionPolicy(skill);
  const evaluate = async (args: string[]) => policy.evaluate({
    tool: { name: "computer_run_command" },
    input: { command: "python3", args, cwd: "@skills/data-analysis" },
  } as never);
  const missing = await evaluate(["scripts/data_client.py", "execute", "--sql", "SELECT 1"]);
  assert.equal(missing.decision, "deny");
  assert.equal("code" in missing ? missing.code : undefined, "SEMANTIC_QUERY_PLAN_REQUIRED");
  assert.equal((await evaluate(["scripts/data_client.py", "execute", "--query-plan", "@workspace/query-plan.json"])).decision, "allow");
  assert.equal((await evaluate(["scripts/data_client.py", "execute", "--request-json", JSON.stringify({
    context_id: "ctx-1", query_plan: { context_id: "ctx-1" }, sql: "SELECT 1",
  })])).decision, "allow");
  assert.equal((await evaluate(["scripts/data_client.py", "execute", "--request-json", "@workspace/request.json"])).decision, "allow");
  assert.equal((await evaluate(["scripts/data_client.py", "execute", "--request-json", "{not-json"])).decision, "deny");
});

test("file export only admits the application-owned declared generator", async () => {
  const dataSkill = { id: "data", name: "data-analysis", package: { root: fileURLToPath(new URL("../skills/data-analysis", import.meta.url)) } } as PrivateSkill;
  const xlsx = { id: "xlsx", name: "xlsx", package: { root: fileURLToPath(new URL("../../../packages/agentloop-skills/skills/xlsx", import.meta.url)) } } as PrivateSkill;
  const policy = await fixedSkillExecutionPolicy(dataSkill, [xlsx]);
  const check = async (input: unknown, roots: readonly { skillId: string }[] = [{ skillId: "data" }, { skillId: "xlsx" }]) => (await policy.evaluate({
    tool: { name: "computer_run_command" }, input, context: { grant: { skillExecutionRoots: roots } },
  } as never)).decision;
  assert.equal(await check({ command: "python3", args: ["scripts/file_export.py", "build"], cwd: "@skills/data-analysis" }), "allow");
  assert.equal(await check({ command: "python3", args: ["scripts/file_export.py", "build"], cwd: "@skills/data-analysis" }, [{ skillId: "data" }]), "deny");
  assert.equal(await check({ command: "python3", args: ["scripts/file_export.py", "build", "--format", "markdown"], cwd: "@skills/data-analysis" }, [{ skillId: "data" }]), "allow");
  assert.equal(await check({ command: "python3", args: ["make_report.py", "@workspace/report.xlsx"], cwd: "." }), "deny");
  assert.equal(await check({ command: "node", args: ["scripts/build_report.cjs"], cwd: "@skills/docx" }), "deny");
  assert.equal(await check({ command: "python3", args: ["-c", "print('bypass')"], cwd: "." }), "deny");
});
