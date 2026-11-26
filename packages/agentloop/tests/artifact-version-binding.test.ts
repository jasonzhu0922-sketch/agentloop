import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveWorkProductObservations, type WorkProductToolEvent } from "../src/runtime/work-product-observations.ts";
import { deriveWorkProductSemantics, workProductDeclarationFromContent } from "../src/runtime/work-product-semantics.ts";
import { WorkProductContext } from "../src/runtime/work-product-context.ts";
import { createCanonicalRunState, reconcileCanonicalDeliveryTargetBindings, recordCanonicalAssessment, acceptedCanonicalDelivery, markCanonicalReadyForTerminal, type CanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { buildRuntimeDeliveryCandidate, deliveryClaimsForCurrentTargetBindings } from "../src/runtime/delivery-candidate.ts";
import { collectProcessArtifacts, readProcessArtifact } from "../src/runtime/process-artifacts.ts";
import { deriveCurrentDecisionView } from "../src/runtime/current-decision-view.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { artifactStepToolProgressPolicy } from "../src/runtime/tool-progress-policy.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import type { RuntimeEvent } from "../src/runtime/contracts.ts";
import type { StoredRunEvent } from "../src/runtime/run-service.ts";
import { TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

const runId = "version-contract", workspaceId = "workspace", goalId = "goal";
const target = { targetId: "report", purpose: "Complete report and attachments", kind: "document", format: "markdown" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function command(seq: number, files: string[], options: { targetId?: string; sha?: string; failed?: boolean; bind?: boolean; change?: string } = {}): WorkProductToolEvent {
  return { runId, workspaceId, seq, evidence: { toolCallId: `write-${seq}`, toolName: "computer_run_command", isError: false,
    result: JSON.stringify({ exitCode: options.failed ? 2 : 0, fileChanges: files.map(path => ({ path,
      changeType: options.change ?? "created", bytes: 12, sha256: options.sha ?? hash(`${seq}:${path}`) })),
      ...(options.bind === false ? {} : { outputBindings: files.map(path => ({ targetId: options.targetId ?? "report", path })) }) }) } };
}
function acceptance(seq: number, file: string, sha256: string): WorkProductToolEvent {
  return { runId, workspaceId, seq, evidence: { toolCallId: `verify-${seq}`, toolName: "verify_artifact_acceptance", isError: false,
    result: JSON.stringify({ schema: "agentloop.artifactAcceptance/v1", verdict: "accepted", artifact: { path: file, bytes: 12, sha256 }, checks: [{ id: "openable", status: "passed" }] }) } };
}
function derive(events: readonly WorkProductToolEvent[], targets = [target]) {
  const observations = deriveWorkProductObservations({ runId, workspaceId, events });
  return { observations, semantics: deriveWorkProductSemantics({ facts: observations, goalId, declarations: [], deliveryTargets: targets }), admittedDeliveryTargets: targets };
}
function canonical(expectedCount = 1): CanonicalRunState {
  const base = createCanonicalRunState({ runId, userInput: target.purpose, understanding: {} as any, now: 1 });
  return { ...base, targets: { report: { ...target, surface: "workspace_artifact", expectedCount, terminalRequired: true, status: "open", ownerStepIds: ["produce"], claims: [] } },
    steps: { produce: { stepId: "produce", targetIds: ["report"], status: "running", evidenceRefs: [], updatedAt: 1 } } };
}
function reconcile(state: CanonicalRunState, events: readonly WorkProductToolEvent[]) {
  const facts = derive(events);
  return reconcileCanonicalDeliveryTargetBindings(state, { stepId: "produce", bindings: facts.semantics.deliveryTargets!, observations: facts.observations,
    selectedTargetIds: facts.semantics.deliverySelections?.map(selection => selection.targetId), now: events.length + 1 });
}
function assessed(state: CanonicalRunState, events: readonly WorkProductToolEvent[], targets = [target]) {
  const facts = derive(events, targets);
  const candidate = buildRuntimeDeliveryCandidate({ output: "Report complete", toolEvidence: events.map(event => event.evidence), deliveryTargets: Object.values(state.targets),
    artifactBindings: facts.semantics.deliveryTargets, artifactTargets: targets, artifactObservations: facts.observations });
  return recordCanonicalAssessment(state, { id: `assessment-${events.length}`, stepId: "produce", approved: true,
    criteria: [{ criterionId: "delivery_target:report", targetId: "report", satisfied: true, rationale: "Content reviewed", evidenceRefs: [] }] } as any,
    { candidateOutput: candidate.output, deliveryCandidate: candidate, toolCalls: events.map(event => event.evidence), modelSteps: 1 }, 10);
}

test("real Report Run: first semantic loss is v2; latest v3 remains selected and every historical file is retained", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/work-product/report-version-binding.json", import.meta.url), "utf8"));
  const deliveryTargets = [{ targetId: "banned-supplier-report-docx", purpose: "Report", kind: "document", format: "docx" }];
  for (const [seq, suffix] of [[105, ".docx"], [135, ".docx"], [164, ".docx"], [190, "-v2.docx"], [219, "-v3.docx"], [239, "-v3.docx"]] as const) {
    const facts = deriveWorkProductObservations({ ...fixture, events: fixture.events.filter((event: WorkProductToolEvent) => event.seq <= seq) });
    const semantics = deriveWorkProductSemantics({ facts, goalId, declarations: [], deliveryTargets });
    assert.deepEqual(semantics.deliveryTargets?.map(binding => binding.path), [`reports/banned-supplier-5651-202610${suffix}`]);
    if (seq >= 219) assert.equal(facts.objects.length, 54);
  }
});

test("acceptance of original cannot complete v2 or v3; failed calls, reads and old acceptance never select a version", () => {
  const original = command(1, ["z-v99.md"]), v2 = command(3, ["a.md"]), v3 = command(6, ["final.md"]);
  const events = [original, acceptance(2, "z-v99.md", hash("1:z-v99.md"))];
  const accepted = assessed(reconcile(canonical(), events), events);
  assert.ok(acceptedCanonicalDelivery(accepted.targets.report));
  const replaced = reconcile(accepted, [...events, v2]);
  assert.equal(replaced.targets.report.status, "open");
  assert.equal(assessed(replaced, [...events, v2]).targets.report.status, "open");
  events.push(v2, command(4, ["failed.md"], { failed: true }), acceptance(5, "z-v99.md", hash("1:z-v99.md")), v3);
  events.push({ runId, workspaceId, seq: 7, evidence: { toolCallId: "read-original", toolName: "computer_read_json", isError: false,
    result: JSON.stringify({ path: "z-v99.md", sha256: hash("1:z-v99.md"), bytes: 12 }) } });
  const current = reconcile(accepted, events);
  assert.equal(current.targets.report.artifactBinding?.path, "final.md");
  assert.equal(current.targets.report.claims.length, 1, "historical acceptance remains traceable");
  assert.equal(assessed(current, events).targets.report.status, "open");
  assert.throws(() => markCanonicalReadyForTerminal({ ...current, steps: { produce: { ...current.steps.produce, status: "satisfied" } } }), /delivery target/);
  events.push(acceptance(8, "final.md", hash("6:final.md")));
  assert.ok(acceptedCanonicalDelivery(assessed(current, events).targets.report));
});

for (const sameBytes of [false, true]) test(`same-path rewrite requires fresh version acceptance (same bytes=${sameBytes})`, () => {
  const firstHash = hash("one"), nextHash = sameBytes ? firstHash : hash("two");
  const events = [command(1, ["report.md"], { sha: firstHash }), acceptance(2, "report.md", firstHash)];
  const accepted = assessed(reconcile(canonical(), events), events);
  events.push(command(3, ["report.md"], { sha: nextHash, change: "modified" }));
  const next = reconcile(accepted, events);
  assert.notEqual(next.targets.report.artifactBinding?.versionId, accepted.targets.report.artifactBinding?.versionId);
  assert.equal(assessed(next, events).targets.report.status, "open");
  events.push(acceptance(4, "report.md", nextHash));
  assert.ok(acceptedCanonicalDelivery(assessed(next, events).targets.report));
});

for (const change of ["deleted", "modified"]) test(`invalidated newest file cannot resurrect old cross-path selection (${change})`, () => {
  const events = [command(1, ["old.md"]), command(2, ["current.md"]), command(3, ["current.md"], { bind: false, change })];
  const state = reconcile(reconcile(canonical(), events.slice(0, 1)), events);
  assert.deepEqual(derive(events).semantics.deliveryTargets, []);
  assert.equal(state.targets.report.artifactBinding, undefined, "even a stale canonical original cannot mask a lost latest version");
  const facts = derive(events);
  assert.deepEqual(deriveCurrentDecisionView({ runId, context: { canonicalState: state, stepId: "produce" }, workProducts: facts }).currentGap.unboundDeliveryTargetIds, ["report"]);
});

test("logical target owns an atomic multi-file set; every member must pass, replacement and deletion affect the whole set", () => {
  const paths = ["report.md", "attachment-a.md", "attachment-b.md"];
  const events = [command(1, paths)];
  const bindings = derive(events).semantics.deliveryTargets!;
  assert.equal(bindings.length, 3);
  events.push(...paths.slice(0, 2).map((path, index) => acceptance(index + 2, path, hash(`1:${path}`))));
  const state = reconcile(canonical(), events);
  assert.equal(assessed(state, events).targets.report.status, "open", "one missing attachment acceptance blocks the target");
  events.push(acceptance(4, paths[2], hash(`1:${paths[2]}`)));
  const accepted = assessed(state, events);
  assert.equal(accepted.targets.report.artifactBindings?.length, 3);
  assert.equal(acceptedCanonicalDelivery(accepted.targets.report)?.artifacts?.length, 3);
  assert.equal(deriveCurrentDecisionView({ runId, workProducts: derive(events) }).workProducts.deliveryTargets.length, 3);
  events.push(command(5, ["replacement.md", "appendix.md"]));
  assert.deepEqual(derive(events).semantics.deliveryTargets?.map(binding => binding.path), ["replacement.md", "appendix.md"]);
  events.push(command(6, ["appendix.md"], { change: "deleted", bind: false }));
  assert.deepEqual(derive(events).semantics.deliveryTargets, []);
  assert.equal(reconcile(accepted, events).targets.report.status, "open");
});

test("partially observed explicit set is invalidated as a set, never silently shrunk", () => {
  const event = command(2, ["main.md"]);
  const result = JSON.parse(event.evidence.result);
  result.outputBindings.push({ targetId: "report", path: "missing.md" });
  const broken = { ...event, evidence: { ...event.evidence, result: JSON.stringify(result) } };
  assert.deepEqual(derive([command(1, ["old.md"]), broken]).semantics.deliveryTargets, []);
});

test("multiple logical slots and targets do not cover one another or lower explicit cardinality/format", () => {
  const targets = [1, 2, 3].map(index => ({ ...target, targetId: `report.${index}`, deliveryTargetId: "report" }));
  const events = [command(1, ["one.md", "attachment.md"], { targetId: "report.1" }), command(2, ["two.md"], { targetId: "report.2" }),
    command(3, ["wrong.pdf"], { targetId: "report.3" })];
  assert.equal(derive(events, targets).semantics.deliveryTargets!.length, 3, "wrong format does not fulfill slot 3");
  events.push(command(4, ["three.md"], { targetId: "report.3" }));
  const all = derive(events, targets).semantics.deliveryTargets!;
  events.push(...all.map((binding, index) => acceptance(index + 5, binding.path, binding.sha256)));
  const claims = deliveryClaimsForCurrentTargetBindings(all, events.map(event => event.evidence), targets);
  assert.equal(claims[0]?.artifacts?.length, 4);
  assert.deepEqual(deliveryClaimsForCurrentTargetBindings(all.filter(binding => binding.targetId !== "report.3"), events.map(event => event.evidence), targets), []);
  const bound = reconcileCanonicalDeliveryTargetBindings(canonical(3), { stepId: "produce", bindings: all });
  assert.equal(assessed(bound, events, targets).targets.report.status, "accepted");
  const insufficient = reconcileCanonicalDeliveryTargetBindings(canonical(4), { stepId: "produce", bindings: all });
  assert.equal(assessed(insufficient, events, targets).targets.report.status, "open", "four physical files cannot masquerade as four required logical instances");
  const other = { ...target, targetId: "other" };
  const later = [...events, command(10, ["other.md"], { targetId: "other" }), command(11, ["new-one.md"], { targetId: "report.1" })];
  assert.deepEqual(derive(later, [...targets, other]).semantics.deliveryTargets?.map(binding => binding.path), ["new-one.md", "two.md", "three.md", "other.md"]);
});

test("commit acknowledgement and recovery replay use the identical current binding and version identities", () => {
  const storeSnapshot = async () => ({ kind: "content_addressed" as const, path: "snapshot.json", sha256: hash("snapshot"), bytes: 8, characters: 8, format: "json" as const });
  const create = () => new WorkProductContext(runId, { workspaceId, goalId, goal: target.purpose, deliveryTargets: [target], storeSnapshot });
  const live = create(), committed: RuntimeEvent[] = [];
  for (const input of [command(1, ["old.md"]), command(2, ["main.md", "attachment.md"]), acceptance(3, "old.md", hash("1:old.md"))]) {
    const event: RuntimeEvent = { type: "tool.completed", data: { ...input.evidence } };
    const previous = live.derive();
    const prepared = live.prepare(event);
    assert.deepEqual(live.derive(), previous, "uncommitted results do not select a version");
    live.capture(prepared); committed.push(prepared);
  }
  const recovered = create();
  for (const event of committed) recovered.capture(event);
  assert.deepEqual(recovered.derive(), live.derive());
  assert.deepEqual(recovered.derive().semantics.deliveryTargets?.map(binding => binding.path), ["main.md", "attachment.md"]);
});

test("unbound observed files can be verified and selected as a bundle without changing Plan targets", async () => {
  const paths = ["report.md", "attachment-a.md", "attachment-b.md"];
  const initial = command(1, paths, { bind: false });
  const initialEvent: RuntimeEvent = { type: "tool.completed", data: { ...initial.evidence } };
  const storeSnapshot = async () => ({ kind: "content_addressed" as const, path: "snapshot.json", sha256: hash("x"), bytes: 1, characters: 1, format: "json" as const });
  const mirror = new WorkProductContext(runId, { goalId, workspaceId, goal: target.purpose, deliveryTargets: [target], storeSnapshot });
  mirror.capture(initialEvent);
  const members = mirror.derive().observations.objects.map(object => ({ path: object.path, versionId: object.currentVersionId! }));
  let turns = 0, verified = 0;
  const events: RuntimeEvent[] = [];
  await runAgentLoop({ runId, input: target.purpose, systemPrompt: "Use observed files", maxSteps: 6,
    initialWorkProductEvents: [initialEvent], initialToolEvidence: [initial.evidence],
    workProductContext: { goalId, workspaceId, goal: target.purpose, deliveryTargets: [target], storeSnapshot },
    deliveryTargets: Object.values(canonical().targets),
    progressPolicy: artifactStepToolProgressPolicy(["artifact_path", "artifact_non_empty", "artifact_acceptance"], { artifactTargets: [{ id: "report", kind: "document", format: "markdown" }] }),
    grant: createCapabilityGrant({ runId, depth: 0, allowedToolNames: ["verify_artifact_acceptance", "noop"], allowedSkillIds: [] }),
    tools: new ToolRegistry([
      { name: "verify_artifact_acceptance", description: "Inspect file", inputSchema: { type: "object" }, parse: input => input as { artifactPath: string },
        execute: async (_, input) => { verified++; return JSON.parse(acceptance(10 + verified, input.artifactPath, hash(`1:${input.artifactPath}`)).evidence.result); } },
      { name: "noop", description: "Commit selection", inputSchema: { type: "object" }, parse: input => input, execute: async () => ({ ok: true }) },
    ]),
    model: { limits: TEST_MODEL_LIMITS, complete: async () => {
      turns++;
      if (turns <= paths.length) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `manual-${turns}`, name: "verify_artifact_acceptance", arguments: { artifactPath: paths[turns - 1] } }] };
      if (turns === paths.length + 1) {
        assert.equal(mirror.derive().semantics.deliveryTargets?.length, 0, "physical verification does not establish target purpose");
        return { content: `<work_product_progress>${JSON.stringify({ updates: [{ kind: "delivery_target", targetId: "report", ...members[0], artifacts: members }] })}</work_product_progress>`,
          finishReason: "tool_calls", toolCalls: [{ id: "declare", name: "noop", arguments: {} }] };
      }
      return { content: "Report and both attachments are ready.", finishReason: "stop", toolCalls: [] };
    } },
    evaluateCandidate: async input => { assert.equal(input.deliveryCandidate?.deliveryClaims[0]?.artifacts?.length, 3); return { approved: true, feedback: "Content assessed" }; },
    emit: event => { events.push(event); mirror.capture(event); },
  });
  assert.equal(verified, 3);
  assert.equal(events.some(event => event.type === "tool.rejected"), false);
  assert.equal(mirror.derive().admittedDeliveryTargets?.length, 1);
});

test("download projection commits every bundle member and revokes the bundle when one current file changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-bundle-download-"));
  try {
    const paths = ["report.md", "appendix.md", "details.md"];
    for (const path of paths) await writeFile(join(root, path), "hello world!");
    const events = [command(1, paths, { sha: hash("hello world!") })];
    events.push(...paths.map((path, index) => acceptance(index + 2, path, hash("hello world!"))));
    const accepted = assessed(reconcile(canonical(), events), events);
    const complete: CanonicalRunState = { ...accepted, terminal: { status: "completed", reasonCode: "assessed", committedAt: 20 } };
    const stored = events.map(event => ({ seq: event.seq, type: "tool.completed", data: { ...event.evidence }, createdAt: event.seq })) as unknown as StoredRunEvent[];
    const collect = () => collectProcessArtifacts({ runId, workspaceRoot: root, runCreatedAt: 0, events: stored, canonicalState: complete });
    const artifacts = await collect();
    assert.equal(artifacts.filter(artifact => artifact.role === "final").length, 3);
    for (const artifact of artifacts) assert.equal((await readProcessArtifact({ artifact, workspaceRoot: root })).toString(), "hello world!");
    await writeFile(join(root, paths[1]), "changed");
    await assert.rejects(readProcessArtifact({ artifact: artifacts.find(artifact => artifact.path === paths[1])!, workspaceRoot: root }), /version changed/);
    assert.equal((await collect()).some(artifact => artifact.role === "final"), false, "partial current bundles are never presented as committed delivery");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("automatic verifier does not reuse same-path same-hash acceptance from an older incarnation", async () => {
  const sha = hash("unchanged bytes");
  const initial = [command(1, ["report.md"], { sha }), acceptance(2, "report.md", sha)];
  let turns = 0, verifications = 0;
  const emitted: RuntimeEvent[] = [];
  await runAgentLoop({ runId, input: "Revise the report", systemPrompt: "Use current artifact", maxSteps: 3,
    initialWorkProductEvents: initial.map(event => ({ type: "tool.completed", data: { ...event.evidence } })), initialToolEvidence: initial.map(event => event.evidence),
    deliveryTargets: Object.values(canonical().targets),
    workProductContext: { goalId, workspaceId, goal: target.purpose, deliveryTargets: [target], storeSnapshot: async () => ({ kind: "content_addressed", path: "snapshot.json", sha256: hash("x"), bytes: 1, characters: 1, format: "json" }) },
    progressPolicy: artifactStepToolProgressPolicy(["artifact_path", "artifact_non_empty", "artifact_acceptance"], { artifactTargets: [{ id: "report", kind: "document", format: "markdown" }] }),
    grant: createCapabilityGrant({ runId, depth: 0, allowedToolNames: ["computer_run_command", "verify_artifact_acceptance"], allowedSkillIds: [] }),
    tools: new ToolRegistry([
      { name: "computer_run_command", description: "Rewrite report", inputSchema: { type: "object" }, parse: input => input,
        execute: async () => JSON.parse(command(3, ["report.md"], { sha, change: "modified" }).evidence.result) },
      { name: "verify_artifact_acceptance", description: "Inspect current report", inputSchema: { type: "object" }, parse: input => input,
        execute: async () => { verifications++; return JSON.parse(acceptance(4, "report.md", sha).evidence.result); } },
    ]),
    model: { limits: TEST_MODEL_LIMITS, complete: async () => ++turns === 1
      ? { content: "", finishReason: "tool_calls", toolCalls: [{ id: "write-new", name: "computer_run_command", arguments: {} }] }
      : { content: "Current report is ready.", finishReason: "stop", toolCalls: [] } },
    evaluateCandidate: async input => { assert.ok(input.deliveryCandidate?.deliveryClaims[0]?.artifact); return { approved: true, feedback: "Content assessed" }; },
    emit: event => { emitted.push(event); },
  });
  assert.equal(verifications, 1);
  assert.equal(emitted.filter(event => event.type === "runtime.artifact_acceptance.scheduled").length, 1);
});

test("acceptance identity follows committed observations even when evidence is projected in a different order", () => {
  const sha = hash("same");
  const events = [command(1, ["report.md"], { sha }), acceptance(2, "report.md", sha), command(3, ["report.md"], { sha, change: "modified" })];
  const facts = derive(events);
  const reordered = [events[2].evidence, events[0].evidence, events[1].evidence];
  assert.deepEqual(deliveryClaimsForCurrentTargetBindings(facts.semantics.deliveryTargets!, reordered, [target], facts.observations), []);
  events.push(acceptance(4, "report.md", sha));
  const current = derive(events);
  assert.equal(deliveryClaimsForCurrentTargetBindings(current.semantics.deliveryTargets!, [events[3].evidence, ...reordered], [target], current.observations).length, 1);
});

test("replacement command may retain unchanged attachments through Runtime output identities", () => {
  const paths = ["report.md", "attachment.md"];
  const events = [command(1, paths)];
  events.push(...paths.map((path, index) => acceptance(index + 2, path, hash(`1:${path}`))));
  const accepted = assessed(reconcile(canonical(), events), events);
  const next = command(4, ["report.md"], { change: "modified" });
  const result = JSON.parse(next.evidence.result);
  result.outputBindings = paths.map(path => ({ targetId: "report", path }));
  result.outputArtifacts = paths.map(path => ({ targetId: "report", path, bytes: 12, sha256: hash(`${path === "report.md" ? 4 : 1}:${path}`) }));
  events.push({ ...next, evidence: { ...next.evidence, result: JSON.stringify(result) } });
  const facts = derive(events), current = reconcile(accepted, events);
  assert.equal(facts.semantics.deliveryTargets?.length, 2);
  assert.equal(facts.semantics.deliveryTargets?.find(binding => binding.path === "attachment.md")?.versionId,
    accepted.targets.report.artifactBindings?.find(binding => binding.path === "attachment.md")?.versionId);
  assert.equal(assessed(current, events).targets.report.status, "open");
  events.push(acceptance(5, "report.md", hash("4:report.md")));
  const complete = assessed(reconcile(current, events), events);
  assert.ok(acceptedCanonicalDelivery(complete.targets.report));
  assert.equal(reconcile(complete, events), complete, "reselecting an unchanged attachment does not repeatedly invalidate the bundle");
});

test("verification of unknown-target observations creates neither target ownership nor completion claims", () => {
  const events = [command(1, ["observed.md"], { targetId: "not-admitted" }), acceptance(2, "observed.md", hash("1:observed.md"))];
  const state = canonical(), facts = derive(events);
  assert.equal(facts.observations.objects[0].checks[0].binding, "current");
  assert.deepEqual(facts.semantics.deliveryTargets, []);
  assert.equal(reconcile(state, events), state);
  assert.deepEqual(deliveryClaimsForCurrentTargetBindings([], events.map(event => event.evidence), [target], facts.observations), []);
  assert.deepEqual(Object.keys(state.targets), ["report"]);
});

test("failed rewrites revoke acceptance but never select a failed output or fall back to a historical file", () => {
  const events = [command(1, ["old.md"]), command(2, ["current.md"]), acceptance(3, "current.md", hash("2:current.md"))];
  const accepted = assessed(reconcile(canonical(), events), events);
  events.push(command(4, ["current.md"], { failed: true, change: "modified" }));
  assert.deepEqual(derive(events).semantics.deliveryTargets, []);
  const next = reconcile(accepted, events);
  assert.equal(next.targets.report.status, "open");
  assert.equal(next.targets.report.artifactBinding, undefined);
  assert.equal(next.targets.report.claims.length, 1);
});
