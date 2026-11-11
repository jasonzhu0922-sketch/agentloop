import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { removeSkillPackage } from "@zhujun/agentloop";
import { createLocalRuntimeManager } from "@zhujun/agentloop-local-runtime";
import { modelPort } from "./fixtures/models.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "runtime-skill-isolation-"));
  t.after(() => removeSkillPackage(root));
  const bundled = join(root, "bundled"); await mkdir(bundled);
  const writeSkill = async (directory: string, name: string) => {
    const path = join(directory, name); await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Test ${name}\n---\n\nFollow this Skill.\n`);
    return path;
  };
  return { root, bundled, writeSkill };
}

test("a bad bundled Skill leaves the Runtime ready, diagnosed, and able to complete a Run", async t => {
  const { root, bundled, writeSkill } = await fixture(t);
  await writeSkill(bundled, "good");
  const bad = await writeSkill(bundled, "bad");
  await writeFile(join(bad, "agentloop.skill.json"), "{invalid");
  const logs: string[] = [];
  const manager = await createLocalRuntimeManager({ dataDirectory: root, defaultRuntimeId: "default", models: modelPort(),
    bundledSkillDirectories: [bundled], runEventLogSink: (_runtime, line) => logs.push(line) });
  t.after(() => manager.close());
  const summary = (await manager.runtimes())[0]!;
  assert.equal(summary.status, "ready");
  assert.equal(summary.skillDiagnostics?.[0]?.skillName, "bad");
  assert.ok(logs.some(line => line.includes("Skill excluded")));
  const runtime = manager.runtime("default");
  assert.deepEqual(await runtime.models(), ["local:test"]);
  const context = { ownerUserId: "owner" };
  let run = await runtime.startRun(context, { input: "你好", modelKey: "local:test" });
  for (let i = 0; i < 200 && run.status === "running"; i++) {
    await setTimeout(10); run = await runtime.getRun(context, run.id);
  }
  assert.equal(run.status, "completed");
  assert.match(run.output ?? "", /你好/);
});

test("a corrupted bound upload cannot prevent reopen, and repair preserves its original binding", async t => {
  const { root, bundled } = await fixture(t);
  const options = { dataDirectory: root, defaultRuntimeId: "default", models: modelPort(), bundledSkillDirectories: [bundled] };
  let manager = await createLocalRuntimeManager(options);
  t.after(() => manager.close());
  const content = Buffer.from("---\nname: uploaded\ndescription: An uploaded Skill\n---\n\nInstructions.\n");
  const [skill] = await manager.importSkills({ files: [{ path: "SKILL.md", content }] });
  await manager.stopRuntime("default");
  await manager.configureRuntime("default", { skillPackageIds: [skill!.packageId], mcpServerIds: [] });
  await manager.startRuntime("default");
  await manager.close();
  const [stored] = await readdir(join(root, "skill-library"));
  const path = join(root, "skill-library", stored!, "SKILL.md");
  const original = await readFile(path);
  await chmod(path, 0o600); await writeFile(path, "broken");
  manager = await createLocalRuntimeManager(options);
  assert.equal((await manager.runtimes())[0]?.status, "ready");
  assert.equal((await manager.runtimes())[0]?.skillDiagnostics?.[0]?.skillName, "uploaded");
  assert.equal((await manager.skillPackages())[0]?.validationStatus, "invalid");
  assert.deepEqual((await manager.configuration("default")).skills.map(s => s.packageId), [skill!.packageId]);
  assert.deepEqual(await manager.runtime("default").models(), ["local:test"]);
  const db = new DatabaseSync(join(root, "runtime.db"), { readOnly: true });
  try { assert.deepEqual(db.prepare("SELECT name FROM discovered_skills").all(), []); } finally { db.close(); }
  await manager.close();
  await writeFile(path, original);
  manager = await createLocalRuntimeManager(options);
  assert.equal((await manager.runtimes())[0]?.status, "ready");
  assert.equal((await manager.runtimes())[0]?.skillDiagnostics, undefined);
  assert.equal((await manager.skillPackages())[0]?.validationStatus, "valid");
  assert.deepEqual((await manager.configuration("default")).skills.map(s => s.packageId), [skill!.packageId]);
});

test("invalid custom sources remain visible for repair and do not erase Runtime bindings", async t => {
  const { root, bundled, writeSkill } = await fixture(t);
  const custom = join(root, "custom"); await mkdir(custom);
  const bad = await writeSkill(custom, "repairable");
  const options = { dataDirectory: root, defaultRuntimeId: "default", bundledSkillDirectories: [bundled], customSkillDirectories: [custom] };
  let manager = await createLocalRuntimeManager(options);
  t.after(() => manager.close());
  const [skill] = await manager.skillPackages();
  // Existing custom sources are bound by the initial legacy catalog import.
  const bindings = (await manager.configuration("default")).skills.map(s => s.packageId);
  await manager.close();
  await writeFile(join(bad, "agentloop.skill.json"), "{invalid");
  manager = await createLocalRuntimeManager(options);
  assert.equal((await manager.runtimes())[0]?.status, "ready");
  assert.equal((await manager.skillPackages())[0]?.packageId, skill!.packageId);
  assert.equal((await manager.skillPackages())[0]?.validationStatus, "invalid");
  assert.deepEqual((await manager.configuration("default")).skills.map(s => s.packageId), bindings);
});

test("an unavailable bound Skill does not block other edits or unbinding, and cannot be newly bound", async t => {
  const { root, bundled } = await fixture(t);
  const options = { dataDirectory: root, defaultRuntimeId: "default", models: modelPort(), bundledSkillDirectories: [bundled] };
  let manager = await createLocalRuntimeManager(options);
  t.after(() => manager.close());
  const upload = async (name: string) => (await manager.importSkills({ files: [{ path: "SKILL.md",
    content: Buffer.from(`---\nname: ${name}\ndescription: Test ${name}\n---\n\nInstructions.\n`) }] }))[0]!;
  const broken = await upload("unavailable"), healthy = await upload("healthy");
  await manager.stopRuntime("default");
  await manager.configureRuntime("default", { skillPackageIds: [broken.packageId, healthy.packageId], mcpServerIds: [] });
  await manager.close();
  const directory = (await readdir(join(root, "skill-library"))).find(name => name.startsWith(`uploaded-${broken.packageId.slice("local_skill_".length)}`))!;
  const path = join(root, "skill-library", directory, "SKILL.md");
  const original = await readFile(path, "utf8");
  await chmod(path, 0o600); await writeFile(path, `${original}\nChanged after import.\n`);
  manager = await createLocalRuntimeManager(options);
  assert.equal((await manager.runtimes())[0]?.status, "stopped");
  assert.equal((await manager.skillPackages()).find(pkg => pkg.packageId === broken.packageId)?.validationStatus, "invalid");
  // Removing a healthy Skill and changing the icon preserves the quarantined
  // binding instead of letting it veto the entire configuration save.
  await manager.configureRuntime("default", { skillPackageIds: [broken.packageId], mcpServerIds: [], iconKey: "qinglong" });
  assert.deepEqual((await manager.configuration("default")).skills.map(s => s.packageId), [broken.packageId]);
  assert.equal((await manager.configuration("default")).iconKey, "qinglong");
  await manager.startRuntime("default");
  assert.equal((await manager.runtimes())[0]?.status, "ready");
  assert.equal((await manager.runtimes())[0]?.skillDiagnostics?.[0]?.skillName, "unavailable");
  const db = new DatabaseSync(join(root, "runtime.db"), { readOnly: true });
  try { assert.deepEqual(db.prepare("SELECT name FROM discovered_skills").all(), []); } finally { db.close(); }
  await manager.stopRuntime("default");
  await manager.configureRuntime("default", { skillPackageIds: [], mcpServerIds: [] });
  assert.deepEqual((await manager.configuration("default")).skills, []);
  await assert.rejects(manager.configureRuntime("default", { skillPackageIds: [broken.packageId], mcpServerIds: [] }), /skill_package_invalid/);
  assert.deepEqual((await manager.configuration("default")).skills, []);
});
