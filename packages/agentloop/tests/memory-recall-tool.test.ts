import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryRecallTool } from "../src/tools/memory-recall-tool.ts";
import { createCoreTools } from "../src/tools/compose.ts";
import { ComputerExecutor } from "../src/computer/computer-executor.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import type { AgentLoopMemoryPlugin } from "../src/runtime/memory-plugin.ts";

test("step-local knowledge recall binds trusted identity, bounded information need and exact resource selectors", async () => {
  const requests: any[] = [];
  const memory = { name: "test", recall: async (input: unknown) => { requests.push(input); return undefined; } } as unknown as AgentLoopMemoryPlugin;
  const authorize = async (actor: string, runId: string) => { if (actor !== "alice" || runId !== "r") throw new Error("unauthorized"); };
  const tool = createMemoryRecallTool(memory, authorize);
  const grant = createCapabilityGrant({ actorUserId: "alice", runId: "r", planId: "p", stepId: "s", depth: 0, allowedToolNames: [tool.name], allowedSkillIds: [] });
  const input = tool.parse({ query: "Find the input verification command", layer: "environment", resourceContext: [{ key: "resourceVersion", value: "v1" }] });
  const result = await tool.execute({ grant }, input) as any;
  assert.equal(result.status, "empty");
  assert.deepEqual(requests[0], { runId: "r", target: "execution", stepContext: { resourceVersion: "v1", goal: input.query,
    knowledgeOnly: true, knowledgeLayer: "environment", planId: "p", stepId: "s" }, budget: { maxItems: 4, maxTokens: 1600 } });
  const foreign = { ...grant, actorUserId: "bob" };
  await assert.rejects(tool.execute({ grant: foreign }, input), /unauthorized/);
  assert.equal(requests.length, 1);
  assert.throws(() => tool.parse({ query: "x", tenantId: "foreign" }), /invalid/);
  assert.throws(() => tool.parse({ query: "x", resourceContext: [{ key: "goal", value: "override" }] }), /selectors/);
  assert.throws(() => tool.parse({ query: "x", resourceContext: [{ key: "version", value: "a" }, { key: "version", value: "b" }] }), /selectors/);
  const executor = new ComputerExecutor("/tmp");
  assert.equal(createCoreTools({ executor }).some(item => item.name === tool.name), false);
  assert.equal(createCoreTools({ executor, memoryRecall: { memory, authorizeRun: authorize } }).some(item => item.name === tool.name), true);
});
