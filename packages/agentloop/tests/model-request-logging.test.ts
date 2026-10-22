import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAICompatibleModel } from "../src/runtime/models.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { approvingTestAssessor, singleStepTestPlanner } from "./runtime-test-helpers.ts";

test("provider attempt IDs survive HTTP retries into durable events and terminal logs without truncation", async () => {
  const originalFetch = globalThis.fetch;
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-request-log-"));
  const database = new AppDatabase(":memory:");
  const failedRequestId = `provider-retry-${"a".repeat(100)}`;
  const successfulRequestId = `provider-success-${"b".repeat(100)}`;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) return new Response("upstream temporarily busy", { status: 429, headers: { "x-oneapi-request-id": failedRequestId } });
    return new Response('data: {"id":"body-completion-id","choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream", "x-oneapi-request-id": successfulRequestId },
    });
  };
  try {
    const lines: string[] = [];
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      workspaceRoot: workspace,
      modelFactory: (onRetry) => new OpenAICompatibleModel({
        baseUrl: "https://models.example.test/v1",
        apiKey: "server-secret",
        model: "flash",
        contextWindowTokens: 128_000,
        maxOutputTokens: 8_192,
        maxAttempts: 2,
        retryDelayMs: 0,
        onRetry,
      }),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
      runEventLogSink: (line) => { lines.push(line); },
    });
    const run = await runs.execute("owner", "你好");
    assert.equal(run.status, "completed");
    const events = await runs.events("owner", run.id);
    const retry = events.find((event) => event.type === "model.retry");
    const completed = events.find((event) => event.type === "model.request.completed");
    assert.equal(retry?.data.providerGatewayRequestId, failedRequestId);
    assert.equal(completed?.data.providerGatewayRequestId, successfulRequestId);
    assert.equal(retry?.data.providerRequestId, undefined);
    assert.equal(completed?.data.providerRequestId, undefined);
    assert.equal(completed?.data.providerResponseId, "body-completion-id");
    const retryLine = lines.find((line) => line.includes("event=model.retry")) ?? "";
    const completedLine = lines.find((line) => line.includes("event=model.request.completed")) ?? "";
    assert.ok(retryLine.includes(`providerGatewayRequestId=${JSON.stringify(failedRequestId)}`));
    assert.ok(completedLine.includes(`providerGatewayRequestId=${JSON.stringify(successfulRequestId)}`));
    assert.ok(completedLine.includes('providerResponseId="body-completion-id"'));
    assert.match(retryLine, /attempt=1 maxAttempts=2 status=429/);
    assert.match(completedLine, /run=\S+.*requestPhase="execution".*durationMs=\d+/);
    assert.doesNotMatch(lines.join("\n"), /server-secret/);
  } finally {
    globalThis.fetch = originalFetch;
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
