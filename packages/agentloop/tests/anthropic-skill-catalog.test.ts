import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { discoverSkillDirectory } from "../src/skills/skill-directory.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "agentloop-skills");
const EXPECTED_SKILLS = [
  "algorithmic-art",
  "brand-guidelines",
  "canvas-design",
  "frontend-design",
  "internal-comms",
  "mcp-builder",
  "skill-creator",
  "slack-gif-creator",
  "theme-factory",
  "web-artifacts-builder",
  "webapp-testing",
] as const;

test("the standard Anthropic Skill packages are discoverable without source locks", async () => {
  const catalog = await discoverSkillDirectory(resolve(ROOT, "skills"));
  const anthropic = catalog
    .filter((entry) => EXPECTED_SKILLS.includes(entry.inspection.name as typeof EXPECTED_SKILLS[number]))
    .sort((left, right) => left.inspection.name.localeCompare(right.inspection.name, "en"));
  assert.deepEqual(anthropic.map((entry) => entry.inspection.name), [...EXPECTED_SKILLS]);

  for (const entry of anthropic) {
    assert.equal(entry.sourceUrl, undefined);
    assert.equal(entry.sourceRevision, undefined);
    assert.ok(entry.inspection.packageHash.length === 64);
  }
});
