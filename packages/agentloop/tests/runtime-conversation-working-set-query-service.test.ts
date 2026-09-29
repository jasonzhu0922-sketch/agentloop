import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeConversationWorkingSetQueryService } from "../src/runtime/runtime-conversation-working-set-query-service.ts";

test("conversation Working Set is bounded to durable recent Runs and preserves reusable artifact capability evidence", async () => {
  const runs = Array.from({ length: 9 }, (_, index) => ({
    id: `run-${index}`,
    status: "completed" as const,
    input: `prior objective ${index}`,
    ownerUserId: "user",
    conversationId: "conversation",
    createdAt: index,
  }));
  const queries = new RuntimeConversationWorkingSetQueryService({
    runs: async () => runs,
    events: async () => [],
    outcome: async () => undefined,
    plan: async () => undefined,
    reusableArtifacts: async (run) => run.id === "run-8" ? [{
      runId: run.id, path: "reports/final.md", name: "final.md", bytes: 12,
      mimeType: "text/markdown", sourceTool: "computer_write_file", reusable: true,
      sourceSkillIds: ["skill-report"], sourceCapabilities: ["workspace_artifact_write"],
    }] : [],
    turnResolution: () => undefined,
    failedBoundary: () => undefined,
    sourceSummary: () => undefined,
    stepContext: () => undefined,
    resumeSuggestion: () => undefined,
  });

  const workset = await queries.build("conversation");
  assert.equal(workset?.runCount, 9);
  assert.deepEqual(workset?.reusableArtifacts.map((artifact) => artifact.runId), ["run-8"]);
  assert.deepEqual(workset?.recommendedCapabilities.skillIds, ["skill-report"]);
  assert.deepEqual(workset?.recommendedCapabilities.capabilityIds, ["workspace_artifact_write"]);
});
