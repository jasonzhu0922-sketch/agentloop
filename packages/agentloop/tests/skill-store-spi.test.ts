import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import type {
  SkillInsertRecord,
  SkillPackageMetadataUpdate,
  SkillRecord,
  SkillStore,
} from "../src/storage/stores/skill-store.ts";
import { AppError, conflict } from "../src/shared/errors.ts";

test("a host-provided SkillStore fully replaces kernel persistence", async () => {
  const database = new AppDatabase(":memory:");
  try {
    // Prove the kernel never touches the default schema when a store is given.
    await database.exec("DROP TABLE skills");
    const store = new MemorySkillStore();
    const skills = new SkillService(database, { skillStore: store });

    const alpha = await skills.create("host-user-1", {
      name: "alpha",
      description: "First",
      instructions: "A",
    });
    const beta = await skills.create("host-user-1", {
      name: "beta",
      description: "Second",
      instructions: "B",
    });
    await skills.create("host-user-2", {
      name: "gamma",
      description: "Other owner",
      instructions: "C",
    });

    assert.equal(store.insertCalls, 3);
    assert.deepEqual(
      (await skills.list("host-user-1")).map((skill) => skill.name),
      ["alpha", "beta"],
    );
    assert.deepEqual(
      (await skills.get("host-user-1", beta.id)).instructions,
      "B",
    );
    assert.deepEqual((await skills.getMany("host-user-1", [alpha.id])).length, 1);

    await assert.rejects(
      () => skills.create("host-user-1", { name: "alpha", description: "Dup", instructions: "DUP" }),
      (error: unknown) => error instanceof AppError && error.code === "CONFLICT",
    );
    assert.equal(store.rows.size, 3);
  } finally {
    await database.close();
  }
});

test("package maintenance flows operate through the host store", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await database.exec("DROP TABLE skills");
    const store = new MemorySkillStore();
    const skills = new SkillService(database, { skillStore: store });

    const staleRoot = resolve(mkdtempSync(resolve(tmpdir(), "agentloop-skillstore-stale-")), "gone");
    store.rows.set("stale-package", {
      id: "stale-package",
      ownerUserId: "host-user-1",
      name: "stale-demo",
      description: "Legacy installed package",
      instructions: "OLD",
      sourceKind: "package",
      sourceUrl: null,
      sourceRevision: null,
      packageRoot: staleRoot,
      entrypointPath: "SKILL.md",
      packageHash: "0".repeat(64),
      packageFileCount: 1,
      packageTotalBytes: 10,
      contentHash: "0".repeat(64),
      version: 1,
      updatedAt: 1,
    });

    const pruned = await skills.pruneLegacyDirectoryPackageSkills();
    assert.equal(pruned, 1);
    assert.equal(store.rows.has("stale-package"), false);
  } finally {
    await database.close();
  }
});

test("SkillService requires a connection or a store", () => {
  assert.throws(() => new SkillService(), TypeError);
});

class MemorySkillStore implements SkillStore {
  readonly rows = new Map<string, SkillRecord>();
  insertCalls = 0;

  async findIdByOwnerAndName(ownerUserId: string, name: string): Promise<{ id: string } | undefined> {
    for (const record of this.rows.values()) {
      if (record.ownerUserId === ownerUserId && record.name === name) return { id: record.id };
    }
    return undefined;
  }

  async listByOwner(ownerUserId: string): Promise<SkillRecord[]> {
    return [...this.rows.values()]
      .filter((record) => record.ownerUserId === ownerUserId)
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
  }

  async listPackageSkills(): Promise<SkillRecord[]> {
    return [...this.rows.values()].filter((record) => record.sourceKind === "package");
  }

  async listPackageSkillsWithoutSourceProvenance(): Promise<SkillRecord[]> {
    return (await this.listPackageSkills()).filter((record) => record.sourceUrl === null && record.sourceRevision === null);
  }

  async findByIdAndOwner(skillId: string, ownerUserId: string): Promise<SkillRecord | undefined> {
    const record = this.rows.get(skillId);
    return record !== undefined && record.ownerUserId === ownerUserId ? record : undefined;
  }

  async insert(input: SkillInsertRecord): Promise<void> {
    this.insertCalls += 1;
    if (await this.findIdByOwnerAndName(input.ownerUserId, input.name) !== undefined) {
      throw conflict(`A private skill named "${input.name}" already exists`);
    }
    this.rows.set(input.id, {
      ...input,
      sourceUrl: input.sourceUrl ?? null,
      sourceRevision: input.sourceRevision ?? null,
      packageRoot: input.packageRoot ?? null,
      entrypointPath: input.entrypointPath ?? null,
      packageHash: input.packageHash ?? null,
      packageFileCount: input.packageFileCount ?? null,
      packageTotalBytes: input.packageTotalBytes ?? null,
      version: 1,
      updatedAt: input.now,
    });
  }

  async updatePackageMetadata(input: SkillPackageMetadataUpdate): Promise<void> {
    const current = this.rows.get(input.id);
    if (current === undefined) throw conflict("Missing package skill");
    if (await this.findIdByOwnerAndName(current.ownerUserId, input.name) !== undefined && current.name !== input.name) {
      throw conflict(`A private skill named "${input.name}" already exists`);
    }
    this.rows.set(input.id, {
      ...current,
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      packageHash: input.packageHash,
      packageFileCount: input.packageFileCount,
      packageTotalBytes: input.packageTotalBytes,
      contentHash: input.packageHash,
      version: current.version + 1,
      updatedAt: input.now,
    });
  }

  async deletePackageSkillById(id: string): Promise<void> {
    const record = this.rows.get(id);
    if (record !== undefined && record.sourceKind === "package") this.rows.delete(id);
  }
}
