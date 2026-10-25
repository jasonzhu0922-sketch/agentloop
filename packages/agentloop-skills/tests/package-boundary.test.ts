import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { bundledSkillDirectories } from "../src/index.ts";

test("the skills package exposes its bundled Skill directory through the public API", () => {
  const directories = bundledSkillDirectories();
  assert.deepEqual(directories, [resolve(import.meta.dirname, "..", "skills")]);
  assert.equal(statSync(directories[0]!).isDirectory(), true);
});

test("the skills package delivery includes the bundled skills directory", () => {
  const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
    files?: string[];
  };
  assert.deepEqual(packageJson.files, ["dist", "skills", "README.md"]);
  assert.ok(packageJson.files?.includes("skills"));
});

test("every bundled Skill keeps AgentLoop metadata in a sidecar, not SKILL.md", async () => {
  const [root] = bundledSkillDirectories();
  const children = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  assert.ok(children.length > 0);
  for (const child of children) {
    const packageRoot = resolve(root, child.name);
    const declaration = JSON.parse(readFileSync(resolve(packageRoot, "agentloop.skill.json"), "utf8")) as {
      schema?: string;
      identity?: { name?: string };
    };
    const instructions = readFileSync(resolve(packageRoot, "SKILL.md"), "utf8");
    assert.equal(declaration.schema, "agentloop.skillDeclaration/v1", child.name);
    assert.equal(declaration.identity?.name, child.name, child.name);
    assert.doesNotMatch(instructions, /^agentloop:\s*$/mu, child.name);
  }
});
