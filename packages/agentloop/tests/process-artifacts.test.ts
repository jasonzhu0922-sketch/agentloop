import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectProcessArtifacts, previewProcessArtifact } from "../src/runtime/process-artifacts.ts";
import type { StoredRunEvent } from "../src/runtime/run-service.ts";

const require = createRequire(import.meta.url);
const JSZip = require("jszip") as { new(): { file(path: string, content: string): unknown; generateAsync(options: { type: "nodebuffer" }): Promise<Buffer> } };

test("process artifacts mark accepted artifacts as final and leave candidates as process", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-process-artifacts-"));
  try {
    await fs.writeFile(join(root, "draft.html"), "<html><body>draft</body></html>");
    await fs.writeFile(join(root, "final.html"), "<html><body>final</body></html>");
    const runCreatedAt = Date.now() - 1_000;
    const events: StoredRunEvent[] = [
      event(1, "tool.completed", {
        toolName: "computer_run_command",
        result: JSON.stringify({
          exitCode: 0,
          stdout: "created draft.html and final.html",
          fileChanges: [
            { path: "draft.html", changeType: "created" },
            { path: "final.html", changeType: "created" },
          ],
        }),
      }),
      event(2, "tool.completed", {
        toolName: "computer_write_file",
        result: JSON.stringify({ path: "draft.html", bytes: 31 }),
      }),
      event(3, "tool.completed", {
        toolName: "computer_write_file",
        result: JSON.stringify({ path: "final.html", bytes: 31 }),
      }),
      event(4, "tool.completed", {
        toolName: "verify_artifact_acceptance",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.artifactAcceptance/v1",
          artifact: { path: "final.html", requestedPath: "final.html" },
          verdict: "caveated",
          evidenceKinds: {
            satisfied: ["artifact_acceptance", "artifact_openable", "artifact_path"],
            caveated: ["explicit_caveats"],
            failed: [],
          },
        }),
      }),
      event(5, "tool.completed", {
        toolName: "verify_artifact_acceptance",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.artifactAcceptance/v1",
          artifact: { path: "draft.html", requestedPath: "draft.html" },
          verdict: "rejected",
          evidenceKinds: {
            satisfied: ["artifact_path"],
            caveated: [],
            failed: ["artifact_acceptance"],
          },
        }),
      }),
    ];

    const artifacts = await collectProcessArtifacts({
      runId: "run-artifacts",
      workspaceRoot: root,
      runCreatedAt,
      events,
    });

    assert.deepEqual(artifacts.map((artifact) => artifact.path), ["draft.html", "final.html"]);
    const draft = artifacts.find((artifact) => artifact.path === "draft.html");
    const final = artifacts.find((artifact) => artifact.path === "final.html");
    assert.equal(draft?.role, "process");
    assert.equal(draft?.sourceTool, "computer_write_file");
    assert.equal(final?.role, "final");
    assert.equal(final?.sourceTool, "computer_write_file");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("process artifacts exclude stdout and stderr captures from the artifact catalog", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-process-log-captures-"));
  try {
    await fs.writeFile(join(root, "report.md"), "# report\n");
    await fs.writeFile(join(root, "run.stdout.txt"), "stdout\n");
    await fs.writeFile(join(root, "run.stderr.txt"), "stderr\n");
    const artifacts = await collectProcessArtifacts({
      runId: "run-log-captures",
      workspaceRoot: root,
      runCreatedAt: Date.now() - 1_000,
      events: [event(1, "tool.completed", {
        toolName: "computer_run_command",
        result: JSON.stringify({
          exitCode: 0,
          stdout: "created report.md",
          fileChanges: [
            { path: "report.md", changeType: "created" },
            { path: "run.stdout.txt", changeType: "created" },
            { path: "run.stderr.txt", changeType: "created" },
          ],
        }),
      })],
    });
    assert.deepEqual(artifacts.map((artifact) => artifact.path), ["report.md"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("approved conversation candidates promote generated user-facing files without promoting source scripts", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-process-approved-candidate-"));
  try {
    await fs.writeFile(join(root, "generate-report.cjs"), "console.log('report')");
    await fs.writeFile(join(root, "report.docx"), Buffer.from("docx-bytes"));
    const runCreatedAt = Date.now() - 1_000;
    const events: StoredRunEvent[] = [
      event(1, "tool.completed", {
        toolName: "computer_run_command",
        result: JSON.stringify({
          exitCode: 0,
          stdout: "Report generated: report.docx",
          fileChanges: [
            { path: "generate-report.cjs", changeType: "created" },
            { path: "report.docx", changeType: "created", bytes: 10 },
          ],
        }),
      }),
      event(2, "candidate.approved", { step: 1, output: "报告已生成并通过当前步骤验收。" }),
    ];

    const artifacts = await collectProcessArtifacts({
      runId: "run-approved-candidate",
      workspaceRoot: root,
      runCreatedAt,
      events,
      promoteProducedArtifacts: true,
    });

    assert.equal(artifacts.find((artifact) => artifact.path === "report.docx")?.role, "final");
    assert.equal(artifacts.find((artifact) => artifact.path === "generate-report.cjs")?.role, "process");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("process artifacts include converted outputs from convert_artifact", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-process-converted-artifacts-"));
  try {
    await fs.mkdir(join(root, "deliverables"), { recursive: true });
    await fs.writeFile(join(root, "deliverables", "report.pdf"), "%PDF-1.4\n%%EOF\n");
    const runCreatedAt = Date.now() - 1_000;
    const events: StoredRunEvent[] = [
      event(1, "tool.completed", {
        toolName: "convert_artifact",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.artifactConversion/v1",
          source: { path: "report.md", format: "markdown" },
          output: { path: "deliverables/report.pdf", format: "pdf", bytes: 15 },
          artifactReceipt: {
            schema: "agentloop.artifactReceipt/v1",
            sourceTool: "convert_artifact",
            artifact: { path: "deliverables/report.pdf", acceptanceProfile: "pdf" },
          },
        }),
      }),
      event(2, "tool.completed", {
        toolName: "verify_artifact_acceptance",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.artifactAcceptance/v1",
          artifact: { path: "deliverables/report.pdf" },
          verdict: "accepted",
          evidenceKinds: {
            satisfied: ["artifact_acceptance", "artifact_openable", "artifact_path"],
            caveated: [],
            failed: [],
          },
        }),
      }),
    ];

    const artifacts = await collectProcessArtifacts({
      runId: "run-converted-artifacts",
      workspaceRoot: root,
      runCreatedAt,
      events,
    });

    assert.deepEqual(artifacts.map((artifact) => artifact.path), ["deliverables/report.pdf"]);
    assert.equal(artifacts[0].role, "final");
    assert.equal(artifacts[0].sourceTool, "convert_artifact");
    assert.equal(artifacts[0].mimeType, "application/pdf");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("DOCX preview preserves page geometry, run styles, numbering, and tables", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-process-docx-preview-"));
  try {
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="1F4E79"/></w:rPr><w:t>标题</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"/></w:sectPr></w:body></w:document>`);
    zip.file("word/numbering.xml", "<w:numbering xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:abstractNum w:abstractNumId=\"0\"><w:lvl w:ilvl=\"0\"><w:numFmt w:val=\"bullet\"/></w:lvl></w:abstractNum><w:num w:numId=\"1\"><w:abstractNumId w:val=\"0\"/></w:num></w:numbering>");
    await fs.writeFile(join(root, "report.docx"), await zip.generateAsync({ type: "nodebuffer" }));
    const preview = await previewProcessArtifact({
      artifact: { runId: "run-docx-preview", id: "artifact-docx-preview", path: "report.docx", name: "report.docx", bytes: 1, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", role: "final", sourceTool: "computer_write_file", previewable: true },
      workspaceRoot: root,
    });
    assert.equal(preview.kind, "docx");
    if (preview.kind !== "docx") return;
    assert.equal(preview.schema, "agentloop.docxPreview/v2");
    assert.equal(preview.page?.marginsTwips.left, 1080);
    assert.equal(preview.blocks?.[0]?.type, "paragraph");
    assert.equal(preview.blocks?.[1]?.type, "table");
    assert.equal(preview.blocks?.[0]?.type === "paragraph" ? preview.blocks[0].runs[0]?.bold : false, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("process artifacts collect legacy DOC command outputs as Word artifacts", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-process-doc-artifacts-"));
  try {
    await fs.writeFile(join(root, "legacy-result.doc"), Buffer.from("legacy word bytes"));
    const runCreatedAt = Date.now() - 1_000;
    const events: StoredRunEvent[] = [
      event(1, "tool.completed", {
        toolName: "computer_run_command",
        isError: false,
        result: JSON.stringify({
          exitCode: 0,
          stdout: "conversion completed",
          fileChanges: [{ path: "legacy-result.doc", changeType: "created", bytes: 17 }],
        }),
      }),
    ];

    const artifacts = await collectProcessArtifacts({
      runId: "run-legacy-doc-artifacts",
      workspaceRoot: root,
      runCreatedAt,
      events,
    });

    assert.deepEqual(artifacts.map((artifact) => artifact.path), ["legacy-result.doc"]);
    assert.equal(artifacts[0].mimeType, "application/msword");
    assert.equal(artifacts[0].previewable, true);
    assert.equal(artifacts[0].sourceTool, "computer_run_command");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("process artifacts include patched outputs from computer_patch_file", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-process-patched-artifacts-"));
  try {
    await fs.writeFile(join(root, "report.html"), "<!doctype html><html><body>patched</body></html>");
    const runCreatedAt = Date.now() - 1_000;
    const events: StoredRunEvent[] = [
      event(1, "tool.completed", {
        toolName: "computer_patch_file",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.filePatch/v2",
          path: "report.html",
          operation: "apply_hunks",
          replacements: 1,
          artifactReceipt: {
            schema: "agentloop.artifactReceipt/v1",
            sourceTool: "computer_patch_file",
            artifact: { path: "report.html" },
          },
        }),
      }),
      event(2, "tool.completed", {
        toolName: "verify_artifact_acceptance",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.artifactAcceptance/v1",
          artifact: { path: "report.html" },
          verdict: "accepted",
          evidenceKinds: {
            satisfied: ["artifact_acceptance", "artifact_openable", "artifact_path"],
            caveated: [],
            failed: [],
          },
        }),
      }),
    ];

    const artifacts = await collectProcessArtifacts({
      runId: "run-patched-artifacts",
      workspaceRoot: root,
      runCreatedAt,
      events,
    });

    assert.deepEqual(artifacts.map((artifact) => artifact.path), ["report.html"]);
    assert.equal(artifacts[0].role, "final");
    assert.equal(artifacts[0].sourceTool, "computer_patch_file");
    assert.equal(artifacts[0].mimeType, "text/html; charset=utf-8");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function event(seq: number, type: string, data: Record<string, unknown>): StoredRunEvent {
  return { seq, type, data, createdAt: Date.now() };
}
