import { testOwner } from "./runtime-test-helpers.ts";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { formatAvailableSkills, formatLoadedSkill } from "../src/skills/skill-context.ts";
import { discoverSkillDirectory } from "../src/skills/skill-directory.ts";
import { inspectSkillPackage, removeSkillPackage } from "../src/skills/skill-package.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "agentloop-skills");
const SKILL_DIRECTORY = resolve(ROOT, "skills");
const CUSTOM_SKILL_DIRECTORY = resolve(import.meta.dirname, "..", "..", "..", "apps", "agentloop-app", "custom-skills");
const EXPECTED_BUILTIN_SKILL_NAMES = [
  "algorithmic-art",
  "brand-guidelines",
  "build-dashboard",
  "canvas-design",
  "docx",
  "explore-data",
  "frontend-design",
  "internal-comms",
  "mcp-builder",
  "pdf",
  "pptx",
  "presentation-skill",
  "skill-creator",
  "slack-gif-creator",
  "theme-factory",
  "web-artifacts-builder",
  "webapp-testing",
  "xlsx",
] as const;
const EXPECTED_CUSTOM_SKILL_NAMES = [
  "api-query",
  "city-carbon-ai-assessment",
  "dq-platform",
  "dq-report",
  "html-skill-effectiveness-main",
  "review-contract",
  "statistical-analysis",
] as const;
const EXPECTED_SKILL_NAMES = [
  ...EXPECTED_BUILTIN_SKILL_NAMES,
  ...EXPECTED_CUSTOM_SKILL_NAMES,
] as const;
const EXPECTED_SKILL_NAMES_BY_CATALOG_ORDER = [...EXPECTED_SKILL_NAMES].sort((left, right) =>
  left.localeCompare(right, "en")
);

test("every checked-in Skill package is discoverable, exact, and progressively disclosed", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-real-skills-"));
  const packageStore = join(workspace, "skill-packages");
  const database = new AppDatabase(":memory:");
  try {
    const builtin = await discoverSkillDirectory(SKILL_DIRECTORY);
    const custom = await discoverSkillDirectory(CUSTOM_SKILL_DIRECTORY);
    assert.deepEqual(builtin.map((entry) => entry.inspection.name), EXPECTED_BUILTIN_SKILL_NAMES);
    assert.deepEqual(custom.map((entry) => entry.inspection.name), EXPECTED_CUSTOM_SKILL_NAMES);
    const discovered = [...builtin, ...custom];

    for (const entry of discovered) {
      const source = await inspectSkillPackage(entry.sourceDirectory);
      assert.deepEqual(entry.inspection, source);
      assert.equal(entry.inspection.entrypointPath, "SKILL.md");
      assert.notEqual(entry.inspection.agentLoop, undefined);
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
    assert.ok(canvasDesign!.inspection.files.includes("scripts/render_static_canvas.py"));
    assert.match(canvasDesign!.inspection.instructions, /BOUNDED EXECUTION PATH/);
    assert.match(canvasDesign!.inspection.instructions, /render_static_canvas\.py/);
    assert.match(canvasDesign!.inspection.instructions, /--schema/);
    assert.match(canvasDesign!.inspection.instructions, /Do not read the renderer source/);
    assert.match(canvasDesign!.inspection.instructions, /Do not reread the philosophy or JSON spec/);

    const owner = testOwner();
    const skills = new SkillService(database, {
      packageStoreRoot: packageStore,
      skillDirectories: [SKILL_DIRECTORY, CUSTOM_SKILL_DIRECTORY],
    });
    const catalog = await skills.refreshSkillDirectory();
    assert.deepEqual(catalog.map((skill) => skill.name), EXPECTED_SKILL_NAMES);

    const available = await skills.listAvailable(owner.user.id);
    assert.deepEqual(available.map((skill) => skill.name), EXPECTED_SKILL_NAMES_BY_CATALOG_ORDER);
    assert.equal(available.every((skill) => skill.sourceKind === "package"), true);

    const installed = await skills.resolveForConversation(owner.user.id);
    assert.deepEqual(installed.map((skill) => skill.name), EXPECTED_SKILL_NAMES_BY_CATALOG_ORDER);
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

test("loaded package Skills show the Runtime path contract before Skill instructions", async () => {
  const source = await inspectSkillPackage(resolve(SKILL_DIRECTORY, "presentation-skill"));
  const loaded = formatLoadedSkill(
    {
      id: "discovered:presentation-skill",
      ownerUserId: "system",
      name: source.name,
      description: source.description,
      instructions: source.instructions,
      version: 1,
      sourceKind: "package",
      contentHash: source.packageHash,
      createdAt: 0,
      updatedAt: 0,
      package: {
        root: resolve(SKILL_DIRECTORY, "presentation-skill"),
        entrypointPath: source.entrypointPath,
        packageHash: source.packageHash,
        fileCount: source.fileCount,
        totalBytes: source.totalBytes,
      },
    },
    {
      executionCwd: () => "@skills/presentation-skill",
      executionRootEnvName: () => "AGENTLOOP_SKILL_ROOT_PRESENTATION_SKILL",
    },
  );
  assert.ok(
    loaded.indexOf("Runtime execution cwd for this Skill:") < loaded.indexOf(source.instructions),
    "Runtime package path contract must precede loaded Skill instructions",
  );
  assert.match(loaded, /relative writable task paths such as decks\/my-deck/);
  assert.match(loaded, /execution_context\.workspace\.root/);
});

test("presentation Skill body does not teach workspace-relative paths under the read-only Skill cwd", async () => {
  const source = await inspectSkillPackage(resolve(SKILL_DIRECTORY, "presentation-skill"));
  assert.doesNotMatch(source.instructions, /--workspace\s+decks\//);
  assert.doesNotMatch(source.instructions, /--output\s+out\.pptx/);
  assert.doesNotMatch(source.instructions, /--outdir\s+(?:renders|review|\/tmp)\b/);
  assert.match(source.instructions, /execution_context\.workspace\.root/);
  assert.match(source.instructions, /SKILL_PACKAGE_MUTATED/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
