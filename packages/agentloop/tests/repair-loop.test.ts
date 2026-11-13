import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComputerExecutor } from "../src/computer/computer-executor.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { deriveRuntimeStepEvidenceState, runtimeStepToolProgressPolicy } from "../src/runtime/tool-progress-policy.ts";
import { AppError } from "../src/shared/errors.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";
import { ArtifactRepairProgress } from "../src/runtime/artifact-repair-progress.ts";
import { deriveCurrentDecisionView } from "../src/runtime/current-decision-view.ts";
import type { AgentLoopToolEvidence } from "../src/runtime/contracts.ts";

test("artifact repair tracks delivery milestones rather than changing file hashes, tool IDs, or error text", () => {
  const policy = { ...runtimeStepToolProgressPolicy(["artifact_path", "artifact_non_empty", "artifact_acceptance"]),
    artifactDeliveryRequired: true, expectedArtifactKind: "presentation", expectedArtifactFormat: "pptx" };
  const monitor = new ArtifactRepairProgress();
  const evidence: AgentLoopToolEvidence[] = [];
  const observe = (item: AgentLoopToolEvidence) => {
    evidence.push(item);
    return monitor.observe({ policy, toolEffect: name => name === "observe" ? "read" : "write", latestEvidence: [item],
      view: deriveCurrentDecisionView({ runId: "repair", evidence: deriveRuntimeStepEvidenceState({ policy, evidence }), toolEvidence: evidence }) });
  };
  for (let n = 0; n < 23; n += 1) {
    assert.equal(observe({ toolCallId: `author-${n}`, toolName: "computer_write_file", isError: false,
      result: JSON.stringify({ path: `parts/${n}.json`, bytes: 30, sha256: n.toString(16).padStart(64, "0") }) }), undefined,
    "Multi-part authoring without a failed mutation must not spend a repair window");
  }
  for (let n = 1; n <= 10; n += 1) {
    const checkpoint = observe(n % 3 === 1
      ? { toolCallId: `failed-${n}`, toolName: "computer_run_command", isError: true, operationStatus: "failed", result: `Different error ${n}` }
      : { toolCallId: `changed-${n}`, toolName: "computer_patch_file", isError: false,
        result: JSON.stringify({ path: `variants/source-${n}.cjs`, after: { bytes: 500 + n, sha256: n.toString(16).padStart(64, "0") } }) });
    assert.equal(checkpoint?.turnsWithoutDeliveryProgress, n);
    assert.equal(checkpoint?.warning, n >= 6);
    assert.equal(checkpoint?.assessmentRequired, n >= 10);
  }
  const produced = observe({ toolCallId: "produced", toolName: "computer_write_file", isError: false,
    result: JSON.stringify({ path: "deck.pptx", bytes: 1000, sha256: "a".repeat(64), artifactKind: "presentation" }) });
  assert.equal(produced, undefined, "A real deliverable advances the episode, unlike process files");
  // A failed write followed by reads still consumes the local repair window.
  assert.equal(observe({ toolCallId: "failed-verification", toolName: "verify", isError: true, result: "invalid" })?.turnsWithoutDeliveryProgress, 1);
  assert.equal(observe({ toolCallId: "read", toolName: "observe", isError: false, result: "read existing source" })?.turnsWithoutDeliveryProgress, 2);
  assert.equal(observe({ toolCallId: "accepted", toolName: "verify_artifact_acceptance", isError: false,
    result: JSON.stringify({ schema: "agentloop.artifactAcceptance/v1", verdict: "accepted",
      artifact: { path: "deck.pptx", bytes: 1000, sha256: "a".repeat(64), kind: "presentation" },
      evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty", "artifact_acceptance"], caveated: [], failed: [] },
      checks: [{ id: "package-openable", status: "passed" }] }) }), undefined);
  assert.equal(observe({ toolCallId: "irrelevant-failure", toolName: "build-probe", isError: true, result: "auxiliary failure" }), undefined,
    "An accepted delivery follows the normal completion path, without an incomplete checkpoint candidate");
});

test("changing repair operations exhausts the local window through Assessment with canonical evidence intact", async () => {
  const events: any[] = [];
  let modelTurns = 0, assessed = 0;
  const policy = { ...runtimeStepToolProgressPolicy(["artifact_path", "artifact_non_empty", "artifact_acceptance"]),
    artifactDeliveryRequired: true, expectedArtifactKind: "presentation", expectedArtifactFormat: "pptx" };
  await assert.rejects(() => runAgentLoop({ runId: "repair", input: "Produce the deck.", systemPrompt: "Build a deck.", maxSteps: 64,
    deferFailureReport: true, progressPolicy: policy,
    grant: { actorUserId: "user", runId: "repair", depth: 0, allowedToolNames: new Set(["build", "patch"]),
      allowedSkillIds: new Set(), visibleDirectories: [], uploadedSources: [], skillExecutionRoots: [] },
    tools: new ToolRegistry([
      { name: "build", effect: "write", description: "Build", inputSchema: { type: "object" }, executionMode: "exclusive", replaySafe: false,
        parse: value => value, execute: async () => { throw new AppError("BAD_REQUEST", `syntax error ${modelTurns}`, 400); } },
      { name: "patch", effect: "write", description: "Patch", inputSchema: { type: "object" }, executionMode: "exclusive", replaySafe: false,
        parse: value => value, execute: async () => ({ path: "source.json", before: { sha256: "a".repeat(64) }, after: { bytes: 200 + modelTurns, sha256: modelTurns.toString(16).padStart(64, "0") } }) },
    ]),
    model: { limits: TEST_MODEL_LIMITS, complete: async request => {
      modelTurns += 1;
      assert.equal(request.tools.length, 2, "The checkpoint must not narrow authorization");
      if (modelTurns > 6) assert.match(request.runtimeContext?.content ?? "", /local repair turns without new delivery evidence/);
      return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `operation-${modelTurns}`, name: modelTurns % 3 === 1 ? "build" : "patch", arguments: { revision: modelTurns } }] };
    } },
    evaluateCandidate: async context => {
      assessed += 1;
      assert.equal(context.toolEvidence.length, 10);
      assert.equal(context.toolEvidence[0]!.toolCallId, "operation-1");
      assert.match(context.output, /not yet complete/);
      return { approved: false, feedback: "The requested artifact remains missing; reuse the source and change the construction plan.",
        failedBoundary: { stepId: "build-deck", missingEvidenceKinds: ["artifact_path", "artifact_acceptance"],
          violatedSkillRequirements: [], reusableEvidenceRefs: ["operation-2"], suggestedRepairShape: "repair_leaf" } };
    }, emit: event => { events.push(event); },
  }), error => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "STEP_NOT_COMPLETED");
    assert.equal(error.details?.reason, "artifact_repair_no_progress");
    assert.equal(error.details?.repairExhausted, true);
    assert.equal((error.details?.failedBoundary as any).stepId, "build-deck");
    return true;
  });
  assert.equal(modelTurns, 10);
  assert.equal(assessed, 1);
  assert.equal(events.some(event => event.type === "loop.limit_exceeded"), false);
  assert.equal(events.filter(event => event.type === "loop.artifact_repair_checkpoint").length, 5);
});

test("a successful retry of the failed executable advances repair once; unrelated success and repeated toggles do not", () => {
  const policy = { ...runtimeStepToolProgressPolicy(["artifact_path", "artifact_acceptance"]), artifactDeliveryRequired: true,
    expectedArtifactKind: "presentation", expectedArtifactFormat: "pptx" };
  const monitor = new ArtifactRepairProgress();
  const evidence: AgentLoopToolEvidence[] = [];
  const run = (id: string, script: string, ok: boolean) => {
    const item = { toolCallId: id, toolName: "computer_run_command", isError: !ok,
      result: JSON.stringify({ exitCode: ok ? 0 : 1, executionReceipt: { schema: "agentloop.commandExecutionReceipt/v1", startState: "started", completionState: "exited" } }) };
    evidence.push(item);
    return monitor.observe({ policy, latestEvidence: [item], toolEffect: () => "write",
      toolCall: () => ({ id, name: item.toolName, arguments: { command: "node", args: [script], cwd: "." } }),
      view: deriveCurrentDecisionView({ runId: "retry", evidence: deriveRuntimeStepEvidenceState({ policy, evidence }), toolEvidence: evidence }) });
  };
  assert.equal(run("failed", "assemble.cjs", false)?.turnsWithoutDeliveryProgress, 1);
  assert.equal(run("unrelated", "print-diagnostics.cjs", true)?.turnsWithoutDeliveryProgress, 2);
  assert.equal(run("recovered", "assemble.cjs", true), undefined);
  assert.equal(run("failed-again", "assemble.cjs", false)?.turnsWithoutDeliveryProgress, 1);
  assert.equal(run("same-transition", "assemble.cjs", true)?.turnsWithoutDeliveryProgress, 2,
    "Alternating a known failure and success cannot manufacture unlimited repair progress");
});

test("stale patch recovery binds current content, supports a reviewed repair, and stays stale after another edit", async t => {
  const root = await mkdtemp(join(tmpdir(), "patch-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executor = new ComputerExecutor(root, { fileRevisionScope: "run-recovery" });
  const original = await executor.writeFile("source.cjs", "before\nneedle\nafter\n", "create");
  await writeFile(join(root, "source.cjs"), "new header\nbefore\nneedle\nafter\n");
  let recovery: any;
  await assert.rejects(() => executor.patchFile({ path: "source.cjs", baseRevisionId: original.revisionId!,
    hunks: [{ startLine: 2, expectedLines: ["needle"], replacementLines: ["fixed"] }] }), error => {
    assert.ok(error instanceof AppError);
    recovery = error.details?.patchRecovery;
    assert.equal(recovery.schema, "agentloop.patchRecovery/v1");
    assert.equal(recovery.path, "source.cjs");
    assert.deepEqual(recovery.hunks[0].candidateStartLines, [3]);
    assert.match(recovery.hunks[0].ranges[0].content, /new header/);
    assert.match(recovery.current.revisionId, /^rev_/);
    return true;
  });
  const fixed = await executor.patchFile({ path: "source.cjs", baseRevisionId: recovery.current.revisionId,
    hunks: [{ match: "unique", expectedLines: ["needle"], replacementLines: ["fixed"] }] });
  assert.notEqual(fixed.revisionId, recovery.current.revisionId);
  assert.equal(await readFile(join(root, "source.cjs"), "utf8"), "new header\nbefore\nfixed\nafter\n");
  await assert.rejects(() => executor.patchFile({ path: "source.cjs", baseRevisionId: recovery.current.revisionId,
    hunks: [{ match: "unique", expectedLines: ["fixed"], replacementLines: ["wrong"] }] }),
  error => error instanceof AppError && error.details?.failureKind === "patch_revision_stale");
});

test("failed patch recovery survives the real loop transcript and next model decision", async t => {
  const root = await mkdtemp(join(tmpdir(), "patch-loop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executor = new ComputerExecutor(root, { fileRevisionScope: "run-recovery" });
  const original = await executor.writeFile("source.cjs", "header\nneedle\n", "create");
  let turn = 0, failedEvent: any;
  const result = await runAgentLoop({ runId: "run-recovery", systemPrompt: "Repair the source.", input: "Repair needle.",
    grant: { actorUserId: "user", runId: "run-recovery", depth: 0, allowedToolNames: new Set(["computer_patch_file"]),
      allowedSkillIds: new Set(), visibleDirectories: [], uploadedSources: [], skillExecutionRoots: [] },
    tools: new ToolRegistry([{ name: "computer_patch_file", description: "Patch a file", inputSchema: { type: "object" },
      parse: value => value as Parameters<ComputerExecutor["patchFile"]>[0], execute: async (_context, value) => executor.patchFile(value) }]),
    maxSteps: 4,
    emit: event => { if (event.type === "tool.failed") failedEvent = event; },
    model: { limits: TEST_MODEL_LIMITS, complete: async request => {
      turn += 1;
      if (turn === 3) return { content: "Source repaired.", finishReason: "stop", toolCalls: [] };
      const recovery = turn === 2 ? JSON.parse(request.messages.filter(message => message.role === "tool").at(-1)!.content!).patchRecovery : undefined;
      if (recovery) assert.deepEqual(recovery.hunks[0].candidateStartLines, [2]);
      return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `patch-${turn}`, name: "computer_patch_file",
        arguments: { path: "source.cjs", baseRevisionId: recovery?.current.revisionId ?? original.revisionId,
          hunks: [turn === 1 ? { startLine: 1, expectedLines: ["needle"], replacementLines: ["fixed"] }
            : { match: "unique", expectedLines: ["needle"], replacementLines: ["fixed"] }] } }] };
    } },
  });
  assert.equal(result.output, "Source repaired.");
  assert.equal(JSON.parse(failedEvent.data.error).patchRecovery.schema, "agentloop.patchRecovery/v1");
  assert.equal(await readFile(join(root, "source.cjs"), "utf8"), "header\nfixed\n");
});

test("bounded patch recovery prioritizes the failed hunk after the first four hunks", async t => {
  const root = await mkdtemp(join(tmpdir(), "patch-recovery-hunks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executor = new ComputerExecutor(root, { fileRevisionScope: "run-recovery" });
  const source = await executor.writeFile("source.txt", "one\ntwo\nthree\nfour\nactual\n", "create");
  await assert.rejects(() => executor.patchFile({ path: "source.txt", baseRevisionId: source.revisionId!,
    hunks: ["one", "two", "three", "four", "wrong"].map((line, index) => ({
      startLine: index + 1, expectedLines: [line], replacementLines: [line.toUpperCase()],
    })) }), error => {
    assert.ok(error instanceof AppError);
    const recovery = error.details?.patchRecovery as any;
    assert.equal(recovery.hunks.length, 4);
    assert.equal(recovery.hunks[0].hunkIndex, 4);
    assert.match(recovery.hunks[0].ranges[0].content, /actual/);
    assert.equal(recovery.hunksTruncated, true);
    return true;
  });
  assert.equal(await readFile(join(root, "source.txt"), "utf8"), "one\ntwo\nthree\nfour\nactual\n");
});

test("generation and in-place transformation retain operation results without creating calculation rerun obligations", async t => {
  const root = await mkdtemp(join(tmpdir(), "command-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executor = new ComputerExecutor(root, { executableAliases: { "trusted-node": process.execPath } });
  const policy = runtimeStepToolProgressPolicy(["source_summary"]);
  await executor.writeFile("generate.cjs", `require('fs').writeFileSync('spec.json','{"value":1}');console.log(JSON.stringify({schema:'agentloop.commandComputation/v1',inputRefs:[],facts:{created:true}}));`, "create");
  const generation = await executor.runCommand({ command: "trusted-node", args: ["generate.cjs"], cwd: ".", timeoutMs: 2000 });
  assert.equal(generation.exitCode, 0);
  assert.ok(generation.fileChanges.some(change => change.path === "spec.json" && change.changeType === "created"));
  assert.equal(generation.computationReceipt, undefined);
  assert.deepEqual(generation.computationEvidenceFailure, { kind: "missing_inputs", remedy: "repair_command_contract" });
  const state = (result: unknown) => deriveRuntimeStepEvidenceState({ policy,
    evidence: [{ toolCallId: "operation", toolName: "computer_run_command", isError: false, result: JSON.stringify(result) }] })!;
  assert.equal(state(generation).pendingComputation, undefined);
  assert.equal(state(generation).nextAction, "repair_command_contract");
  assert.match(state(generation).instruction, /do not blindly repeat/i);
  assert.ok(state(generation).missingToolEvidenceKinds.includes("source_summary"), "Rejected computation cannot satisfy the evidence requirement");
  await assert.rejects(() => executor.runCommand({ command: "trusted-node", args: ["generate.cjs"], cwd: ".", timeoutMs: 2000,
    computationInputs: [{ path: "generate.cjs" }] }), /executable entrypoint is not a computation data input/);
  await executor.writeFile("transform.cjs", "require('fs').writeFileSync('spec.json','{\"value\":2}');console.log('transformed');", "create");
  const transformed = await executor.runCommand({ command: "trusted-node", args: ["transform.cjs"], cwd: ".", timeoutMs: 2000,
    computationInputs: [{ path: "spec.json" }] });
  assert.equal(transformed.exitCode, 0);
  assert.equal(transformed.computationEvidenceFailure?.kind, "input_changed");
  assert.equal(transformed.computationReceipt, undefined);
  assert.equal(state(transformed).pendingComputation, undefined);
  assert.equal(await readFile(join(root, "spec.json"), "utf8"), '{"value":2}');
  const corrected = await executor.runCommand({ command: "trusted-node", args: ["transform.cjs"], cwd: ".", timeoutMs: 2000 });
  assert.equal(corrected.computationEvidenceError, undefined);
  assert.equal(corrected.computationReceipt, undefined);
  await executor.writeFile("compute.cjs", `const value=JSON.parse(require('fs').readFileSync('spec.json')).value;console.log(JSON.stringify({schema:'agentloop.commandComputation/v1',inputRefs:[{path:'spec.json'}],facts:{double:value*2}}));`, "create");
  const computed = await executor.runCommand({ command: "trusted-node", args: ["compute.cjs"], cwd: ".", timeoutMs: 2000,
    computationInputs: [{ path: "spec.json" }] });
  assert.deepEqual(computed.computationReceipt?.facts, { double: 4 });
  assert.equal(computed.computationEvidenceError, undefined);
});
