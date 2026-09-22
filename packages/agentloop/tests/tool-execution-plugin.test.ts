import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { createDecisionCommit } from "../src/runtime/decision-ledger.ts";
import { AppError } from "../src/shared/errors.ts";
import { SimpleCommandSafetyPlugin } from "../src/tools/simple-command-safety-plugin.ts";
import { ToolRegistry, type RuntimeTool } from "../src/tools/tool-registry.ts";
import type { ToolExecutionPlugin } from "../src/tools/tool-execution-plugin.ts";

function grant() {
  return createCapabilityGrant({ actorUserId: "user", runId: "run", depth: 0, allowedToolNames: ["computer_run_command"], allowedSkillIds: [] });
}

function commandTool(executions: { count: number }): RuntimeTool<{ command: string; args: string[] }> {
  return {
    name: "computer_run_command", description: "command", inputSchema: { type: "object" }, executionMode: "exclusive", replaySafe: false,
    parse: (input) => input as { command: string; args: string[] },
    execute: async () => { executions.count += 1; return { exitCode: 0 }; },
  };
}

test("execution plugin denies a parsed call before the Tool side effect", async () => {
  const executions = { count: 0 };
  const plugin: ToolExecutionPlugin = { id: "test.deny", version: "1", evaluate: () => ({ decision: "deny", code: "TEST_DENIED", reason: "test policy denied this call", ruleId: "test-rule" }) };
  const registry = new ToolRegistry([commandTool(executions)], { plugins: [plugin] });
  const prepared = registry.materialize(grant()).prepare({ id: "call", name: "computer_run_command", arguments: { command: "echo", args: ["ok"] } });
  // PreparedToolCall.tool is the public execution surface retained for existing
  // consumers; it must be guarded too, not only PreparedToolCall.execute.
  await assert.rejects(() => prepared.tool.execute({ grant: grant() }, prepared.input), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "TOOL_POLICY_DENIED");
    assert.equal(error.details?.pluginId, "test.deny");
    assert.equal(error.details?.policyCode, "TEST_DENIED");
    return true;
  });
  assert.equal(executions.count, 0);
});

test("simple command safety plugin blocks destructive commands and inline interpreters", async () => {
  for (const arguments_ of [
    { command: "rm", args: ["-rf", "outputs"] },
    { command: "node", args: ["-e", "require('node:fs').rmSync('outputs', { recursive: true })"] },
  ]) {
    const executions = { count: 0 };
    const registry = new ToolRegistry([commandTool(executions)], { plugins: [new SimpleCommandSafetyPlugin()] });
    const prepared = registry.materialize(grant()).prepare({ id: "call", name: "computer_run_command", arguments: arguments_ });
    await assert.rejects(() => prepared.execute({ grant: grant() }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "TOOL_POLICY_DENIED");
      return true;
    });
    assert.equal(executions.count, 0);
  }
});

test("a failing execution plugin fails closed", async () => {
  const executions = { count: 0 };
  const registry = new ToolRegistry([commandTool(executions)], { plugins: [{ id: "test.failure", version: "1", evaluate: () => { throw new Error("offline"); } }] });
  const prepared = registry.materialize(grant()).prepare({ id: "call", name: "computer_run_command", arguments: { command: "echo", args: ["ok"] } });
  await assert.rejects(() => prepared.execute({ grant: grant() }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "TOOL_POLICY_DENIED");
    return true;
  });
  assert.equal(executions.count, 0);
});

test("a Tool-declared identity binding rejects a conflicting HIL decision before its effect", () => {
  const executions = { count: 0 };
  const tool: RuntimeTool<{ identity: string }> = {
    name: "lookup_subject",
    description: "lookup", inputSchema: { type: "object" }, executionMode: "parallel", replaySafe: true,
    decisionBinding: { identityRefFields: ["identity"] },
    parse: (input) => input as { identity: string },
    execute: async () => { executions.count += 1; return {}; },
  };
  const scopedGrant = createCapabilityGrant({
    actorUserId: "user", runId: "run", planId: "plan", stepId: "step", depth: 0,
    allowedToolNames: ["lookup_subject"], allowedSkillIds: [],
  });
  const decision = createDecisionCommit({
    requestId: "request", requestRevision: 1, planId: "plan", stepId: "step",
    selectedOptions: [{ id: "chosen", label: "Chosen", identityRefs: ["identity-chosen"] }],
  });
  const registry = new ToolRegistry([tool]);
  assert.throws(
    () => registry.materialize(scopedGrant, { decisionLedger: [decision] }).prepare({
      id: "call", name: "lookup_subject", arguments: { identity: "identity-other" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "TOOL_POLICY_DENIED");
      assert.equal(error.details?.policyCode, "decision_binding_conflict");
      return true;
    },
  );
  assert.equal(executions.count, 0);
});
