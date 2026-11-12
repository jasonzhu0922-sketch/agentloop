import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { removeSkillPackage } from "@zhujun/agentloop";
import { createLocalRuntimeManager } from "@zhujun/agentloop-local-runtime";
import { greetingModel, modelPort } from "./fixtures/models.ts";
import { importSkillFiles, readSkillZip } from "../dist/configuration/skill-import.js";

// Real ZIP bytes: one Skill plus Finder __MACOSX sidecars and .DS_Store.
const finderZip = Buffer.from("UEsDBBQAAAAIACGbal2jVV8VNQAAAEIAAAAWAAAAZGF0YS1hbmFseXNpcy9TS0lMTC5tZNPV1eXKS8xNtVJISSxJ1E3MS8ypLM4s5kpJLU4uyiwoyczPs1IISS0uUYBL6QK1KCs4wrgAUEsDBBQAAAAIACGbal0GHuE8CwAAAAkAAAAcAAAAZGF0YS1hbmFseXNpcy9zY3JpcHRzL3J1bi5weSsoyswr0TDU5AIAUEsDBBQAAAAIACGbal3mNOvJCAAAAAYAAAAXAAAAZGF0YS1hbmFseXNpcy8uRFNfU3RvcmVLy8xLSS0CAFBLAwQUAAAACAAhm2pdFDQUTwoAAAAIAAAAGAAAAF9fTUFDT1NYLy5fZGF0YS1hbmFseXNpc8tNLUlMSSxJBABQSwMEFAAAAAgAIZtqXRQ0FE8KAAAACAAAACEAAABfX01BQ09TWC9kYXRhLWFuYWx5c2lzLy5fU0tJTEwubWTLTS1JTEksSQQAUEsBAhQDFAAAAAgAIZtqXaNVXxU1AAAAQgAAABYAAAAAAAAAAAAAAIABAAAAAGRhdGEtYW5hbHlzaXMvU0tJTEwubWRQSwECFAMUAAAACAAhm2pdBh7hPAsAAAAJAAAAHAAAAAAAAAAAAAAAgAFpAAAAZGF0YS1hbmFseXNpcy9zY3JpcHRzL3J1bi5weVBLAQIUAxQAAAAIACGbal3mNOvJCAAAAAYAAAAXAAAAAAAAAAAAAACAAa4AAABkYXRhLWFuYWx5c2lzLy5EU19TdG9yZVBLAQIUAxQAAAAIACGbal0UNBRPCgAAAAgAAAAYAAAAAAAAAAAAAACAAesAAABfX01BQ09TWC8uX2RhdGEtYW5hbHlzaXNQSwECFAMUAAAACAAhm2pdFDQUTwoAAAAIAAAAIQAAAAAAAAAAAAAAgAErAQAAX19NQUNPU1gvZGF0YS1hbmFseXNpcy8uX1NLSUxMLm1kUEsFBgAAAAAFAAUAaAEAAHQBAAAAAA==", "base64");

test("Finder ZIP metadata does not break Skill ownership or change package contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-finder-import-"));
  try {
    const files = readSkillZip(finderZip);
    const [installed] = await importSkillFiles(root, files);
    assert.equal(installed?.inspection.name, "data-analysis");
    assert.deepEqual([...installed!.inspection.files].sort(), ["SKILL.md", "scripts/run.py"]);
    assert.equal(await readFile(join(installed!.root, "scripts/run.py"), "utf8"), "print(1)\n");
    const [directory] = await importSkillFiles(root, files.filter(file => !file.path.startsWith("__MACOSX/")));
    assert.equal(directory?.storageKey, installed?.storageKey);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("metadata is still path-validated and unrelated files still reject the archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-finder-invalid-"));
  const skill = { path: "data-analysis/SKILL.md", content: Buffer.from("---\nname: data-analysis\ndescription: analysis\n---\n") };
  try {
    for (const path of ["__MACOSX/../outside", "unrelated.txt"]) {
      await assert.rejects(importSkillFiles(root, [skill, { path, content: Buffer.from("x") }]), { code: "skill_import_invalid" });
    }
    await assert.rejects(importSkillFiles(root, [{ path: "__MACOSX/._SKILL.md", content: Buffer.from("x") }]), { code: "skill_import_invalid" });
    await assert.rejects(importSkillFiles(root, [skill, { path: "data-analysis/agentloop.executors.json", content: Buffer.from('{"schema":"invalid"}') }]), { code: "skill_import_invalid" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ZIP and directory imports share model recognition and publish the same declaration to Runtime discovery", async t => {
  const root = await mkdtemp(join(tmpdir(), "skill-model-import-"));
  const bundled = join(root, "bundled"); await mkdir(bundled);
  let calls = 0;
  const manager = await createLocalRuntimeManager({ dataDirectory: root, defaultRuntimeId: "default", bundledSkillDirectories: [bundled],
    models: modelPort({ ...greetingModel(), async complete(input) {
      calls++;
      assert.deepEqual(input.tools, []);
      const request = JSON.parse(input.messages[0]!.content);
      assert.equal(request.package.name, "data-analysis"); assert.ok(request.package.instructions.length);
      const baseline = request.deterministicBaseline;
      return { content: JSON.stringify({ ...baseline, activation: { semanticTags: ["model-identified"], intentExamples: ["分析业务数据"] },
        workflow: { ...baseline.workflow, roles: ["primary_builder"], sourceKinds: ["dataset"] } }), toolCalls: [], finishReason: "stop" };
    } }),
  });
  t.after(async () => { await manager.close(); await removeSkillPackage(root); });
  const [zip] = await manager.importSkills({ zip: finderZip });
  assert.equal(zip!.metadataGenerationMethod, "deterministic+model"); assert.equal(zip!.metadataModelKey, "local:test");
  assert.equal(zip!.metadataGenerationStatus, "completed");
  const first = await manager.skillMetadata(zip!.packageId);
  const [directory] = await manager.importSkills({ files: readSkillZip(finderZip) });
  const second = await manager.skillMetadata(directory!.packageId);
  assert.equal(calls, 2); assert.equal(directory!.packageId, zip!.packageId);
  assert.equal(first.packageHash, second.packageHash); assert.deepEqual(first.declaration, second.declaration);
  assert.equal(await readFile(join(root, "skill-library", `uploaded-${first.packageHash}`, "scripts/run.py"), "utf8"), "print(1)\n");
  await manager.stopRuntime("default");
  await manager.configureRuntime("default", { skillPackageIds: [zip!.packageId], mcpServerIds: [] });
  await manager.startRuntime("default");
  const db = new DatabaseSync(join(root, "runtime.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT agent_loop_json, package_hash FROM discovered_skills WHERE name = ?").get("data-analysis") as { agent_loop_json: string; package_hash: string };
    assert.deepEqual(JSON.parse(row.agent_loop_json).roles, ["primary_builder"]);
    assert.deepEqual(JSON.parse(row.agent_loop_json).semanticTags, ["model-identified"]);
    assert.equal(row.package_hash, first.packageHash);
  } finally { db.close(); }
});
