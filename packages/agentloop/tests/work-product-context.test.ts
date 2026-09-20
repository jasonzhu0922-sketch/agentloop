import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComputerExecutor } from "../src/computer/computer-executor.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ContextAssembler, estimateTextTokens } from "../src/runtime/context-assembler.ts";
import type { ModelInvocation, ModelMessage, RuntimeEvent } from "../src/runtime/contracts.ts";
import { artifactStepToolProgressPolicy, deriveRuntimeStepEvidenceState } from "../src/runtime/tool-progress-policy.ts";
import { WorkProductContext, WORK_PRODUCT_CONTEXT_MAX_CHARACTERS } from "../src/runtime/work-product-context.ts";
import { DefaultStepExecutionStrategy } from "../src/runtime/step-execution-strategy.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

function memoryStore() {
  const saved = new Map<string, string>();
  return { saved, storeSnapshot: async (content: string) => {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const path = `.agentloop/content-refs/${sha256}.json`;
    saved.set(path, content);
    return { kind: "content_addressed" as const, path, sha256, bytes: Buffer.byteLength(content), characters: content.length, format: "json" as const };
  } };
}
function frame(request: ModelInvocation): any {
  const match = request.runtimeContext?.content.match(/<loop_step_frame source="server">\n([\s\S]*?)\n<\/loop_step_frame>/);
  assert.ok(match);
  return JSON.parse(match[1]);
}
const fixture = (id: string) => JSON.parse(readFileSync(new URL(`./fixtures/work-product/${id}.json`, import.meta.url), "utf8"));
const completed = (seq: number, result: unknown): RuntimeEvent => ({ type: "tool.completed", data: {
  toolCallId: `call-${seq}`, toolName: "computer_run_command", result: JSON.stringify(result), isError: false, operationStatus: "succeeded",
} });

for (const id of ["a", "b"]) test(`stage 3 fixture ${id}: actual model input preserves role, diagnosis and file facts under small tool previews`, async () => {
  const data = fixture(id);
  const storage = memoryStore();
  const emitted: RuntimeEvent[] = [];
  const modelInputs: string[] = [];
  const names = [...new Set<string>(data.events.map((event: any) => event.evidence.toolName))];
  const plan = artifactStepToolProgressPolicy(["artifact_acceptance"], { expectedArtifactKind: "presentation" });
  let round = 0;
  const result = await runAgentLoop({
    runId: data.runId, systemPrompt: "Do the bounded task", input: "Keep previous work and resolve the remaining gap", maxSteps: 20,
    workProductContext: { goalId: "goal", goal: "Finish the target artifact", workspaceId: data.workspaceId, storeSnapshot: storage.storeSnapshot },
    grant: createCapabilityGrant({ actorUserId: "fixture-user", runId: data.runId, depth: 0, allowedToolNames: names, allowedSkillIds: [] }),
    tools: new ToolRegistry(names.map((name) => ({ name, description: "Replay only", inputSchema: { type: "object" as const },
      executionMode: "exclusive" as const, replaySafe: true, parse: (input: unknown) => input as { index: number },
      execute: async (_context, input: { index: number }) => input.index === -1 ? { exitCode: 0, fileChanges: [] }
        : JSON.parse(data.events[input.index].evidence.result),
    }))),
    progressPolicy: { ...plan, autoCompleteFromEvidence: false },
    contextPolicy: { largeToolResultProjectionCharacters: 160, largeToolResultPreviewCharacters: 50 },
    emit: (event) => { emitted.push(event); },
    evaluateCandidate: async (candidate) => ({ approved: candidate.output === "bounded answer", feedback: "scripted assessment; not a real acceptance claim" }),
    model: { limits: TEST_MODEL_LIMITS, complete: async (request) => {
      const current = frame(request);
      const state = current.workProductContext;
      assert.ok(state);
      assert.equal(current.currentEvidenceState, undefined);
      assert.doesNotMatch(request.runtimeContext!.content, /<runtime_step_semantic_state>/);
      assert.ok(JSON.stringify(state).length <= WORK_PRODUCT_CONTEXT_MAX_CHARACTERS);
      modelInputs.push(JSON.stringify(state));
      const index = round++;
      if (index < data.events.length) return { content: "", finishReason: "tool_calls", toolCalls: [{
        id: data.events[index].evidence.toolCallId, name: data.events[index].evidence.toolName, arguments: { index },
      }] };
      const path = id === "a" ? "themed.pptx" : "test_fill.pptx";
      const object = state.objects.find((object: any) => object.path === path);
      assert.equal(object.presence, "present");
      if (index === data.events.length) {
        const updates: unknown[] = [{ kind: "role", path, versionId: object.versionId, role: id === "a" ? "candidate" : "experiment" }];
        const pending = state.objects.find((object: any) => object.path === (id === "a" ? "remap_fonts.py" : "generator.cjs"));
        updates.push({ kind: "issue", issueId: "remaining-work", path: pending.path, versionId: pending.versionId,
          symptom: id === "a" ? "font script has not run" : "generator failed", diagnosis: "needs targeted execution",
          evidenceToolCallIds: [pending.observedBy], pendingActions: [id === "a" ? "run font script" : "repair generator, then produce target"], claimedStatus: "open" });
        return { content: `<work_product_progress>${JSON.stringify({ updates })}</work_product_progress>`, finishReason: "tool_calls",
          toolCalls: [{ id: "after-declaration", name: "computer_run_command", arguments: { index: -1 } }] };
      }
      assert.equal(object.role, id === "a" ? "candidate" : "experiment");
      assert.equal(state.issues[0].claimedStatus, "open");
      assert.equal(state.issues[0].resolutionSupport, "none");
      if (id === "b") {
        assert.equal(state.objects.find((object: any) => object.path === "generator.js").presence, "deleted");
        assert.equal(state.objects.some((object: any) => object.path === "target.pptx"), false);
        assert.ok(state.failedOperations.some((operation: any) => operation.diagnosticPreview.includes("shape")));
      }
      return { content: "bounded answer", finishReason: "stop", toolCalls: [] };
    } },
  });
  assert.equal(result.output, "bounded answer");
  assert.equal(round, data.events.length + 2, "declarations do not add an assessor/model round");
  assert.ok(emitted.some((event) => event.type === "assistant.committed" && event.data.workProductDeclaration !== undefined));
  assert.ok(emitted.some((event) => event.type === "tool.completed" && (event.data.workProductSequence as any)?.sequenceKind === "loop_observation"));
  const final = JSON.parse(modelInputs.at(-1)!);
  assert.ok(storage.saved.has(final.fullStateRef.path));
});

test("snapshot overflow is bounded, fully readable with a Runtime-owned digest, and does not disappear after unrelated events", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-product-context-"));
  try {
    const executor = new ComputerExecutor(root);
    const context = new WorkProductContext("run", { goalId: "goal", goal: "Finish report", workspaceId: root,
      storeSnapshot: (content) => executor.storeContentReference(content) });
    for (let index = 0; index < 80; index++) context.capture(completed(index, { exitCode: 0,
      fileChanges: [{ path: `file-${index}.bin`, changeType: "created", bytes: 10 }] }));
    for (let index = 80; index < 160; index++) context.capture(completed(index, { exitCode: 0, fileChanges: [], stdout: "irrelevant" }));
    const projection = await context.project() as any;
    assert.ok(JSON.stringify(projection).length <= WORK_PRODUCT_CONTEXT_MAX_CHARACTERS);
    assert.ok(projection.omitted.objects > 0);
    assert.equal(projection.counts.objects, 80);
    const ref = projection.fullStateRef;
    let content = "";
    for (let offset = 0; offset < ref.characters; offset += 12000) {
      const part = await executor.readContentReference(ref.path, offset, 12000);
      content += part.content;
    }
    const stored = JSON.parse(content);
    assert.equal(stored.facts.objects.length, 80);
    assert.equal(stored.toolResults.length, 160);
    assert.equal(stored.facts.objects[0].path, "file-0.bin");
    assert.equal(await context.project(), projection, "unchanged projection reuses its immutable reference");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("summary may omit all artifacts but the rebuilt Runtime frame retains them after actual compaction", async () => {
  const storage = memoryStore();
  const context = new WorkProductContext("run", { goalId: "goal", goal: "keep candidate", workspaceId: "workspace", storeSnapshot: storage.storeSnapshot });
  context.capture(completed(0, { exitCode: 0, fileChanges: [{ path: "candidate.bin", changeType: "created", bytes: 10 }] }));
  const projection = await context.project();
  const events: RuntimeEvent[] = [];
  const assembler = new ContextAssembler({ runId: "run", systemPrompt: "system", runtimeContext: { phase: "execution", content: "goal and constraints" },
    policy: { outputReserveTokens: 1000, safetyMarginTokens: 500, proactiveCompactionTokens: 6000, preserveRecentTokens: 300,
      pruneProtectTokens: 100, summaryMaxOutputTokens: 2000, deferProactiveCompactionForArtifactEvidence: false },
    model: { limits: { contextWindowTokens: 16000, maxOutputTokens: 2000 }, complete: async () => ({ content: SUMMARY, toolCalls: [], finishReason: "stop" }) },
    emit: (event) => { events.push(event); },
  });
  assembler.setRuntimeStepFrame(JSON.stringify({ workProductContext: projection }));
  const messages: ModelMessage[] = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? "assistant" : "user",
    content: "unrelated narrative without any artifact metadata ".repeat(80) }));
  const assembled = await assembler.assemble(messages, []);
  assert.ok(events.some((event) => event.type === "context.compacted"));
  assert.match(assembled.runtimeContext.content, /candidate\.bin/);
  assert.match(assembled.runtimeContext.content, /fullStateRef/);
  assert.ok(!SUMMARY.includes("candidate.bin"));
});

for (const legacyStrategy of [false, true]) test(`optional malformed declarations cannot fail a Run without event sink (legacy strategy=${legacyStrategy})`, async () => {
  const storage = memoryStore();
  let round = 0;
  const result = await runAgentLoop({ runId: "run", systemPrompt: "system", input: "task", maxSteps: 4,
    ...(legacyStrategy ? { stepExecutionStrategy: { id: "legacy-fixture", prepareModelStep: (input: Parameters<DefaultStepExecutionStrategy["prepareModelStep"]>[0]) => {
      const decision = new DefaultStepExecutionStrategy().prepareModelStep({ ...input, workProductContext: undefined });
      assert.equal(decision.loopStepFrame.workProductContext, undefined);
      return decision;
    } } } : {}),
    workProductContext: { goalId: "goal", goal: "task", workspaceId: "w", storeSnapshot: storage.storeSnapshot },
    grant: createCapabilityGrant({ actorUserId: "u", runId: "run", depth: 0, allowedToolNames: ["computer_write_file"], allowedSkillIds: [] }),
    tools: new ToolRegistry([{ name: "computer_write_file", description: "fixture", inputSchema: { type: "object" }, executionMode: "exclusive", replaySafe: true,
      parse: (input) => input, execute: async () => ({ path: "file.txt", mode: "create", bytes: 12 }) }]),
    model: { limits: TEST_MODEL_LIMITS, complete: async (request) => {
      if (round++ === 0) return { content: "<work_product_progress>{bad}</work_product_progress>", finishReason: "tool_calls",
        toolCalls: [{ id: "write", name: "computer_write_file", arguments: {} }] };
      const state = frame(request).workProductContext;
      assert.equal(state.objects[0].presence, "present");
      assert.equal(state.counts.rejectedDeclarations, 1);
      return { content: "done", finishReason: "stop", toolCalls: [] };
    } },
  });
  assert.equal(result.output, "done");
});

test("shared context changes neither authorized/preferred tools nor policy gates; fixture budget is measured", async (t) => {
  const data = fixture("b"); const storage = memoryStore();
  const context = new WorkProductContext(data.runId, { goalId: "goal", goal: "finish artifact", workspaceId: data.workspaceId, storeSnapshot: storage.storeSnapshot });
  for (const event of data.events) context.capture({ type: "tool.completed", data: event.evidence });
  const state = await context.project();
  const strategy = new DefaultStepExecutionStrategy();
  const policy = artifactStepToolProgressPolicy(["artifact_acceptance"], { expectedArtifactKind: "presentation" });
  const input = { modelStep: 10, maxSteps: 20, hardLimit: 20, convergenceOnly: false, priorToolEvidence: data.events.map((event: any) => event.evidence),
    availableTools: [{ name: "computer_run_command", description: "command", inputSchema: { type: "object" as const } }],
    stepEvidenceState: deriveRuntimeStepEvidenceState({ policy, evidence: data.events.map((event: any) => event.evidence) }) };
  const before = strategy.prepareModelStep(input); const after = strategy.prepareModelStep({ ...input, workProductContext: state });
  assert.deepEqual(before.toolCatalog, after.toolCatalog);
  assert.equal(after.loopStepFrame.currentEvidenceState, undefined);
  assert.equal(input.stepEvidenceState!.workProduct.status, "deliverable_available", "unchanged legacy gate is deliberately not repaired in stage 3");
  const chars = JSON.stringify(state).length;
  t.diagnostic(JSON.stringify({ fixture: "B", beforeFrameCharacters: JSON.stringify(before.loopStepFrame).length,
    afterFrameCharacters: JSON.stringify(after.loopStepFrame).length, sharedStateCharacters: chars, sharedStateEstimatedTokens: estimateTextTokens(JSON.stringify(state)) }));
  assert.ok(chars < 6500);
});

const SUMMARY = "## Goal\nContinue task\n## Constraints & Preferences\n- Original constraints\n## Progress\n### Done\n- Some work\n### In Progress\n- Task\n### Blocked\n- None\n## Key Decisions\n- None\n## Evidence\n- See Runtime\n## Next Steps\n1. Continue\n## Critical Context\n- Original goal";
