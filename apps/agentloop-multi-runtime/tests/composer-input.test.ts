import assert from "node:assert/strict";
import test from "node:test";
import { MAX_COMPOSER_LINES, autoResizeComposerInput, composerInputHeight, resetComposerInput } from "../web/composer-input.js";

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
