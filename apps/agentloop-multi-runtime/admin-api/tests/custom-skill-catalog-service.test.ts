import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CustomSkillCatalogApplicationService } from "../src/application/custom-skill-catalog-service.ts";
import { ControlPlaneError } from "../../control-plane/domain/index.ts";

test("custom Skill catalog paginates and exposes metadata, SKILL.md, and relative file structure", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-admin-skills-"));
  try {
    for (const [name, version] of [["alpha", "1.2.0"], ["beta", "2.0.0"], ["gamma", "3.0.0"]] as const) {
      const skill = join(root, name);
      await mkdir(join(skill, "scripts"), { recursive: true });
      await mkdir(join(skill, "references"), { recursive: true });
      await writeFile(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\nmetadata:\n  version: "${version}"\nagentloop:\n  roles:\n    - primary_builder\n  artifactKinds:\n    - code\n  sourceKinds: []\n  qaKinds: []\n---\n\n# ${name}\n\nclientSecret: "not-for-browser"\nKey instructions.\n`);
      await writeFile(join(skill, "scripts", "run.py"), "print('ok')\n");
      await writeFile(join(skill, "references", "guide.md"), "reference\n");
    }
    const service = new CustomSkillCatalogApplicationService([root]);
    const first = await service.list(1, 2);
    assert.deepEqual(first.items.map((item) => item.name), ["alpha", "beta"]);
    assert.equal(first.total, 3);
    assert.equal(first.pageCount, 2);
    const detail = await service.detail("alpha");
    assert.equal(detail?.version, "1.2.0");
    assert.match(detail?.skillMd ?? "", /Key instructions/);
    assert.match(detail?.skillMd ?? "", /clientSecret: "\[REDACTED\]"/);
    assert.doesNotMatch(detail?.skillMd ?? "", /not-for-browser/);
    assert.deepEqual(detail?.files, ["references/guide.md", "scripts/run.py", "SKILL.md"]);
    assert.equal(await service.detail("missing"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom Skill catalog reports an unavailable source directory as configuration error", async () => {
  const service = new CustomSkillCatalogApplicationService([join(tmpdir(), "agentloop-admin-skills-does-not-exist")]);
  await assert.rejects(service.list(1, 12), (error: unknown) => error instanceof ControlPlaneError && error.code === "configuration_unavailable");
});
