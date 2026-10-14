import assert from "node:assert/strict";
import test from "node:test";
import { createRunState, releaseTerminalRun } from "../web/client/state/run-state.js";

test("run state isolates active execution coordination from conversation indexing", () => {
  const state = createRunState();
  state.activeByConversation.set("conversation-1", { assignmentId: "assignment-1" });
  state.uploadingByConversation.set("conversation-1", 1);
  state.cancellingAssignmentIds.add("assignment-1");
  state.deletingConversationIds.add("conversation-2");
  state.hydratedDetailAssignmentIds.add("assignment-2");
  state.pendingLiveAssistantIds.add("assistant-1");
  assert.equal((state.activeByConversation.get("conversation-1") as { assignmentId: string }).assignmentId, "assignment-1");
  assert.equal(state.uploadingByConversation.get("conversation-1"), 1);
  assert.ok(state.cancellingAssignmentIds.has("assignment-1"));
  assert.ok(state.deletingConversationIds.has("conversation-2"));
  assert.ok(state.hydratedDetailAssignmentIds.has("assignment-2"));
  assert.ok(state.pendingLiveAssistantIds.has("assistant-1"));
  assert.equal(state.persistedReconciliation, undefined);
});

test("a confirmed terminal Run releases the composer before detail hydration completes", () => {
  const state = createRunState();
  const terminal = { status: "completed", assignmentId: "assignment-1" };
  state.activeByConversation.set("conversation-1", { assignmentId: "assignment-1", assistant: terminal });

  assert.equal(releaseTerminalRun(state, "conversation-1", terminal), true);
  assert.equal(state.activeByConversation.has("conversation-1"), false);
});

test("a terminal message cannot release a newer conversation Run", () => {
  const state = createRunState();
  const previous = { status: "completed", assignmentId: "assignment-old" };
  state.activeByConversation.set("conversation-1", { assignmentId: "assignment-new", assistant: { status: "running", assignmentId: "assignment-new" } });

  assert.equal(releaseTerminalRun(state, "conversation-1", previous), false);
  assert.equal(state.activeByConversation.has("conversation-1"), true);
});
