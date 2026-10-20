import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS, testOwner } from "./runtime-test-helpers.ts";

const summary = [
  "## Goal\nSummarize the collected evidence.",
  "## Constraints & Preferences\nUse only canonical evidence. Do not claim artifact delivery.",
  "## Progress\nEvidence was collected; the answer remains pending.",
  "## Evidence\ncollect-context Tool result remains persisted.",
  "## Next Steps\nReturn a non-empty answer.",
  "## Critical Context\nNo successful final answer has been produced.",
].join("\n\n");

test("RunService persists complete compaction attempts before validation and exposes only diagnostic references", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-compaction-persistence-"));
  const database = new AppDatabase(":memory:");
  let executionCalls = 0;
  let compactionCalls = 0;
  try {
    const options = {
      database, workspaceRoot: workspace, skills: new SkillService(database),
      plannerFactory: () => singleStepTestPlanner(), assessorFactory: () => approvingTestAssessor(),
      tools: [{
        name: "collect_context", description: "Collect canonical evidence.", inputSchema: { type: "object" },
        executionMode: "parallel" as const, replaySafe: true,
        parse: (value: unknown) => value,
        execute: async () => ({ evidence: "persisted canonical evidence ".repeat(4_000) }),
      }],
      modelFactory: () => ({
        limits: TEST_MODEL_LIMITS,
        complete: async (request) => {
          if (request.phase === "compaction") {
            compactionCalls += 1;
            // The rejected first response must remain inspectable too.
            return { content: compactionCalls === 1 ? "invalid summary response" : summary,
              reasoningContent: "private-compaction-continuation", toolCalls: [], finishReason: "stop" as const,
              usage: { inputTokens: 1_000, outputTokens: 100 } };
          }
          executionCalls += 1;
          if (executionCalls === 1) return { content: "", finishReason: "tool_calls" as const,
            toolCalls: [{ id: "collect-context", name: "collect_context", arguments: {} }] };
          if (executionCalls === 2 || executionCalls === 3) return { content: "", finishReason: "stop" as const, toolCalls: [] };
          return { content: "已根据已收集的证据形成结论。", finishReason: "stop" as const, toolCalls: [] };
        },
      }),
    };
    const runs = new RunService(options);
    const owner = testOwner().user.id;
    const run = await runs.execute(owner, "Collect evidence and summarize it briefly.");
    assert.equal(run.status, "completed");
    assert.equal(compactionCalls, 2);

    // A new service reads the same durable ledger rather than an in-memory trace.
    const events = await new RunService(options).events(owner, run.id);
    const attempts = events.filter((event) => event.type === "context.compaction.model.requested" || event.type === "context.compaction.model.completed");
    assert.equal(attempts.length, 4);
    assert.doesNotMatch(JSON.stringify(events), /private-compaction-continuation|invalid summary response/);
    const bodies: any[] = [];
    for (const event of attempts) {
      assert.equal(event.data.diagnostic, undefined);
      const ref = event.data.diagnosticRef as { path: string; sha256: string; bytes: number };
      assert.ok(ref.path.startsWith(".agentloop/diagnostics/context-compactions/"));
      const path = join(workspace, ref.path);
      const bytes = await fs.readFile(path);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), ref.sha256);
      assert.equal(bytes.length, ref.bytes);
      if (process.platform !== "win32") assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
      bodies.push(JSON.parse(bytes.toString("utf8")));
    }
    assert.equal(bodies[0].diagnostic.invocation.phase, "compaction");
    assert.equal(bodies[0].diagnostic.invocation.tools.length, 0);
    assert.equal(bodies[1].diagnostic.response.content, "invalid summary response");
    assert.equal(bodies[1].diagnostic.response.reasoningContent, "private-compaction-continuation");
    assert.equal(bodies[3].diagnostic.response.content, summary);
    assert.ok(events.some((event) => event.type === "context.compaction.summary.rejected" && event.data.requestId === attempts[0].data.requestId));
    const requests = events.filter((event) => event.type === "model.request.completed" && event.data.phase === "compaction");
    assert.equal(requests.length, 2);
    assert.ok(requests.every((event) => event.data.durationMs !== undefined && event.data.usage !== undefined));
    const actions = await database.prepare("SELECT metadata_json FROM runtime_actions WHERE run_id = ? AND kind = 'compaction'").all(run.id) as Array<{ metadata_json: string }>;
    assert.deepEqual(actions.map((action) => JSON.parse(action.metadata_json).requestId).sort(), requests.map((event) => event.data.requestId).sort());
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
