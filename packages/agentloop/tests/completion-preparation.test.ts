import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComputerExecutor } from "../src/computer/computer-executor.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import type { CapabilityGrant, ModelAdapter, RuntimeEvent } from "../src/runtime/contracts.ts";
import { runtimeStepToolProgressPolicy } from "../src/runtime/tool-progress-policy.ts";
import { createComputerTools } from "../src/tools/computer-tools.ts";
import { ToolRegistry, type RuntimeTool } from "../src/tools/tool-registry.ts";
import { TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

for (const mode of ["complete", "stream"] as const) {
  test(`completion preparation reads a committed JSON file on the first ${mode} request and assesses its exact rows`, async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "agentloop-completion-read-"));
    try {
      const rows = [{ name: "客户甲", amount: 4117 }, { name: "客户乙", amount: 2060 }];
      let acquisitions = 0;
      let modelCalls = 0;
      let assessments = 0;
      const source: RuntimeTool<unknown> = {
        name: "collect_source",
        description: "Collect a bounded result into the workspace",
        inputSchema: { type: "object" },
        executionMode: "parallel",
        replaySafe: true,
        parse: (value) => value,
        execute: async () => {
          acquisitions += 1;
          await fs.writeFile(join(root, "result.json"), JSON.stringify({ rows }));
          return {
            path: "result.json",
            evidenceReceipt: {
              schema: "agentloop.toolEvidenceReceipt/v1",
              evidenceKinds: { satisfied: ["source_summary"], caveated: [], failed: [] },
            },
          };
        },
      };
      const allowedNames = ["collect_source", "computer_read_json", "computer_read_file"];
      const grant: CapabilityGrant = {
        actorUserId: "user-1", runId: "completion-read", depth: 0,
        allowedToolNames: new Set(allowedNames), allowedSkillIds: new Set(),
        visibleDirectories: [], uploadedSources: [], skillExecutionRoots: [],
      };
      const events: RuntimeEvent[] = [];
      const respond: ModelAdapter["complete"] = async (request) => {
        modelCalls += 1;
        assert.deepEqual(request.tools.map((tool) => tool.name).sort(), [...allowedNames].sort());
        assert.doesNotMatch(request.runtimeContext?.content ?? "", /No (?:execution )?tools are available|fenced off/);
        if (modelCalls === 1) {
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "source", name: "collect_source", arguments: {} }] };
        }
        if (modelCalls === 2) {
          assert.match(request.runtimeContext?.content ?? "", /runtime_convergence/);
          return {
            content: "", finishReason: "tool_calls",
            toolCalls: [{ id: "read-json", name: "computer_read_json", arguments: { path: "result.json", queries: [{ pointer: "/rows" }] } }],
          };
        }
        assert.equal(modelCalls, 3, "the read must not require resubmitting its call");
        const read = request.messages.find((message) => message.role === "tool" && message.toolCallId === "read-json");
        assert.ok(read);
        assert.deepEqual(JSON.parse(read.content).queries[0].value, rows);
        return { content: "客户甲：4117；客户乙：2060", finishReason: "stop", toolCalls: [] };
      };
      const result = await runAgentLoop({
        runId: grant.runId,
        systemPrompt: "List the requested names and amounts from the result.",
        input: "列出客户和金额",
        grant,
        tools: new ToolRegistry([source, ...createComputerTools(new ComputerExecutor(root))]),
        // Receipt readiness triggers completion preparation on turn two. The
        // file must be read then, leaving turn three for independent Assessment.
        maxSteps: 3,
        progressPolicy: runtimeStepToolProgressPolicy(["source_summary"], { scope: "artifact" }),
        model: {
          limits: TEST_MODEL_LIMITS,
          complete: respond,
          ...(mode === "complete" ? {} : { stream: async (request, sink) => {
            const response = await respond(request);
            for (const [index, call] of response.toolCalls.entries()) {
              await sink({ type: "tool_call_ready", index, ...call });
            }
            return response;
          } } satisfies Partial<ModelAdapter>),
        },
        emit: (event) => { events.push(event); },
        evaluateCandidate: async (candidate) => {
          assessments += 1;
          assert.match(candidate.output, /客户甲：4117/);
          assert.equal(candidate.toolEvidence.some((item) => item.toolCallId === "read-json" && !item.isError), true);
          return { approved: true, feedback: "" };
        },
      });
      assert.match(result.output, /客户乙：2060/);
      assert.equal(acquisitions, 1);
      assert.equal(modelCalls, 3);
      assert.equal(assessments, 1);
      assert.equal(events.filter((event) => event.type === "tool.completed" && event.data.toolCallId === "read-json").length, 1);
      assert.equal(events.some((event) => event.type === "loop.convergence_reopened" || event.type === "tool.rejected"), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("completion preparation rejects an ungranted tool instead of executing or silently discarding it", async () => {
  let modelCalls = 0;
  let unauthorizedExecutions = 0;
  const events: RuntimeEvent[] = [];
  const source: RuntimeTool<unknown> = {
    name: "collect_source", description: "Collect source evidence", inputSchema: { type: "object" },
    executionMode: "parallel", replaySafe: true, parse: (input) => input,
    execute: async () => ({ evidenceReceipt: {
      schema: "agentloop.toolEvidenceReceipt/v1",
      evidenceKinds: { satisfied: ["source_summary"], caveated: [], failed: [] },
    } }),
  };
  const unauthorized: RuntimeTool<unknown> = {
    name: "unauthorized_write", description: "Not granted", inputSchema: { type: "object" },
    executionMode: "exclusive", replaySafe: false, parse: (input) => input,
    execute: async () => { unauthorizedExecutions += 1; return "must not execute"; },
  };
  const grant: CapabilityGrant = {
    actorUserId: "user-1", runId: "completion-denied", depth: 0,
    allowedToolNames: new Set([source.name]), allowedSkillIds: new Set(),
    visibleDirectories: [], uploadedSources: [], skillExecutionRoots: [],
  };
  await runAgentLoop({
    runId: grant.runId, systemPrompt: "Summarize the source", input: "Summarize", grant,
    tools: new ToolRegistry([source, unauthorized]), maxSteps: 3,
    progressPolicy: runtimeStepToolProgressPolicy(["source_summary"], { scope: "artifact" }),
    model: {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        modelCalls += 1;
        assert.deepEqual(request.tools.map((tool) => tool.name), [source.name]);
        if (modelCalls < 3) return {
          content: "", finishReason: "tool_calls",
          toolCalls: [{ id: `call-${modelCalls}`, name: modelCalls === 1 ? source.name : unauthorized.name, arguments: {} }],
        };
        return { content: "Source summary completed from existing evidence.", finishReason: "stop", toolCalls: [] };
      },
    },
    emit: (event) => { events.push(event); },
    evaluateCandidate: async () => ({ approved: true, feedback: "" }),
  });
  assert.equal(unauthorizedExecutions, 0);
  assert.equal(modelCalls, 3);
  assert.equal(events.filter((event) => event.type === "tool.rejected" && event.data.toolName === unauthorized.name).length, 1);
  assert.equal(events.some((event) => event.type === "loop.convergence_reopened"), false);
});
