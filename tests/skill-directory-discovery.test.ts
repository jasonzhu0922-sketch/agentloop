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
import { copySkillPackage, inspectSkillPackage, removeSkillPackage } from "../src/skills/skill-package.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

test("Agent Loop discovers an unlocked Skill directory and exposes the exact package without private provisioning", async () => {
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
    assert.equal(ownerSkills[0].id, "discovered:directory-demo");
    assert.equal(strangerSkills[0].id, "discovered:directory-demo");
    assert.equal(ownerSkills[0].package?.root, fixture.sourcePackage);
    assert.equal(strangerSkills[0].package?.root, fixture.sourcePackage);
    assert.equal(ownerSkills[0].package?.packageHash, fixture.packageHash);

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

test("discovered Skill references stay canonical across admission, grant, and load_skill", async () => {
  const fixture = await createDirectoryFixture();
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database, {
      packageStoreRoot: fixture.packageStore,
      skillDirectory: fixture.skillDirectory,
    });
    const owner = await auth.register("directory-id-owner@example.com", "directory id owner secure password");
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: fixture.root,
      modelFactory: () => new DirectorySkillModel("discovered:directory-demo"),
      plannerFactory: () => directoryReferencePlanner(),
      assessorFactory: () => approvingAssessor(),
    });

    const run = await runs.execute(owner.user.id, "apply the discovered workflow");

    assert.equal(run.status, "completed");
    const plan = runs.plan(owner.user.id, run.id).plan;
    assert.deepEqual(plan.selectedSkillIds, ["discovered:directory-demo"]);
    assert.deepEqual(plan.steps[0].skillIds, ["discovered:directory-demo"]);
    const events = runs.events(owner.user.id, run.id);
    const available = events.find((event) => event.type === "skill.activation.available");
    assert.deepEqual(available?.data.skills, [{
      id: "discovered:directory-demo",
      name: "directory-demo",
      contentHash: fixture.packageHash,
    }]);
    assert.equal(events.some((event) =>
      event.type === "tool.failed"
      && event.data.toolName === "load_skill"
    ), false);
    assert.equal(events.some((event) =>
      event.type === "skill.activated"
      && event.data.skillId === "discovered:directory-demo"
      && event.data.name === "directory-demo"
    ), true);
  } finally {
    database.close();
    await removeSkillPackage(fixture.packageStore).catch(() => undefined);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a discovered Skill directory supersedes an old same-name private Skill record", async () => {
  const fixture = await createDirectoryFixture();
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const owner = await auth.register("directory-shadow@example.com", "directory shadow secure password");
    const skills = new SkillService(database, {
      packageStoreRoot: fixture.packageStore,
      skillDirectory: fixture.skillDirectory,
    });
    skills.create(owner.user.id, {
      name: "directory-demo",
      description: "Old private copy",
      instructions: "OLD-PRIVATE-BODY",
    });

    await skills.refreshSkillDirectory();
    const available = await skills.listAvailable(owner.user.id);
    assert.deepEqual(available.map((skill) => skill.id), ["discovered:directory-demo"]);
    assert.equal(available[0].package?.root, fixture.sourcePackage);

    const resolved = await skills.resolveForConversation(owner.user.id);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].id, "discovered:directory-demo");
    assert.match(resolved[0].instructions, /DIRECTORY-SKILL-SECRET-BODY/);
    assert.doesNotMatch(resolved[0].instructions, /OLD-PRIVATE-BODY/);
    assert.throws(
      () => skills.create(owner.user.id, {
        name: "directory-demo",
        description: "Duplicate private copy",
        instructions: "DUPLICATE",
      }),
      /A discovered Skill named "directory-demo" already exists/,
    );
  } finally {
    database.close();
    await removeSkillPackage(fixture.packageStore).catch(() => undefined);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("startup pruning removes legacy directory package records after source deletion", async () => {
  const fixture = await createDirectoryFixture();
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const owner = await auth.register("legacy-directory-prune@example.com", "legacy directory prune secure password");
    const skills = new SkillService(database, {
      packageStoreRoot: fixture.packageStore,
      skillDirectory: fixture.skillDirectory,
    });
    const inspection = await inspectSkillPackage(fixture.sourcePackage);
    const ownerPackageRoot = resolve(fixture.packageStore, owner.user.id);
    await fs.mkdir(ownerPackageRoot, { recursive: true });
    const copied = await copySkillPackage(inspection, resolve(ownerPackageRoot, randomUUID()));
    const now = Date.now();
    database.prepare(`
      INSERT INTO skills(
        id, owner_user_id, name, description, instructions, source_kind,
        source_url, source_revision, package_root, entrypoint_path,
        package_hash, package_file_count, package_total_bytes,
        content_hash, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'package', NULL, NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      "legacy-directory-demo",
      owner.user.id,
      copied.name,
      copied.description,
      copied.instructions,
      copied.root,
      copied.entrypointPath,
      copied.packageHash,
      copied.fileCount,
      copied.totalBytes,
      copied.packageHash,
      now,
      now,
    );

    await fs.rm(fixture.sourcePackage, { recursive: true, force: true });
    await skills.refreshSkillDirectory();
    assert.deepEqual((await skills.listAvailable(owner.user.id)).map((skill) => skill.id), ["legacy-directory-demo"]);

    const pruned = await skills.pruneLegacyDirectoryPackageSkills();

    assert.equal(pruned, 1);
    assert.deepEqual(await skills.listAvailable(owner.user.id), []);
    await assert.rejects(() => fs.stat(copied.root), /ENOENT/);
  } finally {
    database.close();
    await removeSkillPackage(fixture.packageStore).catch(() => undefined);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("RunService refreshes the discovered Skill directory before planning a new Run", async () => {
  const fixture = await createDirectoryFixture();
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const owner = await auth.register("directory-refresh@example.com", "directory refresh secure password");
    const skills = new SkillService(database, {
      packageStoreRoot: fixture.packageStore,
      skillDirectory: fixture.skillDirectory,
    });
    await skills.refreshSkillDirectory();
    await fs.writeFile(resolve(fixture.sourcePackage, "SKILL.md"), [
      "---",
      "name: directory-demo",
      "description: Query an internal API catalog for source-grounded API parameter information.",
      "agentloop:",
      "  roles:",
      "    - source_provider",
      "  artifactKinds:",
      "    - none",
      "  sourceKinds:",
      "    - api",
      "  qaKinds: []",
      "---",
      "",
      "# Directory Demo",
      "",
      "UPDATED-SOURCE-PROVIDER-BODY",
      "",
    ].join("\n"));

    const runs = new RunService({
      database,
      skills,
      workspaceRoot: fixture.root,
      modelFactory: () => new RefreshedDirectorySkillModel(),
      plannerFactory: () => refreshedDirectoryPlanner(),
      assessorFactory: () => approvingAssessor(),
    });
    const run = await runs.execute(owner.user.id, "查询宝武集团数据中台中合同备案 API 的参数信息");

    assert.equal(run.status, "completed");
    const plan = runs.plan(owner.user.id, run.id).plan;
    assert.deepEqual(plan.selectedSkillIds, ["discovered:directory-demo"]);
    const selectedEvent = runs.events(owner.user.id, run.id).find((event) =>
      event.type === "planning.skills.role_selected"
    );
    assert.deepEqual(selectedEvent?.data.skills, [{
      id: "discovered:directory-demo",
      name: "directory-demo",
      role: "source_provider",
      reason: "Skill metadata declares source_provider for requested source-grounded work.",
    }]);
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
    "agentloop:",
    "  roles:",
    "    - primary_builder",
    "  artifactKinds:",
    "    - none",
    "  sourceKinds: []",
    "  qaKinds: []",
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
    sourcePackage: inspection.root,
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
          recommendedToolNames: [],
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

function directoryReferencePlanner(): Planner {
  return {
    plan: async (task) => {
      assert.equal(task.availableSkills.length, 1);
      const skill = task.availableSkills[0];
      assert.equal(skill.id, "discovered:directory-demo");
      assert.equal(skill.name, "directory-demo");
      return {
        goal: "Apply the discovered Skill",
        selectedSkillIds: [skill.name],
        steps: [{
          id: "apply-directory-skill",
          objective: "Load and follow the discovered workflow",
          dependencies: [],
          skillIds: [skill.name],
          recommendedToolNames: [],
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

function refreshedDirectoryPlanner(): Planner {
  return {
    plan: async (task) => {
      assert.equal(task.availableSkills.length, 1);
      const skill = task.availableSkills[0];
      assert.equal(skill.id, "discovered:directory-demo");
      assert.equal(skill.name, "directory-demo");
      assert.match(skill.instructions, /UPDATED-SOURCE-PROVIDER-BODY/);
      assert.deepEqual(skill.agentLoop, {
        roles: ["source_provider"],
        artifactKinds: ["none"],
        sourceKinds: ["api"],
        qaKinds: [],
      });
      assert.deepEqual(task.selectedSkillRoles, [{
        skillId: skill.id,
        role: "source_provider",
        reason: "Skill metadata declares source_provider for requested source-grounded work.",
      }]);
      return {
        goal: "Query the internal API catalog",
        selectedSkillRoles: task.selectedSkillRoles,
        selectedSkillIds: [skill.id],
        steps: [{
          id: "query-api-catalog",
          objective: "Load and apply the source-provider Skill to query API parameter information",
          dependencies: [],
          role: "produce",
          skillIds: [skill.id],
          recommendedToolNames: [],
          successCriteria: [{
            id: "loaded",
            description: "The refreshed discovered Skill body is loaded before completion",
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
  private readonly loadSkillArgument: string;

  constructor(loadSkillArgument = "directory-demo") {
    this.loadSkillArgument = loadSkillArgument;
  }

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
        toolCalls: [{ id: "load-directory", name: "load_skill", arguments: { name: this.loadSkillArgument } }],
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

class RefreshedDirectorySkillModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.match(request.runtimeContext?.content ?? "", /directory-demo/);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /UPDATED-SOURCE-PROVIDER-BODY/);
      assert.ok(request.tools.some((tool) => tool.name === "load_skill"));
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "load-refreshed-directory", name: "load_skill", arguments: { name: "directory-demo" } }],
      };
    }
    const loaded = request.messages.find((message) =>
      message.role === "tool" && message.name === "load_skill"
    );
    assert.match(loaded?.content ?? "", /UPDATED-SOURCE-PROVIDER-BODY/);
    return { content: "refreshed directory Skill loaded and followed", finishReason: "stop", toolCalls: [] };
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
