import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import type { ModelAdapter, ModelResponse, RuntimeEvent } from "../src/runtime/contracts.ts";
import { artifactStepToolProgressPolicy, deriveRuntimeStepEvidenceState } from "../src/runtime/tool-progress-policy.ts";
import type { WorkProductToolEvent } from "../src/runtime/work-product-observations.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

interface ReplayFixture {
  runId: string;
  workspaceId: string;
  events: (WorkProductToolEvent & { originalPayloadSha256: string })[];
  emptyModelResponses: { seq: number; originalPayloadSha256: string; response: ModelResponse }[];
}
const fixture = (id: string): ReplayFixture => JSON.parse(readFileSync(new URL(`./fixtures/work-product/${id}.json`, import.meta.url), "utf8"));
const policy = artifactStepToolProgressPolicy(["artifact_path", "artifact_non_empty", "artifact_acceptance"], { expectedArtifactKind: "presentation" });

// Characterization only. These assertions freeze the pre-stage-3 consumer;
// they document defects, not the desired semantics of the new offline reducer.
test("baseline A/B: existing collector sees files but flattens deletion and infers PPTX purpose", () => {
  const a = deriveRuntimeStepEvidenceState({ policy, evidence: fixture("a").events.map((event) => event.evidence) })!;
  const b = deriveRuntimeStepEvidenceState({ policy, evidence: fixture("b").events.map((event) => event.evidence) })!;
  assert.ok(a.knownArtifacts.some((artifact) => artifact.path === "themed.pptx"));
  assert.ok(b.knownArtifacts.some((artifact) => artifact.path === "test_fill.pptx"));
  assert.ok(b.processArtifacts.some((artifact) => artifact.path === "generator.js"), "baseline incorrectly keeps the deleted path");
});

test("baseline C: existing collector drops side effects when isError is true", () => {
  const state = deriveRuntimeStepEvidenceState({ policy, evidence: [{ toolCallId: "partial", toolName: "computer_run_command",
    isError: true, operationStatus: "failed", result: JSON.stringify({ exitCode: 1,
      fileChanges: [{ path: "partial.pptx", changeType: "created", bytes: 10 }] }) }] })!;
  assert.equal(state.knownArtifacts.length, 0);
});

for (const id of ["a", "b"]) test(`fixture ${id}: bounded scripted tools + empty model responses replay identically without IO`, async () => {
  const data = fixture(id);
  assert.equal(data.emptyModelResponses.length, 4);
  assert.ok(data.events.every((event) => /^[a-f\d]{64}$/.test(event.originalPayloadSha256)));
  const replay = async () => {
    let modelIndex = 0;
    let assessments = 0;
    const emitted: RuntimeEvent[] = [];
    const names = [...new Set(data.events.map((event) => event.evidence.toolName))];
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async () => {
        const event = data.events[modelIndex++];
        if (event !== undefined) return { content: "", finishReason: "tool_calls", toolCalls: [{
          id: event.evidence.toolCallId, name: event.evidence.toolName, arguments: { seq: event.seq },
        }] };
        const empty = data.emptyModelResponses[modelIndex - data.events.length - 1];
        assert.ok(empty, "script exhausted: replay must not call an external model");
        return empty.response;
      },
    };
    const grant = createCapabilityGrant({ actorUserId: "fixture-user", runId: data.runId,
      depth: 0, allowedToolNames: names, allowedSkillIds: [] });
    const tools = new ToolRegistry(names.map((name) => ({ name, description: "In-memory recorded result only",
      inputSchema: { type: "object" as const }, executionMode: "exclusive" as const, replaySafe: true,
      parse: (input: unknown) => input as { seq: number },
      execute: async (_context, input: { seq: number }) => {
        const event = data.events.find((event) => event.seq === input.seq)!;
        assert.equal(event.evidence.toolName, name);
        return JSON.parse(event.evidence.result);
      },
    })));
    await assert.rejects(() => runAgentLoop({ runId: data.runId, systemPrompt: "Deterministic boundary replay",
      input: "Replay selected recorded operations, then reject empty completion.", model, tools, grant,
      maxSteps: data.events.length + 4, emit: (event) => { emitted.push(event); },
      // Script the persisted repeated-assessment boundary as well as the model.
      evaluateCandidate: async () => ({ approved: false, feedback: "Completion remains unverified",
        allowRepairLimitCompletion: false, assessmentReused: ++assessments > 1 }),
    }), (error: unknown) => error instanceof Error && /already rejected against the same evidence/.test(error.message));
    const completions = emitted.filter((event) => event.type === "tool.completed");
    assert.equal(completions.length, data.events.length);
    assert.equal(emitted.some((event) => event.type === "candidate.repair_limit_blocked"), true);
    assert.equal(emitted.some((event) => event.type === "candidate.approved"), false);
    return {
      calls: modelIndex,
      tools: completions.map((event) => ({ call: event.data.toolCallId, operationStatus: event.data.operationStatus })),
      rejections: emitted.filter((event) => event.type === "candidate.rejected").map((event) => event.data.output),
    };
  };
  const first = await replay();
  assert.deepEqual(first, await replay());
  if (id === "b") assert.equal(first.tools.filter((entry) => entry.operationStatus === "failed").length, 3);
});
