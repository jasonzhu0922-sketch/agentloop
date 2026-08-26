import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts";
import { formatAvailableSkills, formatLoadedSkill } from "../src/skills/skill-context.ts";
import { discoverSkillDirectory } from "../src/skills/skill-directory.ts";
import { inspectSkillPackage, removeSkillPackage } from "../src/skills/skill-package.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_DIRECTORY = resolve(ROOT, "skills");
const EXPECTED_SKILL_NAMES = [
  "algorithmic-art",
  "api-query",
  "brand-guidelines",
  "build-dashboard",
  "canvas-design",
  "docx",
  "explore-data",
  "frontend-design",
  "internal-comms",
  "mcp-builder",
  "pdf",
  "presentation-skill",
  "review-contract",
  "skill-creator",
  "slack-gif-creator",
  "statistical-analysis",
  "theme-factory",
  "web-artifacts-builder",
  "webapp-testing",
  "xlsx",
] as const;

test("every checked-in Skill package is discoverable, exact, and progressively disclosed", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-real-skills-"));
  const packageStore = join(workspace, "skill-packages");
  const database = new AppDatabase(":memory:");
  try {
    const discovered = await discoverSkillDirectory(SKILL_DIRECTORY);
    assert.deepEqual(discovered.map((entry) => entry.inspection.name), EXPECTED_SKILL_NAMES);

    for (const entry of discovered) {
      const source = await inspectSkillPackage(entry.sourceDirectory);
      assert.equal(entry.sourceDirectory, resolve(SKILL_DIRECTORY, entry.inspection.name));
      assert.deepEqual(entry.inspection, source);
      assert.equal(entry.inspection.entrypointPath, "SKILL.md");
      assert.ok(entry.inspection.fileCount > 0);
      assert.ok(entry.inspection.totalBytes > 0);
      assert.match(entry.inspection.packageHash, /^[0-9a-f]{64}$/);
      assert.ok(entry.inspection.files.includes("SKILL.md"));
    }

    const canvasDesign = discovered.find((entry) => entry.inspection.name === "canvas-design");
    assert.notEqual(canvasDesign, undefined);
    assert.match(canvasDesign!.inspection.instructions, /glyph coverage/i);
    assert.match(canvasDesign!.inspection.instructions, /\bCJK\b/);
    assert.match(canvasDesign!.inspection.instructions, /fail fast/i);
    assert.match(canvasDesign!.inspection.instructions, /tofu|missing-glyph boxes/i);

    const auth = new AuthService(database);
    const owner = await auth.register("real-skills@example.com", "real skills secure password");
    const skills = new SkillService(database, {
      packageStoreRoot: packageStore,
      skillDirectory: SKILL_DIRECTORY,
    });
    const catalog = await skills.refreshSkillDirectory();
    assert.deepEqual(catalog.map((skill) => skill.name), EXPECTED_SKILL_NAMES);

    const available = await skills.listAvailable(owner.user.id);
    assert.deepEqual(available.map((skill) => skill.name), EXPECTED_SKILL_NAMES);
    assert.equal(available.every((skill) => skill.sourceKind === "package"), true);

    const installed = await skills.resolveForConversation(owner.user.id);
    assert.deepEqual(installed.map((skill) => skill.name), EXPECTED_SKILL_NAMES);
    const catalogContext = formatAvailableSkills(installed);
    for (const skill of installed) {
      const source = discovered.find((entry) => entry.inspection.name === skill.name);
      assert.notEqual(source, undefined);
      assert.equal(skill.instructions, source?.inspection.instructions);
      assert.equal(skill.contentHash, source?.inspection.packageHash);
      assert.equal(skill.package?.packageHash, source?.inspection.packageHash);
      assert.equal(skill.package?.fileCount, source?.inspection.fileCount);
      assert.equal(skill.package?.totalBytes, source?.inspection.totalBytes);
      assert.equal(skill.package?.root, source?.sourceDirectory);
      assert.match(catalogContext, new RegExp(`<name>${skill.name}</name>`));
      assert.doesNotMatch(catalogContext, new RegExp(escapeRegExp(skill.instructions)));

      const loaded = formatLoadedSkill(skill);
      assert.match(loaded, new RegExp(escapeRegExp(skill.instructions)));
      assert.match(loaded, new RegExp(`package_sha256=\"${skill.package!.packageHash}\"`));
      assert.match(loaded, new RegExp(escapeRegExp(`Base directory for this Skill: ${skill.package!.root}`)));
    }
    await skills.assertIntegrity(installed);
  } finally {
    database.close();
    await removeSkillPackage(workspace).catch(() => undefined);
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
