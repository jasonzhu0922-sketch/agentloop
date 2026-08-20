import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts";
import { ComputerExecutor } from "../src/computer/computer-executor.ts";
import type { StepAssessor } from "../src/planning/contracts.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { inspectSkillPackage, removeSkillPackage } from "../src/skills/skill-package.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

const SOURCE_URL = "https://example.com/acme/existing-skill";
const SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";

test("standard YAML block scalar descriptions survive Skill package inspection", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-package-block-frontmatter-"));
  try {
    const source = [
      "---",
      "name: block-description",
      "description: |-",
      "  Reference for a provider API and its SDK.",
      "  Load this Skill before planning provider-specific work.",
      "license: Complete terms in LICENSE.txt",
      "---",
      "",
      "# Provider API",
      "",
    ].join("\n");
    await fs.writeFile(join(workspace, "SKILL.md"), source);
    const inspected = await inspectSkillPackage(workspace);
    assert.equal(
      inspected.description,
      "Reference for a provider API and its SDK.\nLoad this Skill before planning provider-specific work.",
    );
    assert.equal(inspected.instructions, source);
  } finally {
    await removeSkillPackage(workspace);
  }
});

test("an existing Skill package is copied byte-for-byte, hashed as a whole, and made read-only", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-package-"));
  const imports = join(workspace, "imports");
  const source = join(imports, "existing-skill");
  const store = join(workspace, "managed-packages");
  const database = new AppDatabase(":memory:");
  try {
    const skillSource = [
      "---",
      "name: existing-skill",
      'description: "An unchanged third-party Skill"',
      "---",
      "",
      "# Existing Skill",
      "",
      "Read `references/rules.md` before execution.",
      "",
    ].join("\n");
    await fs.mkdir(join(source, "references"), { recursive: true });
    await fs.mkdir(join(source, "scripts"), { recursive: true });
    await fs.writeFile(join(source, "SKILL.md"), skillSource);
    await fs.writeFile(join(source, "references/rules.md"), "ORIGINAL-RULE\n");
    await fs.writeFile(join(source, "scripts/run.mjs"), "process.stdout.write('original')\n");

    const expected = await inspectSkillPackage(source);
    const auth = new AuthService(database);
    const owner = await auth.register("package-owner@example.com", "package owner secure password");
    const skills = new SkillService(database, { packageStoreRoot: store, allowedImportRoots: [imports] });
    const installed = await skills.installFromDirectory(owner.user.id, {
      sourceDirectory: source,
      sourceUrl: SOURCE_URL,
      sourceRevision: SOURCE_REVISION,
      expectedPackageHash: expected.packageHash,
    });

    assert.equal(installed.sourceKind, "package");
    assert.equal(installed.instructions, skillSource);
    assert.equal(installed.contentHash, expected.packageHash);
    assert.equal(installed.package?.packageHash, expected.packageHash);
    assert.equal(installed.package?.fileCount, 3);
    assert.equal(await fs.readFile(join(installed.package!.root, "references/rules.md"), "utf8"), "ORIGINAL-RULE\n");
    assert.equal((await fs.stat(join(installed.package!.root, "SKILL.md"))).mode & 0o222, 0);
    await skills.assertIntegrity([installed]);

    const executor = new ComputerExecutor(workspace, { readOnlyRoots: [store] });
    await assert.rejects(
      () => executor.writeFile(relative(workspace, join(installed.package!.root, "SKILL.md")), "changed", true),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );
    assert.equal(await fs.readFile(join(source, "SKILL.md"), "utf8"), skillSource);
  } finally {
    database.close();
    await removeSkillPackage(workspace);
  }
});

test("package integrity failure stops a Run instead of silently accepting a modified Skill", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-package-mutation-"));
  const imports = join(workspace, "imports");
  const source = join(imports, "immutable-skill");
  const store = join(workspace, "managed-packages");
  const database = new AppDatabase(":memory:");
  try {
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(join(source, "SKILL.md"), [
      "---",
      "name: immutable-skill",
      "description: Detect package mutation",
      "---",
      "ORIGINAL-INSTRUCTION",
      "",
    ].join("\n"));
    const auth = new AuthService(database);
    const owner = await auth.register("mutation@example.com", "mutation secure password");
    const skills = new SkillService(database, { packageStoreRoot: store, allowedImportRoots: [imports] });
    const expected = await inspectSkillPackage(source);
    const installed = await skills.installFromDirectory(owner.user.id, {
      sourceDirectory: source,
      sourceUrl: SOURCE_URL,
      sourceRevision: SOURCE_REVISION,
      expectedPackageHash: expected.packageHash,
    });
    await fs.chmod(installed.package!.root, 0o700);
    await fs.chmod(join(installed.package!.root, "SKILL.md"), 0o600);
    await fs.appendFile(join(installed.package!.root, "SKILL.md"), "MUTATED\n");

    await assert.rejects(
      () => skills.assertIntegrity([installed]),
      (error: unknown) => hasCode(error, "SKILL_PACKAGE_MUTATED"),
    );
  } finally {
    database.close();
    await removeSkillPackage(workspace);
  }
});

test("package installation rejects an untrusted digest and symbolic-link contents", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-package-reject-"));
  const imports = join(workspace, "imports");
  const source = join(imports, "unsafe-skill");
  const store = join(workspace, "managed-packages");
  const database = new AppDatabase(":memory:");
  try {
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(join(source, "SKILL.md"), [
      "---",
      "name: unsafe-skill",
      "description: Reject untrusted package content",
      "---",
      "instruction",
      "",
    ].join("\n"));
    const auth = new AuthService(database);
    const owner = await auth.register("reject@example.com", "reject package secure password");
    const skills = new SkillService(database, { packageStoreRoot: store, allowedImportRoots: [imports] });
    await assert.rejects(
      () => skills.installFromDirectory(owner.user.id, {
        sourceDirectory: source,
        sourceUrl: SOURCE_URL,
        sourceRevision: SOURCE_REVISION,
        expectedPackageHash: "0".repeat(64),
      }),
      (error: unknown) => hasCode(error, "SKILL_PACKAGE_INVALID"),
    );

    await fs.symlink("SKILL.md", join(source, "linked-skill.md"));
    await assert.rejects(
      () => inspectSkillPackage(source),
      (error: unknown) => hasCode(error, "SKILL_PACKAGE_INVALID"),
    );
  } finally {
    database.close();
    await removeSkillPackage(workspace);
  }
});

test("package admission rejects a SKILL.md that cannot be disclosed without truncation", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-package-oversized-skill-"));
  try {
    await fs.writeFile(join(workspace, "SKILL.md"), [
      "---",
      "name: oversized-skill",
      "description: Must not be silently truncated during disclosure",
      "---",
      "x".repeat(200_000),
    ].join("\n"));
    await assert.rejects(
      () => inspectSkillPackage(workspace),
      (error: unknown) => hasCode(error, "SKILL_PACKAGE_INVALID"),
    );
  } finally {
    await removeSkillPackage(workspace);
  }
});

test("the admitted step receives the unchanged package Skill and persists package verification events", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-package-run-"));
  const imports = join(workspace, "imports");
  const source = join(imports, "runtime-package");
  const store = join(workspace, "managed-packages");
  const database = new AppDatabase(":memory:");
  try {
    await fs.mkdir(join(source, "references"), { recursive: true });
    await fs.writeFile(join(source, "SKILL.md"), [
      "---",
      "name: runtime-package",
      "description: Existing runtime package",
      "---",
      "PACKAGE-INSTRUCTION-MUST-STAY-EXACT",
      "Read `references/proof.md`.",
      "",
    ].join("\n"));
    await fs.writeFile(join(source, "references/proof.md"), "proof\n");
    const auth = new AuthService(database);
    const owner = await auth.register("package-run@example.com", "package run secure password");
    const skills = new SkillService(database, { packageStoreRoot: store, allowedImportRoots: [imports] });
    const expected = await inspectSkillPackage(source);
    const installed = await skills.installFromDirectory(owner.user.id, {
      sourceDirectory: source,
      sourceUrl: SOURCE_URL,
      sourceRevision: SOURCE_REVISION,
      expectedPackageHash: expected.packageHash,
    });
    const model = new InspectPackageModel(
      installed.package!.root,
      installed.package!.packageHash,
    );
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingAssessor(),
      workspaceRoot: workspace,
    });
    const run = await runs.execute(owner.user.id, "use installed package");

    assert.equal(run.status, "completed");
    assert.equal(model.sawUnchangedInstruction, true);
    assert.equal(model.sawPackageEnvelope, true);
    const verified = runs.events(owner.user.id, run.id).filter((event) => event.type === "skill.package.verified");
    assert.deepEqual(verified.map((event) => event.data.phase), ["run-start", "terminal"]);
    assert.ok(verified.every((event) => event.data.packageHash === installed.package!.packageHash));
  } finally {
    database.close();
    await removeSkillPackage(workspace);
  }
});

class InspectPackageModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  sawUnchangedInstruction = false;
  sawPackageEnvelope = false;
  private readonly packageRoot: string;
  private readonly packageHash: string;
  private calls = 0;

  constructor(packageRoot: string, packageHash: string) {
    this.packageRoot = packageRoot;
    this.packageHash = packageHash;
  }

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.doesNotMatch(request.systemPrompt, /PACKAGE-INSTRUCTION-MUST-STAY-EXACT/);
      assert.ok(request.tools.some((tool) => tool.name === "load_skill"));
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "load-package", name: "load_skill", arguments: { name: "runtime-package" } }],
      };
    }
    const loaded = request.messages.find((message) => message.role === "tool" && message.name === "load_skill");
    this.sawUnchangedInstruction = (loaded?.content.includes("PACKAGE-INSTRUCTION-MUST-STAY-EXACT") ?? false)
      && !(loaded?.content.includes("MUTATED") ?? false);
    this.sawPackageEnvelope = (loaded?.content.includes(`Base directory for this Skill: ${this.packageRoot}`) ?? false)
      && (loaded?.content.includes(`package_sha256=\"${this.packageHash}\"`) ?? false)
      && (loaded?.content.includes('read_only="true"') ?? false);
    return { content: "package instruction followed", toolCalls: [], finishReason: "stop" };
  }
}

function approvingAssessor(): StepAssessor {
  return {
    assess: async (input) => ({
      id: "assessment",
      planId: input.planId,
      stepId: input.step.id,
      attempt: input.attempt,
      approved: true,
      criteria: input.step.successCriteria.map((criterion) => ({
        criterionId: criterion.id,
        satisfied: true,
        rationale: "Verified by the focused test assessor",
        evidenceRefs: ["candidateOutput"],
      })),
      skills: input.skills.map((skill) => ({
        skillId: skill.id,
        followed: true,
        rationale: "The test model loaded and applied the exact Skill body",
        evidenceRefs: ["load_skill"],
      })),
      evidenceDigest: "test-evidence",
      feedback: "",
      createdAt: Date.now(),
    }),
  };
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code: unknown }).code === code;
}
