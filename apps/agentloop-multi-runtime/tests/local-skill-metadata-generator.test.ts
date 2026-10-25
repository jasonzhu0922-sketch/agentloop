import assert from "node:assert/strict";
import test from "node:test";
import { generateSkillMetadata } from "../local-agent-runtime/src/service/local-skill-metadata-generator.ts";
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
