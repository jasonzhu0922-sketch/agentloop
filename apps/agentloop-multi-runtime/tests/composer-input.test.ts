import assert from "node:assert/strict";
import test from "node:test";
import { MAX_COMPOSER_LINES, autoResizeComposerInput, composerInputHeight, resetComposerInput, shouldSubmitComposerOnKeydown } from "../web/composer-input.js";

test("composer only submits on an explicit modifier-plus-Enter shortcut", () => {
  assert.equal(shouldSubmitComposerOnKeydown({ key: "Enter" }), false);
  assert.equal(shouldSubmitComposerOnKeydown({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSubmitComposerOnKeydown({ key: "Enter", ctrlKey: true }), true);
  assert.equal(shouldSubmitComposerOnKeydown({ key: "Enter", metaKey: true }), true);
  assert.equal(shouldSubmitComposerOnKeydown({ key: "Enter", ctrlKey: true, isComposing: true }), false);
  assert.equal(shouldSubmitComposerOnKeydown({ key: "a", ctrlKey: true }), false);
});

test("composer input grows with content but stops at three lines", () => {
  assert.equal(MAX_COMPOSER_LINES, 3);
  assert.equal(composerInputHeight(42, 24), 42);
  assert.equal(composerInputHeight(120, 24), 72);

  const input = { scrollHeight: 120, style: { height: "", overflowY: "" } };
  autoResizeComposerInput(input, () => 24);
  assert.deepEqual(input.style, { height: "72px", overflowY: "auto" });
});

test("composer input resets its inline size after submission", () => {
  const input = { scrollHeight: 24, style: { height: "72px", overflowY: "auto" } };
  resetComposerInput(input);
  assert.deepEqual(input.style, { height: "", overflowY: "" });
});
