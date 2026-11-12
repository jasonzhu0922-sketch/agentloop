import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase, inspectSkillPackage, type SkillDeclaration } from "@zhujun/agentloop";
import { LocalRuntimeConfigurationStore } from "../dist/configuration/local-runtime-configuration-store.js";

test("tag options use current account library declarations and active revisions, excluding unavailable packages", async t => {
  const root = await mkdtemp(join(tmpdir(), "skill-tag-options-"));
  const databases: AppDatabase[] = [];
  t.after(async () => { for (const database of databases) await database.close(); await rm(root, { recursive: true, force: true }); });
  const storeFor = async (account: string) => {
    const database = new AppDatabase(join(root, `${account}.db`)); databases.push(database);
    const store = new LocalRuntimeConfigurationStore(database); await store.ready();
    return { store, database };
  };
  const writeSkill = async (name: string, tags: string[]) => {
    const path = join(root, name); await mkdir(path);
    const declaration: SkillDeclaration = {
      schema: "agentloop.skillDeclaration/v1", identity: { name, description: name },
      activation: { semanticTags: tags, intentExamples: [] },
      workflow: { roles: ["support"], artifactKinds: ["none"], sourceKinds: [], qaKinds: [], requiredSkills: [] },
    };
    await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\nInstructions.\n`);
    await writeFile(join(path, "agentloop.skill.json"), JSON.stringify(declaration));
    return { path, inspection: await inspectSkillPackage(path) };
  };
  const { store, database } = await storeFor("first");
  const sample = await writeSkill("sample", ["package-specific", "shared"]);
  const pkg = await store.registerUploadedPackage({ root: sample.path, storageKey: `uploaded-${sample.inspection.packageHash}`, inspection: sample.inspection });
  const customDirectory = join(root, "custom"); await mkdir(customDirectory);
  const unopened = await writeSkill("unopened", ["custom-tag", "shared"]);
  // A custom Skill has no metadata revision until its editor is opened.
  await rename(unopened.path, join(customDirectory, "unopened"));
  const unavailable = await writeSkill("unavailable", ["excluded-tag"]);
  const bad = await store.registerUploadedPackage({ root: unavailable.path, storageKey: `uploaded-${unavailable.inspection.packageHash}`, inspection: unavailable.inspection });
  await database.prepare("UPDATE local_skill_packages SET validation_status = 'invalid' WHERE package_id = ?").run(bad.packageId);
  await store.synchronizeCustomDirectories([customDirectory]);
  const first = await store.skillMetadata(pkg.packageId);
  assert.deepEqual(first.semanticTagOptions, ["custom-tag", "package-specific", "shared"]);
  await store.updateSkillMetadata(pkg.packageId, { ...first.declaration, activation: { semanticTags: ["edited-tag"], intentExamples: [] } }, first.revision);
  const saved = await store.skillMetadata(pkg.packageId);
  assert.deepEqual(saved.semanticTagOptions, ["custom-tag", "edited-tag", "shared"]);
  assert.deepEqual(saved.declaration.activation.semanticTags, ["edited-tag"]);
  const other = await storeFor("second");
  const second = await other.store.registerUploadedPackage({ root: sample.path, storageKey: `uploaded-${sample.inspection.packageHash}`, inspection: sample.inspection });
  assert.deepEqual((await other.store.skillMetadata(second.packageId)).semanticTagOptions, ["package-specific", "shared"]);
});
