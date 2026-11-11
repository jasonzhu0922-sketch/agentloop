import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { inspectSkillPackage, removeSkillPackage } from "../src/skills/skill-package.ts";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "skill-isolation-"));
  const database = new AppDatabase(":memory:");
  t.after(async () => { await database.close(); await removeSkillPackage(root); });
  const directory = join(root, "skills");
  await fs.mkdir(directory);
  const write = async (name: string) => {
    const path = join(directory, name);
    await fs.mkdir(path, { recursive: true });
    await fs.writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Test ${name}\n---\n\nInstructions for ${name}.\n`);
    return path;
  };
  const skills = new SkillService(database, { skillDirectory: directory, packageStoreRoot: join(root, "packages") });
  return { root, database, directory, write, skills };
}

test("invalid declarations, executors and disabled markers do not hide valid peers", async t => {
  const { write, skills, database } = await fixture(t);
  await write("good");
  const bad = await write("bad-declaration");
  await fs.writeFile(join(bad, "agentloop.skill.json"), JSON.stringify({ schema: "broken" }));
  const executor = await write("bad-executor");
  await fs.writeFile(join(executor, "agentloop.executors.json"), "{invalid");
  const disabled = await write("bad-disabled");
  await fs.writeFile(`${disabled}.disabled.json`, "{invalid");
  const result = await skills.syncSkillDirectories();
  assert.deepEqual(result.discoveredSkills.map(s => s.name), ["good"]);
  assert.deepEqual(result.diagnostics.map(d => d.skillName).sort(), ["bad-declaration", "bad-disabled", "bad-executor"]);
  assert.ok(result.diagnostics.every(d => d.stage === "discovery" && d.message.length > 0));
  assert.deepEqual((await skills.resolveForConversation("owner")).map(s => s.name), ["good"]);
  const rows = await database.prepare("SELECT name FROM discovered_skills").all();
  assert.deepEqual(rows.map(row => row.name), ["good"]);
});

test("missing configured directories and exact package roots are diagnosed during sync", async t => {
  const { root, directory, write, database } = await fixture(t);
  await write("good");
  const skills = new SkillService(database, {
    skillDirectories: [join(root, "missing-directory"), directory],
    skillPackageRoots: [join(root, "missing-package")],
  });
  const result = await skills.syncSkillDirectories();
  assert.deepEqual(result.discoveredSkills.map(s => s.name), ["good"]);
  assert.equal(result.diagnostics.length, 2);
});

test("refresh removes a newly broken Skill from planning and persistence, and repair restores it", async t => {
  const { write, skills, database } = await fixture(t);
  await write("good");
  const repairable = await write("repairable");
  await skills.syncSkillDirectories();
  await fs.writeFile(join(repairable, "agentloop.skill.json"), "{invalid");
  await skills.refreshSkillDirectory();
  assert.deepEqual((await skills.listAvailable("owner")).map(s => s.name), ["good"]);
  assert.deepEqual((await database.prepare("SELECT name FROM discovered_skills").all()).map(row => row.name), ["good"]);
  await assert.rejects(skills.resolveForAgent("owner", ["discovered:repairable"]));
  await fs.rm(join(repairable, "agentloop.skill.json"));
  await skills.syncSkillDirectories();
  assert.deepEqual((await skills.listAvailable("owner")).map(s => s.name), ["good", "repairable"]);
  assert.deepEqual(skills.loadDiagnostics(), []);
});

test("corrupted immutable execution copies are excluded without using the authoring source", async t => {
  const { write, skills } = await fixture(t);
  await write("good"); await write("corrupted");
  await skills.syncSkillDirectories();
  const corrupted = (await skills.listAvailable("owner")).find(s => s.name === "corrupted")!;
  await fs.chmod(join(corrupted.package!.root, "SKILL.md"), 0o600);
  await fs.writeFile(join(corrupted.package!.root, "SKILL.md"), "broken");
  const result = await skills.syncSkillDirectories();
  assert.deepEqual(result.discoveredSkills.map(s => s.name), ["good"]);
  assert.equal(result.diagnostics[0]?.stage, "materialization");
  assert.deepEqual((await skills.listAvailable("owner")).map(s => s.name), ["good"]);
});

test("catalog persistence failures remain fatal instead of being reported as a bad Skill", async t => {
  const { write, skills, database } = await fixture(t);
  await write("good");
  await database.exec("DROP TABLE discovered_skills");
  await assert.rejects(skills.syncSkillDirectories(), /no such table/);
});

test("invalid installed packages retain their records but cannot enter planning or explicit bindings", async t => {
  const { root, directory, write, database } = await fixture(t);
  const source = await write("installed");
  const inspection = await inspectSkillPackage(source);
  const skills = new SkillService(database, { packageStoreRoot: join(root, "installed-packages"), allowedImportRoots: [directory] });
  const installed = await skills.installFromDirectory("owner", {
    sourceDirectory: source, sourceUrl: "https://example.test/skills", sourceRevision: "a".repeat(40), expectedPackageHash: inspection.packageHash,
  });
  await fs.chmod(join(installed.package!.root, "SKILL.md"), 0o600);
  await fs.writeFile(join(installed.package!.root, "SKILL.md"), "broken");
  const result = await skills.syncSkillDirectories();
  assert.equal(result.diagnostics[0]?.stage, "installed");
  assert.deepEqual(await skills.resolveForConversation("owner"), []);
  await assert.rejects(skills.resolveForAgent("owner", [installed.id]), /unavailable/);
  assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM skills").get())?.count, 1);
  await fs.writeFile(join(installed.package!.root, "SKILL.md"), inspection.instructions);
  await skills.syncSkillDirectories();
  assert.deepEqual(skills.loadDiagnostics(), []);
  assert.equal((await skills.resolveForConversation("owner"))[0]?.id, installed.id);
});
