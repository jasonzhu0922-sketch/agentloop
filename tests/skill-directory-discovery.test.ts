import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts";
import type { Planner, StepAssessor } from "../src/planning/contracts.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { inspectSkillPackage, removeSkillPackage } from "../src/skills/skill-package.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

test("Agent Loop discovers an unlocked Skill directory and privately provisions the exact package", async () => {
  const fixture = await createDirectoryFixture();
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database, {
      packageStoreRoot: fixture.packageStore,
      skillDirectory: fixture.skillDirectory,
    });
    const catalog = await skills.refreshSkillDirectory();
    assert.deepEqual(catalog.map((item) => item.name), ["directory-demo"]);
    assert.equal(catalog[0].packageHash, fixture.packageHash);
    assert.equal(catalog[0].sourceUrl, undefined);
    assert.equal(catalog[0].sourceRevision, undefined);

    const owner = await auth.register("directory-owner@example.com", "directory owner secure password");
    const stranger = await auth.register("directory-stranger@example.com", "directory stranger secure password");
    const ownerSkills = await skills.listAvailable(owner.user.id);
    const strangerSkills = await skills.listAvailable(stranger.user.id);
    assert.equal(ownerSkills.length, 1);
    assert.equal(strangerSkills.length, 1);
    assert.notEqual(ownerSkills[0].id, strangerSkills[0].id);
    assert.notEqual(ownerSkills[0].package?.root, strangerSkills[0].package?.root);
    assert.notEqual(ownerSkills[0].package?.root, fixture.sourcePackage);
    assert.equal(ownerSkills[0].package?.packageHash, fixture.packageHash);
    assert.equal((await fs.stat(resolve(ownerSkills[0].package!.root, "SKILL.md"))).mode & 0o222, 0);

    const runs = new RunService({
      database,
      skills,
      workspaceRoot: fixture.root,
      modelFactory: () => new DirectorySkillModel(),
      plannerFactory: () => directoryPlanner(),
      assessorFactory: () => approvingAssessor(),
    });
    const run = await runs.execute(owner.user.id, "apply the discovered workflow");
    assert.equal(run.status, "completed");
    assert.equal(run.output, "directory Skill loaded and followed");
    const plan = runs.plan(owner.user.id, run.id).plan;
    assert.deepEqual(plan.selectedSkillIds, [ownerSkills[0].id]);
    const events = runs.events(owner.user.id, run.id);
    assert.equal(events.some((event) =>
      event.type === "tool.completed" && event.data.toolName === "load_skill"
    ), true);
    assert.equal(events.some((event) =>
      event.type === "skill.package.verified" && event.data.packageHash === fixture.packageHash
    ), true);
    assert.equal(events.some((event) =>
      event.type === "skill.directory.resolved" && event.data.packageHash === fixture.packageHash
    ), true);
    assert.equal((await inspectSkillPackage(fixture.sourcePackage)).packageHash, fixture.packageHash);
  } finally {
    database.close();
    await removeSkillPackage(fixture.packageStore).catch(() => undefined);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("an invalid sibling source lock does not prevent a standard Skill package from entering Agent Loop", async () => {
  const fixture = await createDirectoryFixture();
  const database = new AppDatabase(":memory:");
  try {
    await fs.writeFile(resolve(fixture.skillDirectory, "directory-demo.source.json"), JSON.stringify({
      schema: "agentloop.upstreamSkillSource/v1",
      repository: "https://example.com/directory-demo",
      revision: "not-a-commit",
    }));
    const skills = new SkillService(database, {
      packageStoreRoot: fixture.packageStore,
      skillDirectory: fixture.skillDirectory,
    });
    const catalog = await skills.refreshSkillDirectory();
    assert.deepEqual(catalog.map((item) => item.name), ["directory-demo"]);
    assert.equal(catalog[0].sourceUrl, undefined);
  } finally {
    database.close();
    await removeSkillPackage(fixture.packageStore).catch(() => undefined);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a matching sibling source lock is retained as optional provenance", async () => {
  const fixture = await createDirectoryFixture();
  const database = new AppDatabase(":memory:");
  try {
    const inspection = await inspectSkillPackage(fixture.sourcePackage);
    const instructions = await fs.readFile(resolve(fixture.sourcePackage, "SKILL.md"), "utf8");
    await fs.writeFile(resolve(fixture.skillDirectory, "directory-demo.source.json"), JSON.stringify({
      schema: "agentloop.upstreamSkillSource/v1",
      repository: "https://example.com/directory-demo",
      revision: "a".repeat(40),
      packageHashAlgorithm: "agentloop.skillPackage/v1",
      packageSha256: inspection.packageHash,
      packageFileCount: inspection.fileCount,
      packageTotalBytes: inspection.totalBytes,
      skillMdSha256: createHash("sha256").update(instructions).digest("hex"),
    }));
    const skills = new SkillService(database, {
      packageStoreRoot: fixture.packageStore,
      skillDirectory: fixture.skillDirectory,
    });
    const [entry] = await skills.refreshSkillDirectory();
    assert.equal(entry.sourceUrl, "https://example.com/directory-demo");
    assert.equal(entry.sourceRevision, "a".repeat(40));
  } finally {
    database.close();
    await removeSkillPackage(fixture.packageStore).catch(() => undefined);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("an explicit disabled declaration quarantines a directory without changing normal package admission", async () => {
  const fixture = await createDirectoryFixture();
  try {
    const disabled = resolve(fixture.skillDirectory, "restricted-demo");
    await fs.mkdir(disabled);
    await fs.writeFile(resolve(disabled, "SKILL.md"), [
      "---",
      "name: restricted-demo",
      "description: Must not enter the Agent catalog",
      "---",
      "RESTRICTED-BODY",
    ].join("\n"));
    const { discoverSkillDirectory } = await import("../src/skills/skill-directory.ts");
    const beforeDisable = await discoverSkillDirectory(fixture.skillDirectory);
    assert.deepEqual(
      beforeDisable.map((entry) => entry.inspection.name),
      ["directory-demo", "restricted-demo"],
    );
    await fs.writeFile(resolve(fixture.skillDirectory, "restricted-demo.disabled.json"), JSON.stringify({
      schema: "agentloop.disabledSkillSource/v1",
      name: "restricted-demo",
      reason: "license_not_permitted_for_runtime_use",
    }));
    const discovered = await discoverSkillDirectory(fixture.skillDirectory);
    assert.deepEqual(discovered.map((entry) => entry.inspection.name), ["directory-demo"]);
  } finally {
    await removeSkillPackage(fixture.packageStore).catch(() => undefined);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

async function createDirectoryFixture(): Promise<{
  root: string;
  skillDirectory: string;
  sourcePackage: string;
  packageStore: string;
  packageHash: string;
}> {
  const root = await fs.mkdtemp(resolve(tmpdir(), "agentloop-skill-directory-"));
  const skillDirectory = resolve(root, "skills");
  const sourcePackage = resolve(skillDirectory, "directory-demo");
  const packageStore = resolve(root, ".agentloop/skill-packages");
  await fs.mkdir(sourcePackage, { recursive: true });
  const instructions = [
    "---",
    "name: directory-demo",
    "description: A pinned directory-discovery workflow",
    "---",
    "",
    "# Directory Demo",
    "",
    "DIRECTORY-SKILL-SECRET-BODY",
    "",
  ].join("\n");
  await fs.writeFile(resolve(sourcePackage, "SKILL.md"), instructions);
  const inspection = await inspectSkillPackage(sourcePackage);
  return {
    root,
    skillDirectory,
    sourcePackage,
    packageStore,
    packageHash: inspection.packageHash,
  };
}

function directoryPlanner(): Planner {
  return {
    plan: async (task) => {
      assert.equal(task.availableSkills.length, 1);
      const skill = task.availableSkills[0];
      assert.equal(skill.name, "directory-demo");
      assert.match(skill.instructions, /DIRECTORY-SKILL-SECRET-BODY/);
      return {
        goal: "Apply the discovered Skill",
        selectedSkillIds: [skill.id],
        steps: [{
          id: "apply-directory-skill",
          objective: "Load and follow the discovered workflow",
          dependencies: [],
          skillIds: [skill.id],
          requiredToolNames: [],
          successCriteria: [{
            id: "loaded",
            description: "The exact discovered Skill body is loaded before completion",
            source: "planner",
          }],
        }],
      };
    },
  };
}

class DirectorySkillModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.match(request.runtimeContext?.content ?? "", /directory-demo/);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /DIRECTORY-SKILL-SECRET-BODY/);
      assert.ok(request.tools.some((tool) => tool.name === "load_skill"));
      assert.equal(request.tools.some((tool) => tool.name === "computer_write_file"), false);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "load-directory", name: "load_skill", arguments: { name: "directory-demo" } }],
      };
    }
    const loaded = request.messages.find((message) =>
      message.role === "tool" && message.name === "load_skill"
    );
    assert.match(loaded?.content ?? "", /DIRECTORY-SKILL-SECRET-BODY/);
    assert.match(loaded?.content ?? "", /Base directory for this Skill:/);
    assert.match(loaded?.content ?? "", /<skill_package package_sha256=/);
    assert.doesNotMatch(loaded?.content ?? "", /source_url=/);
    return { content: "directory Skill loaded and followed", finishReason: "stop", toolCalls: [] };
  }
}

function approvingAssessor(): StepAssessor {
  return {
    assess: async (input) => ({
      id: randomUUID(),
      planId: input.planId,
      stepId: input.step.id,
      attempt: input.attempt,
      approved: true,
      criteria: input.step.successCriteria.map((criterion) => ({
        criterionId: criterion.id,
        satisfied: true,
        rationale: "Exact load_skill evidence is present",
        evidenceRefs: ["load_skill"],
      })),
      skills: input.skills.map((skill) => ({
        skillId: skill.id,
        followed: true,
        rationale: "The discovered Skill was loaded before completion",
        evidenceRefs: ["load_skill"],
      })),
      evidenceDigest: "directory-test-evidence",
      feedback: "",
      createdAt: Date.now(),
    }),
  };
}
