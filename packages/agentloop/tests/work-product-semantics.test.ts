import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deriveWorkProductObservations, type WorkProductToolEvent } from "../src/runtime/work-product-observations.ts";
import { deriveWorkProductSemantics, workProductDeclarationFromContent, type WorkProductDeclarationEvent } from "../src/runtime/work-product-semantics.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/work-product/b.json", import.meta.url), "utf8"));
const facts = deriveWorkProductObservations(fixture);
const goalId = "goal";
const version = (path: string) => facts.objects.find((object) => object.path === path)!.currentVersionId!;
const role = (path: string, value: string) => ({ kind: "role", path, versionId: version(path), role: value });
const issue = () => ({ kind: "issue", issueId: "generator-api", path: "generator.cjs", versionId: version("generator.cjs"),
  symptom: "generator failed", diagnosis: "API shape option mismatch", evidenceToolCallIds: [fixture.events[3].evidence.toolCallId],
  attemptedToolCallIds: [fixture.events[3].evidence.toolCallId], pendingActions: ["patch generator and rerun"], claimedStatus: "open" });
function declaration(step: number, updates: unknown[]): WorkProductDeclarationEvent {
  return workProductDeclarationFromContent({ runId: fixture.runId, workspaceId: fixture.workspaceId, goalId,
    modelStep: step, throughSeq: facts.throughSeq, content: `<work_product_progress>${JSON.stringify({ updates })}</work_product_progress>` })!;
}
const derive = (declarations: WorkProductDeclarationEvent[]) => deriveWorkProductSemantics({ facts, goalId, declarations });

test("stage 2: old events remain readable; no declaration means unknown, not filename-based purpose", () => {
  const state = derive([]);
  assert.ok(state.roles.every((item) => item.role === "unknown"));
  assert.deepEqual(state.issues, []);
  assert.equal(state.roles.find((item) => item.path === "test_fill.pptx")?.role, "unknown");
});

test("explicit generator/experiment purposes and diagnosis survive without changing file facts", () => {
  const before = JSON.stringify(facts);
  const events = [declaration(1, [role("generator.cjs", "generator"), role("test_fill.pptx", "experiment"), issue()])];
  const state = derive(events);
  assert.deepEqual(state, derive(events));
  assert.deepEqual(state, derive([...events, ...events]));
  assert.equal(state.roles.find((item) => item.path === "test_fill.pptx")?.role, "experiment");
  assert.equal(state.issues[0].claimedStatus, "open");
  assert.equal(state.issues[0].resolutionSupport, "none");
  assert.deepEqual(state.issues[0].pendingActions, ["patch generator and rerun"]);
  assert.equal(state.issues[0].source.authority, "model");
  assert.equal(JSON.stringify(facts), before);
});

test("same-format candidate and experiment require explicit declarations and stay distinct", () => {
  const another: WorkProductToolEvent = { ...fixture.events.at(-1), seq: 1300, evidence: {
    toolCallId: "new-target", toolName: "computer_run_command", isError: false,
    result: JSON.stringify({ exitCode: 0, fileChanges: [{ path: "target.pptx", changeType: "created", bytes: 50 }] }),
  } };
  const newer = deriveWorkProductObservations({ ...fixture, events: [...fixture.events, another] });
  const state = deriveWorkProductSemantics({ facts: newer, goalId, declarations: [{ ...declaration(1, [
    role("test_fill.pptx", "experiment"), { kind: "role", path: "target.pptx", role: "candidate", versionId: newer.objects.at(-1)!.currentVersionId },
  ]), throughSeq: 1300 }] });
  assert.deepEqual(state.roles.filter((item) => item.path.endsWith(".pptx")).map((item) => item.role), ["experiment", "candidate"]);
  assert.equal("delivered" in state, false);
});

test("an admitted delivery target binds one observed artifact version, never a same-format neighbour", () => {
  const boundFacts = deriveWorkProductObservations({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    events: [{ runId: fixture.runId, workspaceId: fixture.workspaceId, seq: 1, evidence: {
      toolCallId: "write-report", toolName: "computer_write_file", operationStatus: "succeeded", isError: false,
      result: JSON.stringify({ path: "report.md", mode: "create", bytes: 12, sha256: "a".repeat(64) }),
    } }],
  });
  const artifact = boundFacts.objects[0]!;
  const target = { targetId: "analysis-report", purpose: "ODS analysis report", kind: "document", format: "markdown" };
  const deliveryDeclaration = workProductDeclarationFromContent({ runId: fixture.runId, workspaceId: fixture.workspaceId, goalId,
    modelStep: 1, throughSeq: 1, content: `<work_product_progress>${JSON.stringify({ updates: [{
    kind: "delivery_target", targetId: target.targetId, path: artifact.path, versionId: artifact.currentVersionId,
  }] })}</work_product_progress>` })!;
  const state = deriveWorkProductSemantics({ facts: boundFacts, goalId, deliveryTargets: [target], declarations: [deliveryDeclaration] });
  assert.deepEqual(state.deliveryTargets?.map((binding) => ({ targetId: binding.targetId, path: binding.path, sha256: binding.sha256 })), [{
    targetId: "analysis-report", path: artifact.path, sha256: artifact.versions.find((version) => version.id === artifact.currentVersionId)!.sha256,
  }]);
  const wrongDeclaration = { ...deliveryDeclaration, payload: { updates: [{
    kind: "delivery_target", targetId: "sample-report", path: artifact.path, versionId: artifact.currentVersionId,
  }] } };
  const wrong = deriveWorkProductSemantics({ facts: boundFacts, goalId, deliveryTargets: [target], declarations: [wrongDeclaration] });
  assert.equal(wrong.rejected[0]?.reason, "unknown_delivery_target");
});

test("a single compatible committed receipt binds its admitted target without model progress prose", () => {
  const sha256 = "c".repeat(64);
  const boundFacts = deriveWorkProductObservations({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    events: [{ runId: fixture.runId, workspaceId: fixture.workspaceId, seq: 1, evidence: {
      toolCallId: "write-report", toolName: "computer_write_file", operationStatus: "succeeded", isError: false,
      result: JSON.stringify({
        path: "results/analysis.md", mode: "create", bytes: 12, sha256,
        artifactReceipt: { schema: "agentloop.artifactReceipt/v1", artifact: { path: "results/analysis.md", bytes: 12, sha256 } },
      }),
    } }],
  });
  const target = { targetId: "analysis-report", purpose: "ODS analysis report", kind: "document", format: "markdown" };
  const state = deriveWorkProductSemantics({ facts: boundFacts, goalId, deliveryTargets: [target], declarations: [] });

  assert.deepEqual(state.deliveryTargets?.map((binding) => ({
    targetId: binding.targetId,
    path: binding.path,
    sha256: binding.sha256,
    observedByToolCallId: binding.observedByToolCallId,
    bindingAuthority: binding.bindingAuthority,
  })), [{
    targetId: "analysis-report",
    path: "results/analysis.md",
    sha256,
    observedByToolCallId: "write-report",
    bindingAuthority: "runtime",
  }]);
});

test("a unique hash-identified command output binds its compatible target without binding its sibling target", () => {
  const sha256 = "9".repeat(64);
  const boundFacts = deriveWorkProductObservations({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    events: [{ runId: fixture.runId, workspaceId: fixture.workspaceId, seq: 1, evidence: {
      toolCallId: "build-standard", toolName: "computer_run_command", operationStatus: "succeeded", isError: false,
      result: JSON.stringify({
        exitCode: 0,
        fileChangesTruncated: false,
        fileChanges: [{ path: "results/ingestion-standard.xlsx", changeType: "created", bytes: 42, sha256 }],
      }),
    } }],
  });
  const state = deriveWorkProductSemantics({
    facts: boundFacts,
    goalId,
    declarations: [],
    deliveryTargets: [
      { targetId: "ddm-report", purpose: "DDM modeling report", kind: "document", format: "markdown" },
      { targetId: "ingestion-standard", purpose: "Ingestion standard", kind: "spreadsheet", format: "xlsx" },
    ],
  });

  assert.deepEqual(state.deliveryTargets?.map((binding) => ({
    targetId: binding.targetId,
    path: binding.path,
    sha256: binding.sha256,
    bindingAuthority: binding.bindingAuthority,
  })), [{
    targetId: "ingestion-standard",
    path: "results/ingestion-standard.xlsx",
    sha256,
    bindingAuthority: "runtime",
  }]);
});

test("same-format receipts remain unbound when Runtime cannot identify one delivery target", () => {
  const report = (toolCallId: string, path: string, sha256: string): WorkProductToolEvent => ({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    seq: toolCallId === "write-a" ? 1 : 2,
    evidence: {
      toolCallId,
      toolName: "computer_write_file",
      operationStatus: "succeeded",
      isError: false,
      result: JSON.stringify({
        path,
        mode: "create",
        bytes: 12,
        sha256,
        artifactReceipt: { schema: "agentloop.artifactReceipt/v1", artifact: { path, bytes: 12, sha256 } },
      }),
    },
  });
  const boundFacts = deriveWorkProductObservations({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    events: [report("write-a", "results/draft.md", "d".repeat(64)), report("write-b", "results/final.md", "e".repeat(64))],
  });
  const target = { targetId: "analysis-report", purpose: "ODS analysis report", kind: "document", format: "markdown" };
  const state = deriveWorkProductSemantics({ facts: boundFacts, goalId, deliveryTargets: [target], declarations: [] });

  assert.deepEqual(state.deliveryTargets, []);
});

test("a receipt-selected admitted target binds the final artifact while same-format support files remain unbound", () => {
  const report = (toolCallId: string, path: string, sha256: string, deliveryTargetId?: string): WorkProductToolEvent => ({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    seq: toolCallId === "write-sample" ? 1 : 2,
    evidence: {
      toolCallId,
      toolName: "computer_write_file",
      operationStatus: "succeeded",
      isError: false,
      result: JSON.stringify({
        path,
        mode: "create",
        bytes: 12,
        sha256,
        ...(deliveryTargetId === undefined ? {} : { deliveryTargetId }),
        artifactReceipt: { schema: "agentloop.artifactReceipt/v1", artifact: { path, bytes: 12, sha256 } },
      }),
    },
  });
  const boundFacts = deriveWorkProductObservations({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    events: [
      report("write-sample", "results/sample-report.md", "d".repeat(64)),
      report("write-final", "results/validation-result.md", "e".repeat(64), "validation-result"),
    ],
  });
  const target = { targetId: "validation-result", purpose: "Validation result", kind: "document", format: "markdown" };
  const state = deriveWorkProductSemantics({ facts: boundFacts, goalId, deliveryTargets: [target], declarations: [] });

  assert.deepEqual(state.deliveryTargets?.map((binding) => ({
    targetId: binding.targetId,
    path: binding.path,
    bindingAuthority: binding.bindingAuthority,
  })), [{
    targetId: "validation-result",
    path: "results/validation-result.md",
    bindingAuthority: "model",
  }]);
});

test("a replacement receipt advances the Runtime binding to the current artifact version", () => {
  const firstSha = "1".repeat(64);
  const currentSha = "2".repeat(64);
  const receipt = (toolCallId: string, seq: number, sha256: string): WorkProductToolEvent => ({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    seq,
    evidence: {
      toolCallId,
      toolName: seq === 1 ? "computer_write_file" : "computer_patch_file",
      operationStatus: "succeeded",
      isError: false,
      result: JSON.stringify({
        path: "results/analysis.md",
        mode: seq === 1 ? "create" : "overwrite",
        bytes: 12 + seq,
        sha256,
        artifactReceipt: { schema: "agentloop.artifactReceipt/v1", artifact: { path: "results/analysis.md", bytes: 12 + seq, sha256 } },
      }),
    },
  });
  const boundFacts = deriveWorkProductObservations({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    events: [receipt("write-report", 1, firstSha), receipt("patch-report", 2, currentSha)],
  });
  const target = { targetId: "analysis-report", purpose: "ODS analysis report", kind: "document", format: "markdown" };
  const state = deriveWorkProductSemantics({ facts: boundFacts, goalId, deliveryTargets: [target], declarations: [] });

  assert.deepEqual(state.deliveryTargets?.map((binding) => ({
    path: binding.path,
    sha256: binding.sha256,
    observedByToolCallId: binding.observedByToolCallId,
  })), [{
    path: "results/analysis.md",
    sha256: currentSha,
    observedByToolCallId: "patch-report",
  }]);
});

test("artifact acceptance checks do not replace the version-defining delivery observation", () => {
  const sha256 = "b".repeat(64);
  const checkedFacts = deriveWorkProductObservations({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    events: [
      { runId: fixture.runId, workspaceId: fixture.workspaceId, seq: 1, evidence: {
        toolCallId: "write-report", toolName: "computer_write_file", operationStatus: "succeeded", isError: false,
        result: JSON.stringify({ path: "report.md", mode: "create", bytes: 12, sha256 }),
      } },
      { runId: fixture.runId, workspaceId: fixture.workspaceId, seq: 2, evidence: {
        toolCallId: "verify-report", toolName: "verify_artifact_acceptance", operationStatus: "succeeded", isError: false,
        result: JSON.stringify({
          schema: "agentloop.artifactAcceptance/v1",
          artifact: { path: "report.md", bytes: 12, sha256 },
          verdict: "accepted",
          checks: [{ id: "artifact_path", status: "passed" }],
        }),
      } },
    ],
  });
  const artifact = checkedFacts.objects[0]!;
  const target = { targetId: "analysis-report", purpose: "ODS analysis report", kind: "document", format: "markdown" };
  const deliveryDeclaration = workProductDeclarationFromContent({ runId: fixture.runId, workspaceId: fixture.workspaceId, goalId,
    modelStep: 1, throughSeq: 1, content: `<work_product_progress>${JSON.stringify({ updates: [{
    kind: "delivery_target", targetId: target.targetId, path: artifact.path, versionId: artifact.currentVersionId,
  }] })}</work_product_progress>` })!;
  const state = deriveWorkProductSemantics({ facts: checkedFacts, goalId, deliveryTargets: [target], declarations: [deliveryDeclaration] });
  assert.equal(artifact.versions[0]?.observationIds.length, 2);
  assert.equal(state.deliveryTargets?.[0]?.observedByToolCallId, "write-report");
});

test("intention to generate a missing file and unsupported delivered role are rejected locally", () => {
  const state = derive([declaration(1, [
    { kind: "role", path: "target.pptx", role: "candidate", versionId: "imagined" }, role("test_fill.pptx", "delivered"),
    role("generator.cjs", "generator"),
  ])]);
  assert.deepEqual(state.rejected.map((item) => item.reason), ["unobserved_object_version", "invalid_role"]);
  assert.equal(state.declarations.length, 1);
  assert.equal(facts.objects.some((item) => item.path === "target.pptx"), false);
});

test("purpose changes require explicit revision; unrelated earlier judgments are retained", () => {
  const first = declaration(1, [role("test_fill.pptx", "experiment"), role("generator.cjs", "generator")]);
  const original = derive([first]);
  const missingRevision = derive([first, declaration(2, [role("test_fill.pptx", "candidate")])]);
  assert.equal(missingRevision.rejected[0].reason, "explicit_revision_required");
  const state = derive([first, declaration(2, [{ ...role("test_fill.pptx", "candidate"), replaces: original.declarations[0].id }])]);
  assert.equal(state.roles.find((item) => item.path === "test_fill.pptx")?.role, "candidate");
  assert.equal(state.roles.find((item) => item.path === "generator.cjs")?.role, "generator");
  assert.equal(state.declarations.length, 3);
});

test("overwrite makes old purpose historical without silently clearing its unresolved diagnosis", () => {
  const events = [declaration(1, [role("generator.cjs", "generator"), issue()])];
  const updated = deriveWorkProductObservations({ ...fixture, events: [...fixture.events, {
    runId: fixture.runId, workspaceId: fixture.workspaceId, seq: 1300,
    evidence: { toolCallId: "patch", toolName: "computer_run_command", isError: false,
      result: JSON.stringify({ exitCode: 0, fileChanges: [{ path: "generator.cjs", changeType: "modified", bytes: 200 }] }) },
  }] });
  const state = deriveWorkProductSemantics({ facts: updated, goalId, declarations: events });
  assert.equal(state.roles.find((item) => item.path === "generator.cjs")?.role, "unknown");
  assert.equal(state.roles.find((item) => item.path === "generator.cjs")?.historicalDeclaration?.role, "generator");
  assert.equal(state.issues[0].applicability, "historical");
  assert.equal(state.issues[0].claimedStatus, "open");
});

test("diagnosis, unsuccessful attempts, and a resolved claim are separate from verified support", () => {
  const first = declaration(1, [issue()]);
  const prior = derive([first]).declarations[0];
  const state = derive([first, declaration(2, [{ ...issue(), claimedStatus: "resolved", replaces: prior.id,
    resolutionToolCallIds: [fixture.events[3].evidence.toolCallId] }])]);
  assert.equal(state.issues[0].claimedStatus, "resolved");
  assert.equal(state.issues[0].resolutionSupport, "none");
  const successful = derive([declaration(1, [{ ...issue(), claimedStatus: "resolved",
    resolutionToolCallIds: [fixture.events[5].evidence.toolCallId] }])]);
  assert.equal(successful.issues[0].resolutionSupport, "successful_operation", "success is supporting evidence, not semantic proof of repair");
});

test("wrong goal/run/workspace and forward references cannot publish declarations", () => {
  const event = declaration(1, [issue()]);
  assert.equal(derive([{ ...event, goalId: "other" }, { ...event, runId: "other" }, { ...event, workspaceId: "other" }]).declarations.length, 0);
  assert.equal(derive([{ ...event, throughSeq: 1 }]).rejected[0].reason, "unobserved_object_version");
  assert.equal(derive([declaration(1, [{ ...issue(), evidenceToolCallIds: ["invented"] }])]).rejected[0].reason, "unknown_evidence_ref");
});

test("resolution can cite current version-scoped checks but not checks on a different object", () => {
  const checked = deriveWorkProductObservations({ ...fixture, events: [...fixture.events, {
    runId: fixture.runId, workspaceId: fixture.workspaceId, seq: 1300,
    evidence: { toolCallId: "checked-generator", toolName: "verify_artifact_acceptance", isError: false, operationStatus: "succeeded",
      result: JSON.stringify({ schema: "agentloop.artifactAcceptance/v1", artifact: { path: "generator.cjs", bytes: 25959, sha256: "a".repeat(64) },
        checks: [{ id: "syntax", status: "passed" }] }) },
  }] });
  const valid = { ...issue(), versionId: checked.objects.find((object) => object.path === "generator.cjs")!.currentVersionId,
    claimedStatus: "resolved", resolutionToolCallIds: ["checked-generator"] };
  const event = { ...declaration(1, [valid]), throughSeq: 1300 };
  const state = deriveWorkProductSemantics({ facts: checked, goalId, declarations: [event] });
  assert.equal(state.issues[0].resolutionSupport, "version_scoped_check");
  const wrongObject = { ...declaration(1, [{ ...valid, path: "test_fill.pptx", versionId: version("test_fill.pptx") }]), throughSeq: 1300 };
  assert.equal(deriveWorkProductSemantics({ facts: checked, goalId, declarations: [wrongObject] }).issues[0].resolutionSupport, "successful_operation");
});

test("malformed optional block is an explicit rejection, not an exception or fabricated declaration", () => {
  for (const content of ['<work_product_progress>{bad}</work_product_progress>', '<work_product_progress>unfinished']) {
    const event = workProductDeclarationFromContent({ runId: fixture.runId, workspaceId: fixture.workspaceId, goalId,
      modelStep: 1, throughSeq: facts.throughSeq, content })!;
    assert.equal(derive([event]).rejected[0].reason, "invalid_updates");
  }
  assert.equal(workProductDeclarationFromContent({ runId: fixture.runId, workspaceId: fixture.workspaceId, goalId,
    modelStep: 1, throughSeq: facts.throughSeq, content: "普通进展说明" }), undefined);
});
