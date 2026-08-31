import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";

test("discovered Skill snapshots are persisted, versioned, and reconciled", async () => {
  const root = await fs.mkdtemp(resolve(tmpdir(), "agentloop-discovery-persist-"));
  const database = new AppDatabase(":memory:");
  try {
    const skillDirectory = resolve(root, "skills");
    const sourcePackage = resolve(skillDirectory, "sync-demo");
    await fs.mkdir(sourcePackage, { recursive: true });
    await fs.writeFile(resolve(sourcePackage, "SKILL.md"), [
      "---",
      "name: sync-demo",
      "description: Original description",
      "---",
      "",
      "SYNC-BODY-V1",
      "",
    ].join("\n"));

    const skills = new SkillService(database, { skillDirectory });
    await skills.refreshSkillDirectory();

    let snapshots = await listDiscoveredSnapshots(database);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].name, "sync-demo");
    assert.equal(snapshots[0].description, "Original description");
    assert.equal(snapshots[0].sourceDirectory, await fs.realpath(sourcePackage));
    assert.equal(snapshots[0].version, 1);

    // Idempotent refresh must not bump versions.
    await skills.refreshSkillDirectory();
    snapshots = await listDiscoveredSnapshots(database);
    assert.equal(snapshots[0].version, 1);

    // Content change bumps the version and updates the snapshot.
    await fs.writeFile(resolve(sourcePackage, "SKILL.md"), [
      "---",
      "name: sync-demo",
      "description: Updated description",
      "---",
      "",
      "SYNC-BODY-V2",
      "",
    ].join("\n"));
    await skills.refreshSkillDirectory();
    snapshots = await listDiscoveredSnapshots(database);
    assert.equal(snapshots[0].version, 2);
    assert.equal(snapshots[0].description, "Updated description");

    // Removing the package reconciles the persisted catalog.
    await fs.rm(sourcePackage, { recursive: true, force: true });
    await skills.refreshSkillDirectory();
    snapshots = await listDiscoveredSnapshots(database);
    assert.deepEqual(snapshots.map((snapshot) => snapshot.name), []);
  } finally {
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stores without the discovery capability keep discovery in memory without errors", async () => {
  const root = await fs.mkdtemp(resolve(tmpdir(), "agentloop-discovery-memory-"));
  const database = new AppDatabase(":memory:");
  try {
    const skillDirectory = resolve(root, "skills");
    const sourcePackage = resolve(skillDirectory, "plain-demo");
    await fs.mkdir(sourcePackage, { recursive: true });
    await fs.writeFile(resolve(sourcePackage, "SKILL.md"), [
      "---",
      "name: plain-demo",
      "description: Plain catalog entry",
      "---",
      "",
      "PLAIN-BODY",
      "",
    ].join("\n"));

    const skills = new SkillService(database, { skillDirectory });
    const catalog = await skills.refreshSkillDirectory();
    assert.deepEqual(catalog.map((item) => item.name), ["plain-demo"]);
  } finally {
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup Skill directory sync validates all roots and persists the merged catalog", async () => {
  const root = await fs.mkdtemp(resolve(tmpdir(), "agentloop-startup-skill-sync-"));
  const database = new AppDatabase(":memory:");
  try {
    const builtInDirectory = resolve(root, "built-in-skills");
    const customDirectory = resolve(root, "custom-skills");
    await writeSkillPackage(resolve(builtInDirectory, "builtin-demo"), "builtin-demo", "Built-in demo Skill");
    await writeSkillPackage(resolve(customDirectory, "custom-demo"), "custom-demo", "Custom demo Skill");

    const skills = new SkillService(database, {
      skillDirectories: [builtInDirectory, customDirectory],
    });
    const result = await skills.syncSkillDirectories();

    assert.deepEqual(result.discoveredSkills.map((skill) => skill.name), ["builtin-demo", "custom-demo"]);
    assert.equal(result.prunedLegacySkillCount, 0);
    assert.equal(result.refreshedInstalledSkillCount, 0);

    const snapshots = await listDiscoveredSnapshots(database);
    assert.deepEqual(snapshots.map((snapshot) => snapshot.name), ["builtin-demo", "custom-demo"]);
    assert.deepEqual(skills.discovered().map((skill) => skill.name), ["builtin-demo", "custom-demo"]);
  } finally {
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup Skill directory sync removes same-name legacy package records whose managed root is missing", async () => {
  const root = await fs.mkdtemp(resolve(tmpdir(), "agentloop-startup-stale-package-"));
  const database = new AppDatabase(":memory:");
  try {
    const skillDirectory = resolve(root, "skills");
    const packageStoreRoot = resolve(root, "managed-packages");
    await writeSkillPackage(resolve(skillDirectory, "legacy-demo"), "legacy-demo", "Current directory Skill");
    const staleRoot = resolve(packageStoreRoot, "owner", "legacy-demo");
    const now = Date.now();
    await database.prepare(`
      INSERT INTO skills(
        id, owner_user_id, name, description, instructions, source_kind,
        package_root, entrypoint_path, package_hash, package_file_count,
        package_total_bytes, content_hash, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'package', ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      "legacy-package-record",
      "owner-1",
      "legacy-demo",
      "Stale installed copy",
      "STALE",
      staleRoot,
      "SKILL.md",
      "a".repeat(64),
      1,
      5,
      "a".repeat(64),
      now,
      now,
    );

    const skills = new SkillService(database, { skillDirectory, packageStoreRoot });
    const result = await skills.syncSkillDirectories();

    assert.equal(result.prunedLegacySkillCount, 1);
    assert.equal(result.refreshedInstalledSkillCount, 0);
    const remaining = await database.prepare("SELECT COUNT(*) AS count FROM skills WHERE id = ?")
      .get("legacy-package-record") as { count: number };
    assert.equal(remaining.count, 0);
    assert.deepEqual(skills.discovered().map((skill) => skill.name), ["legacy-demo"]);
  } finally {
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function writeSkillPackage(directory: string, name: string, description: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(resolve(directory, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `${name.toUpperCase()} BODY`,
    "",
  ].join("\n"));
}

async function listDiscoveredSnapshots(
  database: AppDatabase,
): Promise<Array<{ name: string; description: string; sourceDirectory: string; version: number }>> {
  return ((await database.prepare(`
    SELECT name, description, source_directory, version
    FROM discovered_skills ORDER BY name
  `).all()) as unknown as Array<{
    name: string;
    description: string;
    source_directory: string;
    version: number;
  }>).map((row) => ({
    name: row.name,
    description: row.description,
    sourceDirectory: row.source_directory,
    version: row.version,
  }));
}
