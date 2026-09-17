import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deriveWorkProductObservations, normalizeWorkProductObservations, type WorkProductToolEvent } from "../src/runtime/work-product-observations.ts";

const scope = { runId: "run", workspaceId: "workspace" };
const h1 = "a".repeat(64);
const h2 = "b".repeat(64);
function event(seq: number, result: unknown, toolName = "computer_run_command", extra = {}): WorkProductToolEvent {
  return { ...scope, seq, evidence: { toolCallId: `call-${seq}`, toolName, isError: false,
    result: JSON.stringify(result), ...extra } };
}
function changes(seq: number, changeType: string, extra = {}) {
  return event(seq, { exitCode: 0, fileChanges: [{ path: "output.bin", changeType, ...extra }] });
}
function check(seq: number, sha256: string | undefined = h1, path = "output.bin") {
  return event(seq, { schema: "agentloop.artifactAcceptance/v1", artifact: { path, bytes: 10, sha256 },
    verdict: "accepted", checks: [{ id: "archive_structure", status: "passed" }] }, "verify_artifact_acceptance");
}
function derive(events: WorkProductToolEvent[]) { return deriveWorkProductObservations({ ...scope, events }); }

for (const id of ["a", "b"]) test(`persisted fixture ${id}: reproducible factual inventory and provenance`, () => {
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/work-product/${id}.json`, import.meta.url), "utf8"));
  const state = deriveWorkProductObservations(fixture);
  assert.deepEqual(state, deriveWorkProductObservations(fixture));
  assert.deepEqual(state, deriveWorkProductObservations({ ...fixture, events: [...fixture.events].reverse() }));
  assert.deepEqual(state, deriveWorkProductObservations({ ...fixture, events: [...fixture.events, ...fixture.events] }));
  assert.equal(state.issues.length, 0);
  for (const observation of state.observations) {
    const original = fixture.events.find((entry: WorkProductToolEvent) => entry.seq === observation.source.seq);
    assert.equal(observation.source.toolCallId, original.evidence.toolCallId);
    assert.match(observation.source.resultSha256, /^[a-f\d]{64}$/);
  }
  if (id === "a") {
    const output = state.objects.find((object) => object.path === "themed.pptx")!;
    assert.equal(output.presence, "present");
    assert.equal(output.versions[0].bytes, 3429079);
    assert.equal(output.versions[0].sha256, undefined);
    assert.equal(output.checks.length, 0, "stdout is retained by ref, not invented version-scoped acceptance");
    assert.ok(state.objects.some((object) => object.path === "remap_fonts.py"));
  } else {
    assert.equal(state.objects.find((object) => object.path === "generator.js")?.presence, "deleted");
    assert.equal(state.objects.find((object) => object.path === "generator.cjs")?.presence, "present");
    assert.equal(state.objects.find((object) => object.path === "test_fill.pptx")?.versions[0].bytes, 45978);
    assert.equal(state.operations.filter((operation) => operation.status === "failed").length, 3);
    assert.equal(state.objects.filter((object) => object.path.endsWith(".pptx")).length, 1);
    assert.equal("delivered" in state, false);
  }
});

test("C: failed operation preserves reported partial side effects without claiming completeness", () => {
  const state = derive([event(1, { exitCode: 1, fileChanges: [{ path: "partial.bin", changeType: "created", bytes: 7 }] },
    "computer_run_command", { isError: true, invocationStatus: "completed", operationStatus: "failed" })]);
  assert.equal(state.objects[0].presence, "present");
  assert.equal(state.observations[0].operationStatus, "failed");
  assert.equal(state.objects[0].versions[0].sha256, undefined);
  assert.equal(state.objects[0].checks.length, 0);
  assert.equal("complete" in state.objects[0], false);
});

test("nonzero structured exit wins over a misleading completed/succeeded envelope", () => {
  const observation = normalizeWorkProductObservations(event(1, { exitCode: 2, fileChanges: [{ path: "p", changeType: "created" }] },
    "computer_run_command", { operationStatus: "succeeded" }));
  assert.equal(observation.operation.status, "failed");
  assert.equal(observation.observations[0].operationStatus, "failed");
});

test("D: checks are historical after overwrite, delete and recreation, even at the same path", () => {
  const events = [changes(1, "created", { bytes: 10, sha256: h1 }), check(2)];
  assert.equal(derive(events).objects[0].checks[0].binding, "current");
  events.push(changes(3, "modified", { bytes: 10, sha256: h2 }));
  let object = derive(events).objects[0];
  assert.equal(object.checks[0].binding, "historical");
  assert.equal(object.versions.length, 2);
  events.push(changes(4, "deleted"));
  object = derive(events).objects[0];
  assert.equal(object.presence, "deleted");
  assert.equal(object.versions.at(-1)?.sha256, undefined);
  events.push(changes(5, "created", { bytes: 10, sha256: h1 }));
  object = derive(events).objects[0];
  assert.equal(object.presence, "present");
  assert.equal(object.checks[0].binding, "historical", "a new incarnation needs its own contextual checks");
  assert.equal(object.versions.length, 4);
});

test("hashless overwrite invalidates old check; hashless check never attaches to prior version", () => {
  const state = derive([changes(1, "created", { sha256: h1 }), check(2), changes(3, "modified", { bytes: 10 }),
    event(4, { schema: "agentloop.artifactAcceptance/v1", artifact: { path: "output.bin", bytes: 10 },
      checks: [{ id: "structure", status: "passed" }] }, "verify_artifact_acceptance")]);
  assert.deepEqual(state.objects[0].checks.map((item) => item.binding), ["historical", "unknown"]);
});

test("checks never apply to another path with the same content hash", () => {
  const state = derive([changes(1, "created", { sha256: h1 }), check(2, h1, "different.bin")]);
  assert.equal(state.objects.find((object) => object.path === "output.bin")?.checks.length, 0);
});

test("failed acceptance preserves file metadata and individual check scope, not a global success", () => {
  const original = check(1);
  const input: WorkProductToolEvent = { ...original, evidence: { ...original.evidence, isError: true, operationStatus: "failed",
    result: JSON.stringify({ schema: "agentloop.artifactAcceptance/v1", artifact: { path: "output.bin", sha256: h1, bytes: 10 },
      verdict: "rejected", checks: [{ id: "archive_structure", status: "passed" }, { id: "visual", status: "failed" }] }) } };
  const state = derive([input]);
  assert.equal(state.objects[0].presence, "present");
  assert.deepEqual(state.objects[0].checks.map(({ id, status, binding }) => ({ id, status, binding })), [
    { id: "archive_structure", status: "passed", binding: "current" }, { id: "visual", status: "failed", binding: "current" },
  ]);
});

test("E: full history survives many unrelated results without growing a display window", () => {
  const state = derive([changes(1, "created", { bytes: 10 }), ...Array.from({ length: 200 }, (_, i) =>
    event(i + 2, { exitCode: 0, stdout: "irrelevant", fileChanges: [] }))]);
  assert.equal(state.objects[0].presence, "present");
  assert.equal(state.observations.length, 1);
  assert.equal(state.throughSeq, 201);
});

test("F: ordinary answers and source-summary references create no fictional file obligations", () => {
  assert.deepEqual(derive([]).objects, []);
  const source = derive([event(1, { schema: "agentloop.sourceSummary/v1", sourceRefs: ["https://example.test/source"],
    summary: "write result.pptx later" }, "read_source")]);
  assert.deepEqual(source.objects, []);
});

test("same-event duplicate is idempotent, but separate writes of identical content are distinct versions", () => {
  const first = changes(1, "created", { bytes: 10, sha256: h1 });
  assert.deepEqual(derive([first, first]), derive([first]));
  const state = derive([first, changes(2, "modified", { bytes: 10, sha256: h1 })]);
  assert.equal(state.objects[0].versions.length, 2);
});

test("same-seq conflicting evidence retains both observations with unknown current state", () => {
  const a = changes(1, "created", { sha256: h1 });
  const b = changes(1, "deleted");
  const state = derive([a, b]);
  assert.deepEqual(state, derive([b, a]));
  assert.equal(state.observations.length, 2);
  assert.equal(state.objects[0].presence, "unknown");
  assert.equal(state.objects[0].currentVersionId, undefined);
  assert.ok(state.issues.some((issue) => issue.code === "conflicting_event"));
});

test("scope excludes other Runs and workspaces; object identity includes workspace", () => {
  const first = changes(1, "created");
  assert.deepEqual(derive([first, { ...changes(2, "deleted"), runId: "other" },
    { ...changes(3, "deleted"), workspaceId: "other" }]), derive([first]));
  const other = deriveWorkProductObservations({ ...scope, workspaceId: "other", events: [{ ...first, workspaceId: "other" }] });
  assert.notEqual(other.objects[0].id, derive([first]).objects[0].id);
});

test("truncated fileChanges are partial observations, never evidence of absence", () => {
  const state = derive([changes(1, "created"), event(2, { exitCode: 0, fileChanges: [], fileChangesTruncated: true })]);
  assert.equal(state.objects[0].presence, "present");
  assert.ok(state.issues.some((issue) => issue.code === "incomplete_file_changes"));
});

test("path normalization joins aliases but does not escape the workspace or infer files from stdout", () => {
  const state = derive([event(1, { exitCode: 0, stdout: 'Created ghost.pptx; All validations PASSED!', fileChanges: [
    { path: "./out/../output.bin", changeType: "created" },
    { path: "../../escape", changeType: "created" }, { path: "/absolute", changeType: "created" },
  ] }), changes(2, "deleted")]);
  assert.equal(state.objects.length, 1);
  assert.equal(state.objects[0].path, "output.bin");
  assert.equal(state.objects[0].presence, "deleted");
  assert.equal(state.issues.filter((issue) => issue.code === "invalid_path").length, 2);
});

test("patch uses after metadata, not the before hash or another nested artifact's bytes", () => {
  const state = derive([event(1, { schema: "agentloop.filePatch/v1", path: "output.bin", before: { bytes: 10, sha256: h1 },
    after: { bytes: 20, sha256: h2 } }, "computer_patch_file")]);
  assert.equal(state.observations[0].sha256, h2);
  assert.equal(state.observations[0].bytes, 20);
});

test("an unrelated root path cannot override nested receipt path and metadata", () => {
  const state = derive([event(1, { path: "input.txt", bytes: 999, artifactReceipt: {
    schema: "agentloop.artifactReceipt/v1", artifact: { path: "output.bin", bytes: 10, sha256: h1 },
  } }, "convert_artifact")]);
  assert.equal(state.objects.length, 1);
  assert.equal(state.objects[0].path, "output.bin");
  assert.equal(state.objects[0].versions[0].bytes, 10);
});

test("untrusted receipts are references only and cannot publish Runtime checks", () => {
  const input = check(1);
  const state = derive([{ ...input, evidence: { ...input.evidence, toolName: "external_lookup" } }]);
  assert.equal(state.objects[0].presence, "unknown");
  assert.equal(state.objects[0].checks.length, 0);
  assert.equal(state.objects[0].versions.length, 0);
});

test("invalid metadata and malformed JSON remain explicit; input is not mutated", () => {
  const input = event(1, { exitCode: 0, fileChanges: [{ path: "output.bin", changeType: "created", bytes: -1, sha256: "not-a-hash" }] });
  const before = JSON.stringify(input);
  const state = derive([input]);
  assert.equal(JSON.stringify(input), before);
  assert.equal(state.observations[0].bytes, undefined);
  assert.equal(state.observations[0].sha256, undefined);
  assert.equal(state.issues[0].code, "invalid_metadata");
  assert.equal(normalizeWorkProductObservations({ ...input, evidence: { ...input.evidence, result: '{"fileChanges":' } }).issues[0].code, "invalid_result");
});

test("references preserve original hash and location without reading content or treating it as an artifact", () => {
  const state = derive([event(1, { exitCode: 0, stdoutRef: { path: ".agentloop/tool-results/raw.txt", sha256: h1, bytes: 90000 }, stdout: "preview" })]);
  assert.deepEqual(state.operations[0].contentRefs, [{ path: ".agentloop/tool-results/raw.txt", sha256: h1, bytes: 90000 }]);
  assert.equal(state.objects.length, 0);
});

test("contradictory direct metadata and nested receipt retain conflict instead of last-writer-wins", () => {
  const state = derive([event(1, { path: "output.bin", mode: "create", bytes: 10, sha256: h1,
    artifactReceipt: { schema: "agentloop.artifactReceipt/v1", artifact: { path: "output.bin", bytes: 10, sha256: h2 } },
  }, "computer_write_file")]);
  assert.equal(state.objects[0].presence, "unknown");
  assert.equal(state.objects[0].currentVersionId, undefined);
  assert.equal(state.observations.length, 2);
  assert.equal(state.issues[0].code, "conflicting_observations");
});

test("matching direct write and receipt describe one version, and checks keep their own scopes", () => {
  const state = derive([event(1, { path: "output.bin", mode: "create", bytes: 10, sha256: h1,
    artifactReceipt: { schema: "agentloop.artifactReceipt/v1", artifact: { path: "output.bin", bytes: 10, sha256: h1 } },
  }, "computer_write_file"), check(2)]);
  assert.equal(state.objects[0].versions.length, 1);
  assert.equal(state.objects[0].versions[0].observationIds.length, 3);
  assert.equal(state.objects[0].checks[0].id, "archive_structure");
  assert.equal(state.objects[0].checks[0].binding, "current");
});

test("valid JSON arrays from search tools are not malformed receipts or file observations", () => {
  const normalized = normalizeWorkProductObservations(event(1, [{ path: "mentioned.txt", text: "search hit" }], "computer_search_text"));
  assert.deepEqual(normalized.issues, []);
  assert.deepEqual(normalized.observations, []);
});

test("stage 3 keeps observation interpretation out of hard completion gates and public exports", () => {
  for (const path of ["../src/index.ts", "../src/runtime/tool-progress-policy.ts", "../src/planning/assessor.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), "utf8"), /work-product-observations/);
  }
});
