import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeConversationWorkingSetQueryService } from "../src/runtime/runtime-conversation-working-set-query-service.ts";
import type { RuntimeHumanLoopAnswer } from "../src/runtime/user-authority.ts";

test("historical choices carry question and provenance, exclude free text and withdrawn outcomes, and require new confirmation", async () => {
  const answer = (id: string): RuntimeHumanLoopAnswer => ({ responseId: id, requestId: id, requestRevision: 1, createdAt: 1, eventSeq: 5,
    question: { kind: "selection", title: "Source", prompt: "Choose the source for this task", responseType: "select" }, value: ["group"], selectedOptions: [{ id: "group", label: "Group data", identityRefs: ["source:group"] }] });
  const workset = await new RuntimeConversationWorkingSetQueryService({
    runs: async () => ["first", "second"].map(id => ({ id, ownerUserId: "alice", conversationId: "chat", status: "completed", input: `Query ${id}`, createdAt: 1 })),
    events: async id => id === "second" ? [{ seq: 10, type: "conversation.outcome.disputed", data: { targetRunId: "first", relation: "challenge_prior" }, createdAt: 1 }] : [],
    answers: async id => [answer(id), { ...answer("free-text"), selectedOptions: undefined, value: { secret: "do not copy" } }],
    outcome: async () => undefined, plan: async () => undefined, reusableArtifacts: async () => [], turnResolution: () => undefined,
    failedBoundary: () => undefined, sourceSummary: () => undefined, stepContext: () => undefined, resumeSuggestion: () => undefined,
  }).build("chat");
  assert.deepEqual(workset!.userDecisions, [{ runId: "second", requestId: "second", eventSeq: 5, priorGoal: "Query second", question: "Choose the source for this task", requiresConfirmation: true,
    selectedOptions: [{ id: "group", label: "Group data", identityRefs: ["source:group"] }] }]);
  assert.doesNotMatch(JSON.stringify(workset), /do not copy|free-text|decisionLedger/);
});

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
  assert.deepEqual(workset?.priorRuns, runs.slice(1).map((run) => ({ runId: run.id, input: run.input, status: run.status })));
  assert.deepEqual(workset?.reusableArtifacts.map((artifact) => artifact.runId), ["run-8"]);
  assert.deepEqual(workset?.recommendedCapabilities.skillIds, ["skill-report"]);
  assert.deepEqual(workset?.recommendedCapabilities.capabilityIds, ["workspace_artifact_write"]);
});
