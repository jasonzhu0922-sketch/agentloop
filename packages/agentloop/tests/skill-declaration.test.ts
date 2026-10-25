import assert from "node:assert/strict";
import test from "node:test";
import {
  declarationFromLegacyMetadata,
  detectSkillDeclaration,
  parseSkillDeclarationJson,
  projectSkillAgentLoopMetadata,
  serializeSkillDeclaration,
} from "../src/index.ts";

test("skill declaration sidecars round-trip without putting planning metadata in SKILL.md", () => {
  const declaration = detectSkillDeclaration("contract-review", "Review contract documents.", "Review a document and report risks.", ["SKILL.md", "scripts/check.py"]);
  const parsed = parseSkillDeclarationJson(serializeSkillDeclaration(declaration));
  assert.deepEqual(parsed, declaration);
  assert.deepEqual(projectSkillAgentLoopMetadata(parsed), {
    roles: ["support"],
    artifactKinds: ["document", "code"],
    sourceKinds: [],
    qaKinds: [],
    semanticTags: ["contract", "review"],
    intentExamples: ["Review contract documents."],
  });
});

test("legacy frontmatter is converted to a declaration with compatibility projection", () => {
  const declaration = declarationFromLegacyMetadata("source", "Read an API.", {
    roles: ["source_provider"],
    artifactKinds: ["none"],
    sourceKinds: ["api"],
    qaKinds: [],
    executionProfiles: ["local_script"],
    producesEvidenceKinds: ["source_summary"],
  });
  assert.deepEqual(projectSkillAgentLoopMetadata(declaration).executionProfiles, ["local_script"]);
  assert.deepEqual(projectSkillAgentLoopMetadata(declaration).producesEvidenceKinds, ["source_summary"]);
});

test("declaration identity and workflow values fail closed", () => {
  assert.throws(() => parseSkillDeclarationJson(JSON.stringify({
    schema: "agentloop.skillDeclaration/v1",
    identity: { name: "Not Safe", description: "x" },
    activation: { semanticTags: [], intentExamples: [] },
    workflow: { roles: ["primary_builder"], artifactKinds: ["none"], sourceKinds: [], qaKinds: [], requiredSkills: [] },
  })), /skill_declaration_identity_name_invalid/);
});
