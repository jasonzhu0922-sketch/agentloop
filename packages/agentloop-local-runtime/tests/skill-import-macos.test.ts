import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importSkillFiles, readSkillZip } from "../dist/configuration/skill-import.js";

// Real ZIP bytes: one Skill plus Finder __MACOSX sidecars and .DS_Store.
const finderZip = Buffer.from("UEsDBBQAAAAIACGbal2jVV8VNQAAAEIAAAAWAAAAZGF0YS1hbmFseXNpcy9TS0lMTC5tZNPV1eXKS8xNtVJISSxJ1E3MS8ypLM4s5kpJLU4uyiwoyczPs1IISS0uUYBL6QK1KCs4wrgAUEsDBBQAAAAIACGbal0GHuE8CwAAAAkAAAAcAAAAZGF0YS1hbmFseXNpcy9zY3JpcHRzL3J1bi5weSsoyswr0TDU5AIAUEsDBBQAAAAIACGbal3mNOvJCAAAAAYAAAAXAAAAZGF0YS1hbmFseXNpcy8uRFNfU3RvcmVLy8xLSS0CAFBLAwQUAAAACAAhm2pdFDQUTwoAAAAIAAAAGAAAAF9fTUFDT1NYLy5fZGF0YS1hbmFseXNpc8tNLUlMSSxJBABQSwMEFAAAAAgAIZtqXRQ0FE8KAAAACAAAACEAAABfX01BQ09TWC9kYXRhLWFuYWx5c2lzLy5fU0tJTEwubWTLTS1JTEksSQQAUEsBAhQDFAAAAAgAIZtqXaNVXxU1AAAAQgAAABYAAAAAAAAAAAAAAIABAAAAAGRhdGEtYW5hbHlzaXMvU0tJTEwubWRQSwECFAMUAAAACAAhm2pdBh7hPAsAAAAJAAAAHAAAAAAAAAAAAAAAgAFpAAAAZGF0YS1hbmFseXNpcy9zY3JpcHRzL3J1bi5weVBLAQIUAxQAAAAIACGbal3mNOvJCAAAAAYAAAAXAAAAAAAAAAAAAACAAa4AAABkYXRhLWFuYWx5c2lzLy5EU19TdG9yZVBLAQIUAxQAAAAIACGbal0UNBRPCgAAAAgAAAAYAAAAAAAAAAAAAACAAesAAABfX01BQ09TWC8uX2RhdGEtYW5hbHlzaXNQSwECFAMUAAAACAAhm2pdFDQUTwoAAAAIAAAAIQAAAAAAAAAAAAAAgAErAQAAX19NQUNPU1gvZGF0YS1hbmFseXNpcy8uX1NLSUxMLm1kUEsFBgAAAAAFAAUAaAEAAHQBAAAAAA==", "base64");

test("Finder ZIP metadata does not break Skill ownership or change package contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-finder-import-"));
  try {
    const files = readSkillZip(finderZip);
    const [installed] = await importSkillFiles(root, files);
    assert.equal(installed?.inspection.name, "data-analysis");
    assert.deepEqual(installed?.inspection.files.sort(), ["SKILL.md", "scripts/run.py"]);
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
  } finally { await rm(root, { recursive: true, force: true }); }
});
