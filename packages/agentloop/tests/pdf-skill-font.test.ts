import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { inspectSkillPackage } from "../src/skills/skill-package.ts";

const PDF_SKILL_ROOT = resolve(import.meta.dirname, "..", "..", "agentloop-skills", "skills", "pdf");

test("PDF Skill ships and requires its embedded CJK font instead of host discovery", async () => {
  const inspection = await inspectSkillPackage(PDF_SKILL_ROOT);
  const font = resolve(PDF_SKILL_ROOT, "assets", "fonts", "NotoSansSC.ttf");

  assert.ok(inspection.files.includes("assets/fonts/NotoSansSC.ttf"));
  assert.ok(inspection.files.includes("assets/fonts/OFL.txt"));
  assert.match(inspection.instructions, /AGENTLOOP_SKILL_ROOT_PDF/);
  assert.match(inspection.instructions, /TTFont/);
  assert.match(inspection.instructions, /never `fc-list`, `fc-match`, a system-font/);
  assert.doesNotMatch(inspection.instructions, /Use a known CJK-capable font\s+from `fc-list` or a system font path/);
  assert.ok((await stat(font)).size > 16 * 1024 * 1024);
});
