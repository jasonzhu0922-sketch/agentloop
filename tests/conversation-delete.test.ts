import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts";
import { BatchService } from "../src/batch/batch-service.ts";
import { createAgentLoopServer } from "../src/http/server.ts";
import type { ModelAdapter, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

test("conversation deletion is owner-scoped and cascades durable Run records", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("conversation-owner@example.com", "conversation owner secure password");
    const stranger = await auth.register("conversation-stranger@example.com", "conversation stranger secure password");
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => new StaticCompletionModel(),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.execute(owner.user.id, "delete this conversation");
    assert.ok(run.conversationId);
    assert.ok(count(database, "run_events") > 0);
    assert.ok(count(database, "plans") > 0);
    assert.throws(
      () => runs.deleteConversation(stranger.user.id, run.conversationId!),
      (error: unknown) => hasCode(error, "NOT_FOUND"),
    );

    runs.deleteConversation(owner.user.id, run.conversationId);
    assert.throws(
      () => runs.getConversation(owner.user.id, run.conversationId!),
      (error: unknown) => hasCode(error, "NOT_FOUND"),
    );
    assert.equal(count(database, "conversations"), 0);
    assert.equal(count(database, "runs"), 0);
    assert.equal(count(database, "run_events"), 0);
    assert.equal(count(database, "plans"), 0);
    assert.equal(count(database, "skill_compliance_assessments"), 0);
    assert.equal(count(database, "run_outcomes"), 0);
  } finally {
    database.close();
  }
});

test("conversation deletion rejects a running Run", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("conversation-running@example.com", "conversation running secure password");
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => new StaticCompletionModel(),
    });
    const conversationId = randomUUID();
    const runId = randomUUID();
    const now = Date.now();
    database.prepare(`
      INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(conversationId, owner.user.id, "running conversation", now, now);
    database.prepare(`
      INSERT INTO runs(id, owner_user_id, conversation_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, ?, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, conversationId, "still running", now);

    assert.throws(
      () => runs.deleteConversation(owner.user.id, conversationId),
      (error: unknown) => hasCode(error, "CONFLICT"),
    );
    assert.equal(count(database, "conversations"), 1);
    assert.equal(count(database, "runs"), 1);
  } finally {
    database.close();
  }
});

test("DELETE /v1/conversations/:id removes a completed conversation", async () => {
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const owner = await auth.register("conversation-delete-http@example.com", "conversation delete http secure password");
  const runs = new RunService({
    database,
    skills,
    modelFactory: () => new StaticCompletionModel(),
    plannerFactory: () => singleStepTestPlanner(),
    assessorFactory: () => approvingTestAssessor(),
  });
  const run = await runs.execute(owner.user.id, "delete over HTTP");
  assert.ok(run.conversationId);
  const server = createAgentLoopServer({ auth, skills, runs, batches: new BatchService(database, runs) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/conversations/${run.conversationId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(response.status, 204);
    assert.deepEqual(runs.listConversations(owner.user.id), []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  }
});

class StaticCompletionModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  async complete(): Promise<ModelResponse> {
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }
}

function count(database: AppDatabase, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code: unknown }).code === code;
}