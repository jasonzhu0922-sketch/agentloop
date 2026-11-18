import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { WorkProductContext } from "../src/runtime/work-product-context.ts";
import { deriveCurrentDecisionView } from "../src/runtime/current-decision-view.ts";
import { reconstructRecoveryTranscript, selectRecoveryExchanges } from "../src/runtime/recovery-transcript.ts";
import { artifactStepToolProgressPolicy } from "../src/runtime/tool-progress-policy.ts";
import { ToolRegistry, type RuntimeTool } from "../src/tools/tool-registry.ts";
import type { CapabilityGrant, ModelResponse, RuntimeEvent } from "../src/runtime/contracts.ts";

const target = { targetId: "report", purpose: "Complete forecast report", kind: "html", format: "html" };
const contextOptions = {
  goalId: "plan:1:report", goal: target.purpose, workspaceId: "workspace", deliveryTargets: [target],
  storeSnapshot: async (content: string) => ({ kind: "content_addressed" as const, path: "state.json", sha256: "0".repeat(64),
    bytes: Buffer.byteLength(content), characters: content.length, format: "json" as const }),
};
const grant: CapabilityGrant = { actorUserId: "owner", runId: "run", depth: 0,
  allowedToolNames: new Set(["computer_write_file", "verify_artifact_acceptance"]), allowedSkillIds: new Set(),
  visibleDirectories: [], uploadedSources: [], skillExecutionRoots: [] };
const receipt = (revision: number, selected = true) => ({ path: "forecast.html", bytes: revision * 2000, sha256: String(revision).repeat(64),
  artifactReceipt: { schema: "agentloop.artifactReceipt/v1", ...(selected ? { deliveryTargetId: target.targetId } : {}),
    artifact: { path: "forecast.html", bytes: revision * 2000, sha256: String(revision).repeat(64) },
    evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty"], caveated: [], failed: [] } } });
const stop = (): ModelResponse => ({ content: "Forecast report is ready.", finishReason: "stop", toolCalls: [] });
const call = (id: string, name: string, args: unknown): ModelResponse => ({ content: "", finishReason: "tool_calls", toolCalls: [{ id, name, arguments: args }] });

test("multi-chunk authoring and explicit intermediate checks keep full budgets; semantic rejection repairs the current version", async () => {
  let revision = 0, turn = 0, checks = 0, assessments = 0;
  const events: RuntimeEvent[] = [];
  const tools: RuntimeTool<unknown>[] = [{ name: "computer_write_file", description: "Author report", executionMode: "exclusive", replaySafe: false,
    inputSchema: { type: "object", properties: { content: { type: "string" } } },
    boundedContent: { field: "content", targetField: "path", continuationInstruction: "Append the remaining content." },
    parse: value => value, execute: async () => receipt(++revision),
  }, { name: "verify_artifact_acceptance", description: "Check physical HTML", executionMode: "parallel", replaySafe: true,
    inputSchema: { type: "object" }, parse: value => value, execute: async () => {
      checks++;
      return { schema: "agentloop.artifactAcceptance/v1", artifact: { path: "forecast.html", bytes: revision * 2000, sha256: String(revision).repeat(64) },
        verdict: "accepted", evidenceKinds: { satisfied: ["artifact_acceptance", "artifact_openable", "format_matches_request"], caveated: [], failed: [] } };
    } }];
  const result = await runAgentLoop({ runId: "run", grant, systemPrompt: "Complete the report", input: target.purpose,
    tools: new ToolRegistry(tools), workProductContext: contextOptions, maxSteps: 12,
    progressPolicy: artifactStepToolProgressPolicy(["artifact_path", "artifact_non_empty", "artifact_acceptance"], { expectedArtifactKind: "html" }),
    model: { limits: { contextWindowTokens: 1000000, maxOutputTokens: 16384 }, complete: async request => {
      turn++;
      assert.equal(request.maxOutputTokens, 16384, `turn ${turn} must retain the authoring budget`);
      const write = request.tools.find(tool => tool.name === "computer_write_file")!;
      assert.equal((write.inputSchema.properties as any).content.maxLength, 4096);
      if (turn === 2) {
        assert.equal(checks, 0, "a first fragment does not schedule automatic acceptance");
        return call("explicit-check", "verify_artifact_acceptance", { artifactPath: "forecast.html" });
      }
      if (turn === 3 || turn === 4) assert.equal(checks, 1, "intermediate acceptance does not trigger convergence or per-write checks");
      if (turn === 5 || turn === 7) return stop();
      assert.ok([1, 3, 4, 6].includes(turn));
      return call(`write-${turn}`, "computer_write_file", { path: "forecast.html", deliveryTargetId: "report", content: "x".repeat(3000), mode: turn === 1 ? "create" : "append" });
    } },
    emit: event => { events.push(event); }, evaluateCandidate: async candidate => {
      assessments++;
      assert.ok(candidate.decisionBasisDigest);
      assert.ok(candidate.toolEvidence.some(item => item.toolName === "verify_artifact_acceptance" && item.result.includes(String(revision).repeat(64))));
      assert.equal(checks, assessments + 1, "latest physical check is available to the same candidate assessment");
      assert.equal(revision, assessments === 1 ? 3 : 4);
      return { approved: assessments > 1, feedback: assessments === 1 ? "The forecast comparison and limitations are missing; complete the existing report." : "" };
    },
  });
  assert.equal(result.output, stop().content);
  assert.equal(turn, 7);
  assert.equal(assessments, 2);
  assert.equal(checks, 3);
  assert.equal(events.filter(event => event.type === "runtime.artifact_acceptance.scheduled").length, 2);
  assert.equal(events.some(event => event.type === "loop.convergence_requested" && event.data.reason === "current_step_evidence_complete"), false);
});

test("same-leaf recovery restores explicit versioned selection; replacement leaves do not inherit target authority", async () => {
  const before = new WorkProductContext("run", contextOptions);
  const committed: RuntimeEvent[] = [before.capture({ type: "tool.completed", data: { toolCallId: "draft", toolName: "computer_write_file", operationStatus: "succeeded", result: JSON.stringify(receipt(1, false)) } })];
  const unbound = deriveCurrentDecisionView({ runId: "run", workProducts: before.derive() });
  assert.deepEqual(unbound.currentGap.unboundDeliveryTargetIds, ["report"]);
  assert.equal(unbound.nextAction, "bind_delivery_target");
  assert.ok(unbound.candidateReadiness.blockedBy.includes("unbound_delivery_target"));
  const versionId = before.derive().observations.objects[0]!.currentVersionId;
  committed.push(before.capture({ type: "assistant.committed", data: { step: 2, finishReason: "tool_calls", toolCalls: [{ id: "inspect", name: "computer_read_file", arguments: {} }],
    content: `<work_product_progress>${JSON.stringify({ updates: [{ kind: "delivery_target", targetId: "report", path: "forecast.html", versionId }] })}</work_product_progress>` } }));
  const transcript = reconstructRecoveryTranscript({ userInput: target.purpose, stepId: "report", events: [
    { seq: 1, type: "plan.step.started", data: { stepId: "other" } },
    { seq: 2, type: "tool.completed", data: { toolCallId: "excluded", toolName: "computer_write_file", result: JSON.stringify(receipt(9)) } },
    { seq: 3, type: "plan.step.started", data: { stepId: "report" } },
    ...committed.map((event, index) => ({ ...event, seq: index + 4 })),
  ] });
  assert.equal(transcript.workProductEvents?.length, 2);
  const restored = new WorkProductContext("run", contextOptions);
  for (const event of transcript.workProductEvents ?? []) restored.capture(event);
  assert.deepEqual(restored.derive(), before.derive());
  const bound = deriveCurrentDecisionView({ runId: "run", workProducts: restored.derive() });
  assert.deepEqual(bound.currentGap.unboundDeliveryTargetIds, []);
  assert.notEqual(bound.identity.decisionBasisDigest, unbound.identity.decisionBasisDigest);
  const replacement = selectRecoveryExchanges({ userInput: target.purpose, transcripts: [transcript], toolCallIds: new Set(["draft"]) });
  assert.equal("workProductEvents" in replacement, false);
  let restoredChecks = 0;
  await runAgentLoop({ runId: "run", grant, systemPrompt: "Finish the restored report", input: target.purpose,
    initialWorkProductEvents: transcript.workProductEvents, initialToolEvidence: transcript.toolEvidence,
    workProductContext: contextOptions, maxSteps: 2,
    model: { limits: { contextWindowTokens: 100000, maxOutputTokens: 16384 }, complete: async () => stop() },
    tools: new ToolRegistry([{ name: "verify_artifact_acceptance", description: "Check restored bytes", inputSchema: { type: "object" },
      executionMode: "parallel", replaySafe: true, parse: value => value, execute: async () => {
        restoredChecks++;
        return { schema: "agentloop.artifactAcceptance/v1", artifact: { path: "forecast.html", bytes: 2000, sha256: "1".repeat(64) },
          verdict: "accepted", evidenceKinds: { satisfied: ["artifact_acceptance"], caveated: [], failed: [] } };
      } }]),
    progressPolicy: artifactStepToolProgressPolicy(["artifact_path", "artifact_acceptance"], { expectedArtifactKind: "html" }),
    evaluateCandidate: async candidate => {
      assert.equal(restoredChecks, 1);
      assert.ok(candidate.toolEvidence.some(item => item.toolName === "verify_artifact_acceptance"));
      return { approved: true, feedback: "" };
    },
  });
  assert.equal(restoredChecks, 1);
  // A write without a fresh selection invalidates the old versioned declaration.
  restored.capture({ type: "tool.completed", data: { toolCallId: "changed", toolName: "computer_write_file", operationStatus: "succeeded", result: JSON.stringify(receipt(2, false)) } });
  assert.deepEqual(restored.derive().semantics.deliveryTargets, []);
});
