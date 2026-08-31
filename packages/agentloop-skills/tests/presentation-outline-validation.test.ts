import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const validator = resolve(import.meta.dirname, "../skills/presentation-skill/scripts/validate_outline_json.js");

test("presentation outline validator accepts a renderable JSON source", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "agentloop-presentation-outline-"));
  try {
    const outline = resolve(directory, "outline.json");
    writeFileSync(outline, JSON.stringify({ title: "Test", slides: [{ type: "title", title: "Test" }] }));

    const result = spawnSync(process.execPath, [validator, "--outline", outline], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { valid: true, outline, slideCount: 1 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("presentation outline validator rejects malformed JSON before a build", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "agentloop-presentation-outline-"));
  try {
    const outline = resolve(directory, "outline.json");
    writeFileSync(outline, '{"slides":["from"done""]}');

    const result = spawnSync(process.execPath, [validator, "--outline", outline], { encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /outline validation failed: .*JSON/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
