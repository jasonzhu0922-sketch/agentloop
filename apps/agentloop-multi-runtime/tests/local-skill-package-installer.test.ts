import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { inspectSkillPackage } from "@zhujun/agentloop";
import { LocalSkillPackageInstaller } from "../local-agent-runtime/src/service/local-skill-package-installer.ts";

test("local Skill upload preserves user-owned private files and installs multiple Skills", async () => {
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
    zip.file("__MACOSX/._private-skill", "Finder metadata");
    zip.file("__MACOSX/private-skill/._SKILL.md", "Finder metadata");
    zip.file("private-skill/.DS_Store", "Finder metadata");
    const installed = await installer.installZip(await zip.generateAsync({ type: "nodebuffer" }), "private-skill.zip");
    assert.equal(installed.length, 1);
    assert.equal(installed[0]!.metadataSource, "detected");
    assert.equal(await readFile(join(installed[0]!.root, ".env"), "utf8"), "OA_DOC_TOKEN=local-only-token\n");
    assert.equal(await readFile(join(installed[0]!.root, "credentials.json"), "utf8"), '{"token":"local-only-token"}');
    assert.equal(await readFile(join(installed[0]!.root, "certs", "client.pem"), "utf8"), "local-only-certificate");

    const multiple = new JSZip();
    multiple.file("first/SKILL.md", "---\nname: first\ndescription: first\n---\n");
    multiple.file("second/SKILL.md", "---\nname: second\ndescription: second\n---\n");
    const multipleArchive = await multiple.generateAsync({ type: "nodebuffer" });
    const installedMultiple = await installer.installZip(multipleArchive, "multiple.zip");
    assert.deepEqual(installedMultiple.map((item) => item.inspection.name).sort(), ["first", "second"]);
    const installedAgain = await installer.installZip(multipleArchive, "multiple-again.zip");
    assert.deepEqual(installedAgain.map((item) => item.root), installedMultiple.map((item) => item.root));

    const directoryInstalled = await installer.installDirectory([
      { path: "directory-skill/SKILL.md", content: Buffer.from("---\nname: directory-skill\ndescription: directory\n---\n") },
      { path: "directory-skill/.env", content: Buffer.from("DIRECTORY_SECRET=local-only\n") },
      { path: "directory-skill/scripts/run.py", content: Buffer.from("print('ok')\n") },
    ]);
    assert.equal(directoryInstalled.length, 1);
    assert.equal(await readFile(join(directoryInstalled[0]!.root, ".env"), "utf8"), "DIRECTORY_SECRET=local-only\n");
    assert.equal(await readFile(join(directoryInstalled[0]!.root, "scripts", "run.py"), "utf8"), "print('ok')\n");
    await assert.rejects(
      installer.installDirectory([{ path: "../escaped/SKILL.md", content: Buffer.from("invalid") }]),
      (error: unknown) => error instanceof Error && error.message === "skill_upload_invalid",
    );

    const invalidMixed = new JSZip();
    invalidMixed.file("first/SKILL.md", "---\nname: first\ndescription: first\n---\n");
    invalidMixed.file("second/SKILL.md", "---\nname: second\ndescription: second\n---\n");
    invalidMixed.file("README.txt", "must belong to a Skill");
    await assert.rejects(
      installer.installZip(await invalidMixed.generateAsync({ type: "nodebuffer" }), "invalid-mixed.zip"),
      (error: unknown) => error instanceof Error && error.message === "skill_upload_package_layout_invalid",
    );
  } finally {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("local Skill upload materializes a sidecar declaration and migrates legacy frontmatter", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-skill-metadata-"));
  try {
    const installer = new LocalSkillPackageInstaller(join(root, "packages"));
    const zip = new JSZip();
    zip.file("legacy/SKILL.md", [
      "---",
      "name: legacy",
      "description: Legacy package",
      "agentloop:",
      "  roles:",
      "    - primary_builder",
      "  artifactKinds:",
      "    - document",
      "  sourceKinds: []",
      "  qaKinds: []",
      "---",
      "# Legacy instructions",
    ].join("\n"));
    const [installed] = await installer.installZip(await zip.generateAsync({ type: "nodebuffer" }), "legacy.zip");
    assert.ok(installed);
    const sidecar = JSON.parse(await readFile(join(installed.root, "agentloop.skill.json"), "utf8")) as { schema: string; workflow: { roles: string[] } };
    assert.equal(sidecar.schema, "agentloop.skillDeclaration/v1");
    assert.deepEqual(sidecar.workflow.roles, ["primary_builder"]);
    assert.equal((await readFile(join(installed.root, "SKILL.md"), "utf8")).includes("agentloop:"), false);
    const inspection = await inspectSkillPackage(installed.root);
    assert.equal(inspection.declarationSource, "package");
    assert.equal(inspection.declaration?.identity.name, "legacy");
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
