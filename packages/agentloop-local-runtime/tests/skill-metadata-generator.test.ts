import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSkillPackageEvidence, evidenceLocations } from "../src/service/skill-package-evidence.ts";
import { generateSkillMetadata } from "@zhujun/agentloop-local-runtime";
import type { ModelAdapter, SkillPackageInspection } from "@zhujun/agentloop";

function inspection(overrides: Partial<SkillPackageInspection> = {}): SkillPackageInspection {
  return {
    root: "/tmp/skill",
    entrypointPath: "SKILL.md",
    instructions: "Create a document report from an input dataset.",
    name: "report-builder",
    description: "Build a document report.",
    packageHash: "a".repeat(64),
    fileCount: 1,
    totalBytes: 64,
    files: ["SKILL.md"],
    ...overrides,
  };
}

function model(content: string): ModelAdapter {
  return {
    limits: { contextWindowTokens: 4_096, maxOutputTokens: 2_048 },
    completeTimeoutMs: 10_000,
    operationTimeoutMs: 10_000,
    reasoningVisibility: "hidden",
    async complete() {
      return { content, toolCalls: [], finishReason: "stop" };
    },
  } as ModelAdapter;
}

test("metadata generation uses a model only when package metadata is absent", async () => {
  let calls = 0;
  const result = await generateSkillMetadata(inspection(), {
    async orderedModelKeys() { return ["local:test-model"]; },
    createModel() { calls += 1; return model(JSON.stringify({
      schema: "agentloop.skillDeclaration/v1",
      identity: { name: "report-builder", description: "Build a document report." },
      activation: { semanticTags: ["report"], intentExamples: ["Create a report"] },
      workflow: { roles: ["primary_builder"], artifactKinds: ["document"], sourceKinds: ["dataset"], qaKinds: [], requiredSkills: [] },
    })); },
  });
  assert.equal(calls, 1);
  assert.equal(result.generationMethod, "deterministic+model");
  assert.equal(result.modelKey, "local:test-model");
  assert.deepEqual(result.declaration.workflow.roles, ["primary_builder"]);
});

test("metadata generation preserves a package declaration and does not call a model", async () => {
  let calls = 0;
  const declaration = {
    schema: "agentloop.skillDeclaration/v1" as const,
    identity: { name: "report-builder", description: "Build a document report." },
    activation: { semanticTags: [], intentExamples: [] },
    workflow: { roles: ["support" as const], artifactKinds: ["none" as const], sourceKinds: [], qaKinds: [], requiredSkills: [] },
  };
  const result = await generateSkillMetadata(inspection({ declaration, declarationSource: "package" }), {
    async orderedModelKeys() { return ["local:test-model"]; },
    createModel() { calls += 1; return model("{}"); },
  });
  assert.equal(calls, 0);
  assert.equal(result.generationMethod, "none");
  assert.deepEqual(result.declaration, declaration);
});

test("metadata generation falls back when every model returns invalid metadata", async () => {
  const result = await generateSkillMetadata(inspection(), {
    async orderedModelKeys() { return ["local:one", "cloud:two"]; },
    createModel() { return model("not-json"); },
  });
  assert.equal(result.generationStatus, "failed");
  assert.equal(result.generationMethod, "deterministic");
  assert.deepEqual(result.attemptedModelKeys, ["local:one", "cloud:two"]);
  assert.deepEqual(result.declaration.workflow.roles, ["support"]);
});

const suggested = {
  schema: "agentloop.skillDeclaration/v1",
  identity: { name: "report-builder", description: "Build a document report." },
  activation: { semanticTags: ["report"], intentExamples: ["Create a report"] },
  workflow: { roles: ["primary_builder"], artifactKinds: ["document"], sourceKinds: ["dataset"], qaKinds: [], requiredSkills: [] },
};

test("configured order is preserved across provider and validation failures and stops at the first valid result", async () => {
  const calls: string[] = [];
  const result = await generateSkillMetadata(inspection(), {
    async orderedModelKeys() { return ["local:z-unavailable", "local:y-invalid", "local:b-ready", "local:a-unused"]; },
    createModel(key) {
      calls.push(key);
      if (key === "local:z-unavailable") throw new Error("provider failure with secret-token");
      return model(JSON.stringify(key === "local:y-invalid" ? { ...suggested, workflow: { ...suggested.workflow, roles: ["unknown-role"] } } : suggested));
    },
  });
  assert.deepEqual(calls, ["local:z-unavailable", "local:y-invalid", "local:b-ready"]);
  assert.deepEqual(result.attemptedModelKeys, calls);
  assert.equal(result.modelKey, "local:b-ready"); assert.equal(result.generationStatus, "completed");
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
});

test("model suggestions cannot invent identity, execution, evidence producers or installer requirements", async () => {
  for (const files of [["SKILL.md"], ["SKILL.md", "agentloop.executors.json"]]) {
    const result = await generateSkillMetadata(inspection({ files }), {
      async orderedModelKeys() { return ["local:metadata"]; },
      createModel() { return model(JSON.stringify({ ...suggested,
        identity: { name: "injected", description: "injected" },
        execution: { manifest: "injected.json" },
        compatibility: { executionProfiles: ["local_script"], producesEvidenceKinds: ["source_summary"] },
        requirements: { python: { packages: ["invented-installable-package"], files: [] }, commands: ["injected"], environment: [], mcpServers: [] },
      })); },
    });
    assert.equal(result.generationStatus, "completed");
    assert.deepEqual(result.declaration.identity, suggested.identity);
    assert.deepEqual(result.declaration.execution, files.length > 1 ? { manifest: "agentloop.executors.json" } : undefined);
    assert.equal(result.declaration.compatibility, undefined); assert.equal(result.declaration.requirements, undefined);
  }
});

test("legacy declarations and their explicit requirements are preserved without even querying the model catalog", async () => {
  const declaration = { ...suggested,
    workflow: { ...suggested.workflow, roles: ["primary_builder" as const], artifactKinds: ["document" as const], sourceKinds: ["dataset" as const] },
    requirements: { python: { packages: ["requests>=2"], files: [] }, commands: [], environment: [], mcpServers: [] },
  };
  const result = await generateSkillMetadata(inspection({ declaration: { ...declaration, schema: "agentloop.skillDeclaration/v1" }, declarationSource: "legacy-frontmatter" }), {
    async orderedModelKeys() { assert.fail("package declarations must bypass model discovery"); },
    createModel() { assert.fail("package declarations must bypass model creation"); },
  });
  assert.equal(result.generationMethod, "legacy-projection"); assert.equal(result.generationStatus, "not-needed");
  assert.deepEqual(result.declaration, declaration);
});

test("missing or unavailable model catalogs retain usable basic metadata and never persist provider errors", async () => {
  for (const invoker of [undefined, { async orderedModelKeys() { return []; }, createModel() { assert.fail(); } }]) {
    const result = await generateSkillMetadata(inspection(), invoker);
    assert.equal(result.generationStatus, "fallback"); assert.equal(result.generationMethod, "deterministic");
  }
  const result = await generateSkillMetadata(inspection(), {
    async orderedModelKeys() { throw new Error("secret-token"); }, createModel() { assert.fail(); },
  });
  assert.equal(result.generationStatus, "failed"); assert.equal(result.generationError, "skill_metadata_model_catalog_unavailable");
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  const failed = await generateSkillMetadata(inspection(), {
    async orderedModelKeys() { return ["local:broken"]; }, createModel() { throw new Error("secret-token"); },
  });
  assert.equal(failed.generationError, "skill_metadata_model_failed");
  assert.equal(JSON.stringify(failed).includes("secret-token"), false);
});

test("recognition follows package references and grounds dependencies in the cited lines without storing their contents", async t => {
  const root = await mkdtemp(join(tmpdir(), "skill-recognition-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "references")); await mkdir(join(root, "scripts"));
  const instructions = "Read [setup](references/setup.md) and run `scripts/run.py`. Optional requirements-extra.txt is not needed.";
  await writeFile(join(root, "references/setup.md"), "Use node for the command.\nSet REPORT_API_URL.\nConnect MCP acceptance-source.\n");
  await writeFile(join(root, "scripts/run.py"), "print('observed package script')\n");
  await writeFile(join(root, "requirements.txt"), "requests>=2\n");
  await writeFile(join(root, "requirements-extra.txt"), "optional-extra\n");
  let input: any;
  const adapter = model(""); adapter.complete = async request => {
    input = JSON.parse(request.messages[0]!.content as string);
    return { content: JSON.stringify({ ...suggested,
      requirements: { commands: ["node", "invented"], environment: ["REPORT_API_URL", "REPORT_API", "OTHER_SECRET"], mcpServers: ["acceptance-source", "acceptance"] },
      fieldEvidence: { "requirements.commands": ["references/setup.md:1"], "requirements.environment": ["references/setup.md:2"],
        "requirements.mcpServers": ["references/setup.md:3"], "workflow.roles": ["scripts/run.py:1"] },
    }), toolCalls: [], finishReason: "stop" };
  };
  const result = await generateSkillMetadata(inspection({ root, instructions, files: ["SKILL.md", "references/setup.md", "scripts/run.py", "requirements.txt", "requirements-extra.txt"] }), {
    async orderedModelKeys() { return ["local:evidence"]; }, createModel() { return adapter; },
  });
  assert.ok(input.sourceEvidence.some((doc: any) => doc.path === "references/setup.md" && doc.content.includes("REPORT_API_URL")));
  assert.ok(input.sourceEvidence.some((doc: any) => doc.path === "scripts/run.py"));
  assert.deepEqual(result.declaration.requirements, { python: { packages: [], files: ["requirements.txt"] }, commands: ["node"], environment: ["REPORT_API_URL"], mcpServers: ["acceptance-source"] });
  assert.deepEqual(result.declaration.compatibility?.executionProfiles, ["local_script"]);
  assert.deepEqual(result.fields["workflow.roles"]!.evidence, ["scripts/run.py:1"]);
  assert.ok(result.packageEvidence!.documents.every(doc => !("content" in doc) && /^[a-f0-9]{64}$/.test(doc.sha256)));
  assert.equal(JSON.stringify(result).includes("observed package script"), false);
});

test("reference collection stays inside the package, excludes private and binary files, and validates source line ranges", async t => {
  const root = await mkdtemp(join(tmpdir(), "skill-evidence-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "references"));
  await writeFile(join(root, "references/child.md"), "[nested](next.md)\n");
  await writeFile(join(root, "references/next.md"), "nested source\n");
  await writeFile(join(root, ".env"), "PRIVATE_SECRET=not-for-model\n");
  await writeFile(join(root, "binary.txt"), Buffer.from([0, 1, 2]));
  await symlink("/etc/hosts", join(root, "outside.txt"));
  const evidence = await collectSkillPackageEvidence(inspection({ root, instructions: "[child](references/child.md) .env binary.txt outside.txt https://example.test/no-fetch", files: ["SKILL.md", "references/child.md", "references/next.md", ".env", "binary.txt", "outside.txt"] }));
  assert.deepEqual(evidence.documents.map(doc => doc.path), ["SKILL.md", "references/child.md", "references/next.md"]);
  assert.deepEqual(evidence.omitted, [{ path: ".env", reason: "private" }, { path: "binary.txt", reason: "binary" }, { path: "outside.txt", reason: "unreadable" }]);
  assert.deepEqual(evidenceLocations(["references/next.md:1", "references/next.md:100", "references/next.md:2-1", "missing.md", "../outside"], evidence), ["references/next.md:1"]);
});
