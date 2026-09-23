import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const run = promisify(execFile);

test("bundled DOCX report builder normalizes table widths and emits a report receipt", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-docx-builder-"));
  try {
    const specPath = join(root, "report-spec.json");
    const outputPath = join(root, "report.docx");
    await fs.writeFile(specPath, JSON.stringify({
      schema: "agentloop.docxReportSpec/v1",
      title: "Bounded report",
      outputPath,
      sections: [{
        heading: "Summary",
        paragraphs: ["The builder owns layout invariants."],
        bullets: ["One bounded item"],
        tables: [{
          columns: [{ header: "Metric", width: 40 }, { header: "Value", width: 60 }],
          rows: [["Count", "3"]],
        }],
      }],
    }), "utf8");
    const result = await run(process.execPath, [
      join(import.meta.dirname, "../skills/docx/scripts/build_report.cjs"),
      specPath,
      outputPath,
    ]);
    const receipt = JSON.parse(result.stdout) as { schema: string; bytes: number; sha256: string };
    assert.equal(receipt.schema, "agentloop.docxBuild/v1");
    assert.ok(receipt.bytes > 0);
    assert.match(receipt.sha256, /^[0-9a-f]{64}$/u);
    const output = await fs.readFile(outputPath);
    assert.deepEqual(output.subarray(0, 2), Buffer.from("PK"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bundled DOCX report builder rejects mismatched table rows before writing", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-docx-builder-invalid-"));
  try {
    const specPath = join(root, "invalid.json");
    const outputPath = join(root, "invalid.docx");
    await fs.writeFile(specPath, JSON.stringify({
      schema: "agentloop.docxReportSpec/v1",
      outputPath,
      sections: [{ tables: [{ columns: [{ header: "Only one" }], rows: [["a", "extra"]] }] }],
    }), "utf8");
    await assert.rejects(
      () => run(process.execPath, [join(import.meta.dirname, "../skills/docx/scripts/build_report.cjs"), specPath, outputPath]),
      (error: unknown) => error !== null && typeof error === "object"
        && "stderr" in error && String((error as { stderr?: unknown }).stderr).includes("row width does not match columns"),
    );
    await assert.rejects(() => fs.access(outputPath));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
