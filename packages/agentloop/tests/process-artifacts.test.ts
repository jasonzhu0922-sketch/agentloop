import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectProcessArtifacts } from "../src/runtime/process-artifacts.ts";
import type { StoredRunEvent } from "../src/runtime/run-service.ts";

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
        toolName: "materialize_paginated_html",
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
    assert.equal(final?.sourceTool, "materialize_paginated_html");
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
          schema: "agentloop.filePatch/v1",
          path: "report.html",
          operation: "replace_text",
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
