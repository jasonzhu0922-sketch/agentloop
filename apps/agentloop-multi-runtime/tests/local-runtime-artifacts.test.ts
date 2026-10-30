import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase, RuntimeWorkspaceService, RunRepository } from "@zhujun/agentloop";
import { LocalRuntimeArtifactReadPlane } from "../local-agent-runtime/src/persistence/local-runtime-artifact-read-plane.ts";

test("completed artifacts remain readable from a stopped Runtime database", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-artifacts-"));
  const databasePath = join(root, "agentloop.db");
  const workspaceRoot = join(root, "workspace");
  const ownerUserId = "user-artifact-history";
  const conversationId = "conversation-artifact-history";
  const runId = "run-artifact-history";
  const createdAt = Date.now() - 5_000;
  const database = new AppDatabase(databasePath);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const runs = new RunRepository(database);
    await database.prepare("INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(conversationId, ownerUserId, "history", createdAt, createdAt);
    await runs.insertRun({ id: runId, ownerUserId, conversationId, allowDangerousTools: true, input: "produce report", createdAt });
    await database.prepare("UPDATE runs SET status = 'completed', finished_at = ? WHERE id = ?").run(createdAt + 1, runId);
    await database.prepare("INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)").run(
      runId,
      1,
      "tool.completed",
      JSON.stringify({ toolName: "computer_write_file", isError: false, result: JSON.stringify({ path: "report.html" }) }),
      createdAt + 1,
    );
    const workspace = new RuntimeWorkspaceService(workspaceRoot, { ownerScoped: true });
    const conversationRoot = workspace.forConversation(ownerUserId, conversationId);
    await mkdir(conversationRoot, { recursive: true });
    await writeFile(join(conversationRoot, "report.html"), "<h1>history</h1>");
  } finally {
    await database.close();
  }

  try {
    const plane = new LocalRuntimeArtifactReadPlane({ databasePath, workspaceRoot: () => workspaceRoot });
    const runtime = { id: "runtime-history", displayName: "History", storageKey: "default", isDefault: true } as const;
    const artifacts = await plane.list(runtime, runId, ownerUserId);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.name, "report.html");
    const result = await plane.read(runtime, runId, artifacts[0]!.id, ownerUserId);
    assert.equal(result.content.toString("utf8"), "<h1>history</h1>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
