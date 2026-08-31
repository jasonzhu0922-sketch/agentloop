import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { bundledSkillDirectories } from "../src/index.js";
test("the skills package exposes its bundled Skill directory through the public API", () => {
    const directories = bundledSkillDirectories();
    assert.deepEqual(directories, [resolve(import.meta.dirname, "..", "skills")]);
    assert.equal(statSync(directories[0]).isDirectory(), true);
});
test("the skills package delivery includes the bundled skills directory", () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
    assert.deepEqual(packageJson.files, ["dist", "skills", "README.md"]);
    assert.ok(packageJson.files?.includes("skills"));
});
