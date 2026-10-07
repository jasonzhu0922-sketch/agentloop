import assert from "node:assert/strict";
import test from "node:test";
import { createConversationState } from "../web/conversation-state.js";

test("conversation state resets index and paging without touching transport state", () => {
  const state = createConversationState(30);
  state.sessions = [{ id: "c1" }];
  state.recovered = [{ id: "cached" }];
  state.activeId = "c1";
  state.visibleLimit = 60;
  state.nextOffset = 30;
  state.hasMore = true;
  state.loadingMore = true;
  state.clear();
  assert.deepEqual(state.sessions, []);
  assert.deepEqual(state.recovered, []);
  assert.equal(state.activeId, undefined);
  assert.deepEqual({ visibleLimit: state.visibleLimit, nextOffset: state.nextOffset, hasMore: state.hasMore, loadingMore: state.loadingMore }, { visibleLimit: 30, nextOffset: 0, hasMore: false, loadingMore: false });
});
