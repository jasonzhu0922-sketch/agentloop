import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts";
import { BatchService } from "../src/batch/batch-service.ts";
import { createAgentLoopServer } from "../src/http/server.ts";
import { collectProcessArtifacts, artifactId } from "../src/runtime/process-artifacts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";

test("process artifacts require successful tool evidence and stay inside the workspace", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-artifacts-"));
  try {
    const createdAt = Date.now();
    await fs.writeFile(join(workspace, "poster.pdf"), "pdf bytes");
    await fs.writeFile(join(workspace, "unmentioned.png"), "png bytes");
    await fs.writeFile(join(workspace, "old.txt"), "old bytes");
    const oldTime = new Date(createdAt - 10_000);
    await fs.utimes(join(workspace, "old.txt"), oldTime, oldTime);

    const events = [{
      seq: 1,
      type: "tool.completed",
      createdAt,
      data: {
        toolName: "computer_run_command",
        result: JSON.stringify({ exitCode: 0, stdout: "saved poster.pdf\n" }),
      },
    }, {
      seq: 2,
      type: "tool.completed",
      createdAt,
      data: {
        toolName: "computer_run_command",
        result: JSON.stringify({ exitCode: 1, stdout: "saved unmentioned.png\n" }),
      },
    }, {
      seq: 3,
      type: "tool.completed",
      createdAt,
      data: {
        toolName: "computer_run_command",
        result: JSON.stringify({ exitCode: 0, stdout: "saved old.txt\n" }),
      },
    }];

    const artifacts = await collectProcessArtifacts({
      runId: "run-artifact-test",
      workspaceRoot: workspace,
      runCreatedAt: createdAt,
      events,
    });
    assert.deepEqual(artifacts.map((artifact) => artifact.path), ["poster.pdf"]);
    assert.equal(artifacts[0].mimeType, "application/pdf");
    assert.equal(artifacts[0].id, artifactId("run-artifact-test", "poster.pdf"));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("process artifacts include conversation workspace files mentioned by absolute path", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-conversation-artifacts-"));
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("conversation-artifact-owner@example.com", "conversation artifact secure password");
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => { throw new Error("model is not used"); },
    });
    const conversationId = randomUUID();
    const runId = randomUUID();
    const createdAt = Date.now() - 1_000;
    const artifactDir = join(workspace, "conversations", conversationId, "artifacts");
    await fs.mkdir(artifactDir, { recursive: true });
    const reportPath = join(artifactDir, "场景分析报告.md");
    const extractionPath = join(artifactDir, "scenario_extraction.json");
    await fs.writeFile(reportPath, "# 场景分析报告\n");
    await fs.writeFile(extractionPath, "{\"records\":60}\n");
    database.prepare(`
      INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at)
      VALUES (?, ?, 'spreadsheet report', ?, ?)
    `).run(conversationId, owner.user.id, createdAt, createdAt);
    database.prepare(`
      INSERT INTO runs(id, owner_user_id, conversation_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, ?, 0, 0, 'completed', ?, ?)
    `).run(runId, owner.user.id, conversationId, "分析 1.xlsx 并生成报告", createdAt);
    database.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
      VALUES (?, 1, 'tool.completed', ?, ?)
    `).run(runId, JSON.stringify({
      toolName: "computer_run_command",
      result: JSON.stringify({ exitCode: 0, stdout: `wrote ${extractionPath}\nwrote ${reportPath}\n` }),
    }), createdAt);

    const artifacts = await runs.processArtifacts(owner.user.id, runId);

    assert.deepEqual(artifacts.map((artifact) => artifact.path), [
      "artifacts/scenario_extraction.json",
      "artifacts/场景分析报告.md",
    ]);
    assert.equal(artifacts[1]?.name, "场景分析报告.md");
    const opened = await runs.readProcessArtifact(owner.user.id, runId, artifacts[1]!.id);
    assert.equal(opened.content.toString("utf8"), "# 场景分析报告\n");
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("process artifact API serves owner evidence and denies another user", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-api-"));
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const owner = await auth.register("artifact-owner@example.com", "artifact owner secure password");
  const stranger = await auth.register("artifact-stranger@example.com", "artifact stranger secure password");
  const runs = new RunService({
    database,
    skills,
    workspaceRoot: workspace,
    modelFactory: () => { throw new Error("model is not used"); },
  });
  const runId = randomUUID();
  const createdAt = Date.now();
  await fs.writeFile(join(workspace, "poster.pdf"), "PDF PROCESS ARTIFACT");
  database.prepare(`
    INSERT INTO runs(id, owner_user_id, depth, allow_dangerous_tools, status, input, created_at)
    VALUES (?, ?, 0, 0, 'failed', ?, ?)
  `).run(runId, owner.user.id, "generate a poster", createdAt);
  database.prepare(`
    INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
    VALUES (?, 1, 'tool.completed', ?, ?)
  `).run(runId, JSON.stringify({
    toolName: "computer_run_command",
    result: JSON.stringify({ exitCode: 0, stdout: "saved poster.pdf\n" }),
  }), createdAt);
  const batches = new BatchService(database, runs);
  const server = createAgentLoopServer({ auth, skills, runs, batches });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const list = await fetch(`${baseUrl}/v1/runs/${runId}/artifacts`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(list.status, 200);
    const body = await list.json() as { artifacts: Array<{ id: string; name: string }> };
    assert.equal(body.artifacts.length, 1);
    assert.equal(body.artifacts[0].name, "poster.pdf");

    const content = await fetch(`${baseUrl}/v1/runs/${runId}/artifacts/${body.artifacts[0].id}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(content.status, 200);
    assert.equal(content.headers.get("content-type"), "application/pdf");
    assert.equal(await content.text(), "PDF PROCESS ARTIFACT");

    const hidden = await fetch(`${baseUrl}/v1/runs/${runId}/artifacts`, {
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    assert.equal(hidden.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("process artifact API serves UTF-8 filenames in the download header", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-utf8-api-"));
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const owner = await auth.register("artifact-utf8-owner@example.com", "artifact utf8 secure password");
  const runs = new RunService({
    database,
    skills,
    workspaceRoot: workspace,
    modelFactory: () => { throw new Error("model is not used"); },
  });
  const conversationId = randomUUID();
  const runId = randomUUID();
  const createdAt = Date.now();
  const artifactDir = join(workspace, "conversations", conversationId, "artifacts");
  await fs.mkdir(artifactDir, { recursive: true });
  const reportPath = join(artifactDir, "场景分析报告.md");
  await fs.writeFile(reportPath, "# 场景分析报告\n");
  database.prepare(`
    INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at)
    VALUES (?, ?, 'utf8 artifact', ?, ?)
  `).run(conversationId, owner.user.id, createdAt, createdAt);
  database.prepare(`
    INSERT INTO runs(id, owner_user_id, conversation_id, depth, allow_dangerous_tools, status, input, created_at)
    VALUES (?, ?, ?, 0, 0, 'completed', ?, ?)
  `).run(runId, owner.user.id, conversationId, "生成中文报告", createdAt);
  database.prepare(`
    INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
    VALUES (?, 1, 'tool.completed', ?, ?)
  `).run(runId, JSON.stringify({
    toolName: "computer_run_command",
    result: JSON.stringify({ exitCode: 0, stdout: `wrote ${reportPath}\n` }),
  }), createdAt);
  const batches = new BatchService(database, runs);
  const server = createAgentLoopServer({ auth, skills, runs, batches });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const list = await fetch(`${baseUrl}/v1/runs/${runId}/artifacts`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(list.status, 200);
    const body = await list.json() as { artifacts: Array<{ id: string; name: string }> };
    assert.equal(body.artifacts[0]?.name, "场景分析报告.md");

    const content = await fetch(`${baseUrl}/v1/runs/${runId}/artifacts/${body.artifacts[0]!.id}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(content.status, 200);
    assert.equal(await content.text(), "# 场景分析报告\n");
    const disposition = content.headers.get("content-disposition") ?? "";
    assert.match(disposition, /filename="\S+"/);
    assert.match(disposition, /filename\*=UTF-8''%E5%9C%BA%E6%99%AF%E5%88%86%E6%9E%90%E6%8A%A5%E5%91%8A\.md/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
