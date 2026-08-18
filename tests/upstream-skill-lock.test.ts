import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { inspectSkillPackage } from "../src/skills/skill-package.ts";
import { discoverSkillDirectory } from "../src/skills/skill-directory.ts";

const ROOT = resolve(import.meta.dirname, "..");

test("the presentation Skill is discoverable from its standard package structure without a source lock", async () => {
  const catalog = await discoverSkillDirectory(resolve(ROOT, "skills"));
  const entry = catalog.find((item) => item.inspection.name === "presentation-skill");
  assert.notEqual(entry, undefined);
  assert.equal(entry?.sourceUrl, undefined);
  assert.equal(entry?.sourceRevision, undefined);
  const packageRoot = resolve(ROOT, "skills/presentation-skill");
  const inspected = await inspectSkillPackage(packageRoot);
  assert.equal(entry?.inspection.packageHash, inspected.packageHash);
  assert.equal(inspected.name, "presentation-skill");
  assert.ok(inspected.fileCount > 0);
  assert.ok(inspected.totalBytes > 0);
});
