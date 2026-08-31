import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";

test("selectVisibleSkills filters the catalog, conversation, and sub-agent paths consistently", async () => {
  const root = await fs.mkdtemp(resolve(tmpdir(), "agentloop-skill-visibility-"));
  const database = new AppDatabase(":memory:");
  try {
    const skillDirectory = resolve(root, "skills");
    const globalPackage = resolve(skillDirectory, "global-demo");
    await fs.mkdir(globalPackage, { recursive: true });
    await fs.writeFile(resolve(globalPackage, "SKILL.md"), [
      "---",
      "name: global-demo",
      "description: A globally discovered workflow",
      "---",
      "",
      "GLOBAL-BODY",
      "",
    ].join("\n"));

    const skills = new SkillService(database, {
      skillDirectory,
      selectVisibleSkills: ({ userId, skills }) => {
        if (userId === "restricted") return skills.filter((skill) => skill.name !== "private-secret");
        return skills;
      },
    });
    const secret = await skills.create("restricted", {
      name: "private-secret",
      description: "Hidden from the restricted user by the host hook",
      instructions: "SECRET-BODY",
    });
    await skills.create("restricted", {
      name: "private-open",
      description: "Visible to everyone",
      instructions: "OPEN-BODY",
    });
    await skills.refreshSkillDirectory();

    assert.deepEqual(
      (await skills.listAvailable("restricted")).map((skill) => skill.name),
      ["global-demo", "private-open"],
    );
    assert.deepEqual((await skills.listAvailable("admin")).map((skill) => skill.name), ["global-demo"]);

    const conversation = await skills.resolveForConversation("restricted");
    assert.deepEqual(conversation.map((skill) => skill.name), ["global-demo", "private-open"]);

    const agent = await skills.resolveForAgent("restricted", [secret.id]);
    assert.deepEqual(agent.map((skill) => skill.name), ["global-demo"]);
  } finally {
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failing visibility hook fails every consuming path closed", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database, {
      selectVisibleSkills: async () => {
        throw new Error("host authorization store unavailable");
      },
    });
    const created = await skills.create("user-1", {
      name: "any-skill",
      description: "Never becomes visible while the hook fails",
      instructions: "BODY",
    });

    await assert.rejects(() => skills.listAvailable("user-1"), /host authorization store unavailable/);
    await assert.rejects(() => skills.resolveForConversation("user-1"), /host authorization store unavailable/);
    await assert.rejects(
      () => skills.resolveForAgent("user-1", [created.id]),
      /host authorization store unavailable/,
    );

    // The record itself still exists; only visibility is gated.
    assert.equal((await skills.get("user-1", created.id)).name, "any-skill");
  } finally {
    await database.close();
  }
});

test("an absent visibility hook preserves the unfiltered behavior", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    await skills.create("user-1", {
      name: "alpha",
      description: "First",
      instructions: "A",
    });
    await skills.create("user-1", {
      name: "beta",
      description: "Second",
      instructions: "B",
    });
    assert.deepEqual(
      (await skills.listAvailable("user-1")).map((skill) => skill.name),
      ["alpha", "beta"],
    );
    assert.equal((await skills.resolveForConversation("user-1")).length, 2);
  } finally {
    await database.close();
  }
});
