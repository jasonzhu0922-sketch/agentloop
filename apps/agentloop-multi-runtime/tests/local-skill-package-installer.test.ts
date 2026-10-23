import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { LocalSkillPackageInstaller } from "../local-agent-runtime/src/service/local-skill-package-installer.ts";

test("local Skill upload preserves user-owned private files and rejects multi-Skill layouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-skill-upload-"));
  try {
    const store = join(root, "packages");
    await mkdir(store, { recursive: true });
    const installer = new LocalSkillPackageInstaller(store);
    const zip = new JSZip();
    zip.file("private-skill/SKILL.md", "---\nname: private-skill\ndescription: local\n---\n");
    zip.file("private-skill/.env", "OA_DOC_TOKEN=local-only-token\n");
    zip.file("private-skill/credentials.json", '{"token":"local-only-token"}');
    zip.file("private-skill/certs/client.pem", "local-only-certificate");
    const installed = await installer.installZip(await zip.generateAsync({ type: "nodebuffer" }), "private-skill.zip");
    assert.equal(await readFile(join(installed.root, ".env"), "utf8"), "OA_DOC_TOKEN=local-only-token\n");
    assert.equal(await readFile(join(installed.root, "credentials.json"), "utf8"), '{"token":"local-only-token"}');
    assert.equal(await readFile(join(installed.root, "certs", "client.pem"), "utf8"), "local-only-certificate");

    const multiple = new JSZip();
    multiple.file("first/SKILL.md", "---\nname: first\ndescription: first\n---\n");
    multiple.file("second/SKILL.md", "---\nname: second\ndescription: second\n---\n");
    await assert.rejects(
      installer.installZip(await multiple.generateAsync({ type: "nodebuffer" }), "multiple.zip"),
      (error: unknown) => error instanceof Error && error.message === "skill_upload_package_layout_invalid",
    );
  } finally {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

async function makeWritable(path: string): Promise<void> {
  await chmod(path, 0o700).catch(() => undefined);
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeWritable(child);
    else await chmod(child, 0o600).catch(() => undefined);
  }
}
