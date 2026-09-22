import test from "node:test";
import assert from "node:assert/strict";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { resolveOperationBindings } from "../src/runtime/decision-binding.ts";
import { createDecisionCommit } from "../src/runtime/decision-ledger.ts";
import { ToolRegistry, type RuntimeTool } from "../src/tools/tool-registry.ts";

const decision = createDecisionCommit({
  requestId: "request-1",
  requestRevision: 1,
  planId: "plan-1",
  stepId: "step-1",
  selectedOptions: [{
    id: "option-nanjing",
    label: "宝武资源营销（南京）有限公司",
    identityRefs: ["91320114MAET4NGU00"],
  }],
});

test("Skill manifest decision binding resolves selected label and identity into immutable command constraints", () => {
  const bindings = resolveOperationBindings({
    skills: [{
      id: "discovered:enterprise-info",
      name: "enterprise-info",
      package: { packageHash: "hash", root: "/skills/enterprise-info", entrypointPath: "SKILL.md", fileCount: 1, totalBytes: 1 },
    } as never],
    manifests: new Map([["discovered:enterprise-info", [{
      id: "enterprise-info-query",
      description: "query",
      command: "python3",
      script: "scripts/enterprise_info.py",
      actions: [{
        id: "detail",
        description: "detail",
        inputs: [
          { name: "name", description: "label", required: true },
          { name: "identity-ref", description: "identity", required: true },
        ],
        decisionBinding: { labelInputs: ["name"], identityRefInputs: ["identity-ref"] },
        args: ["--action", "detail", "--name", "{{name}}", "--identity-ref", "{{identity-ref}}"],
        result: "result",
      }],
    }]]]),
    decisionLedger: [decision],
    planId: "plan-1",
    stepId: "step-1",
  });
  assert.equal(bindings.length, 1);
  assert.deepEqual(bindings[0]?.resolvedInputs, {
    name: "宝武资源营销（南京）有限公司",
    "identity-ref": "91320114MAET4NGU00",
  });
  assert.equal(bindings[0]?.cwd, "@skills/enterprise-info");
  assert.deepEqual(bindings[0]?.argumentConstraints, [
    { index: 0, value: "scripts/enterprise_info.py" },
    { index: 1, value: "--action" },
    { index: 2, value: "detail" },
    { index: 3, value: "--name" },
    { index: 4, value: "宝武资源营销（南京）有限公司" },
    { index: 5, value: "--identity-ref" },
    { index: 6, value: "91320114MAET4NGU00" },
  ]);
  assert.throws(() => (bindings as unknown as { push: unknown[] }).push({}), TypeError);
});

test("computer_run_command rejects a manifest operation with a substituted decision input before effect", () => {
  const commandTool: RuntimeTool = {
    name: "computer_run_command",
    description: "command",
    inputSchema: { type: "object" },
    executionMode: "exclusive",
    replaySafe: false,
    parse: (value) => value,
    execute: async () => "should not execute",
  };
  const binding = resolveOperationBindings({
    skills: [{ id: "skill-1", name: "skill-1", package: { packageHash: "hash", root: "/skills/skill-1", entrypointPath: "SKILL.md", fileCount: 1, totalBytes: 1 } } as never],
    manifests: new Map([["skill-1", [{
      id: "executor-1", description: "query", command: "python3", script: "scripts/query.py",
      actions: [{
        id: "detail", description: "detail", inputs: [{ name: "identity-ref", description: "identity", required: true }],
        decisionBinding: { identityRefInputs: ["identity-ref"] },
        args: ["--action", "detail", "--identity-ref", "{{identity-ref}}"], result: "result",
      }],
    }]]]),
    decisionLedger: [decision], planId: "plan-1", stepId: "step-1",
  });
  const grant = createCapabilityGrant({
    actorUserId: "user", runId: "run", planId: "plan-1", stepId: "step-1", depth: 0,
    allowedToolNames: ["computer_run_command"], allowedSkillIds: ["skill-1"], resolvedOperationBindings: binding,
  });
  const registry = new ToolRegistry([commandTool]);
  assert.throws(() => registry.materialize(grant).prepare({
    id: "call-1", name: "computer_run_command", arguments: {
      command: "python3",
      cwd: "@skills/skill-1",
      args: ["scripts/query.py", "--action", "detail", "--identity-ref", "9131011579144036XB"],
    },
  }), (error: unknown) => (error as { details?: { policyCode?: string } }).details?.policyCode === "resolved_operation_binding_conflict");
});
