import assert from "node:assert/strict";
import test from "node:test";
import { buildSkillFileTree } from "../src/app/skill-file-tree.ts";

test("Skill file tree preserves nested directories and counts descendant files", () => {
  const tree = buildSkillFileTree([
    "SKILL.md",
    "references/source/api.md",
    "references/source/schema.json",
    "references/guide.md",
    "scripts/run.py",
  ]);

  assert.deepEqual(tree.map((node) => [node.kind, node.name, node.fileCount]), [
    ["directory", "references", 3],
    ["directory", "scripts", 1],
    ["file", "SKILL.md", 1],
  ]);
  const references = tree[0]!;
  assert.deepEqual(references.children.map((node) => [node.kind, node.name, node.fileCount]), [
    ["directory", "source", 2],
    ["file", "guide.md", 1],
  ]);
  assert.deepEqual(references.children[0]!.children.map((node) => node.path), [
    "references/source/api.md",
    "references/source/schema.json",
  ]);
});

test("Skill file tree rejects a file-directory path conflict", () => {
  assert.throws(() => buildSkillFileTree(["references", "references/guide.md"]), /path conflicts/);
});
