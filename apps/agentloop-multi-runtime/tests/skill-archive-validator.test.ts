import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { validateSkillArchive } from "../web/skill-archive-validator.mjs";

async function archive(entries: Record<string, string>) {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("Skill archive validator accepts templates but rejects private environment files", async () => {
  const accepted = await validateSkillArchive(await archive({
    "custom-skills/demo/SKILL.md": "# Demo\n",
    "custom-skills/demo/.env.example": "DEMO_TOKEN=\n",
  }), { originalName: "custom-skills.zip" });
  assert.deepEqual(accepted.entries.map((entry) => entry.path), ["demo/SKILL.md", "demo/.env.example"]);

  for (const path of ["custom-skills/demo/.env", "custom-skills/demo/.env.local", "custom-skills/demo/.env/secret"]) {
    await assert.rejects(
      validateSkillArchive(await archive({ "custom-skills/demo/SKILL.md": "# Demo\n", [path]: "secret\n" }), { originalName: "custom-skills.zip" }),
      (error: unknown) => error instanceof Error && error.message === "skill_upload_invalid",
    );
  }
});
