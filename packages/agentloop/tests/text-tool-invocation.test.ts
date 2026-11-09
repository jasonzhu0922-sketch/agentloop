import assert from "node:assert/strict";
import test from "node:test";
import { isTextToolInvocation } from "../src/runtime/text-tool-invocation.ts";

test("detects spaced DSML invocation markup without classifying ordinary discussion as a call", () => {
  assert.equal(isTextToolInvocation('<｜DSML｜ calls>\n<｜DSML｜ invoke name="computer_run_command">'), true);
  assert.equal(isTextToolInvocation('<|DSML| parameter name="command">node</|DSML| parameter>'), true);
  assert.equal(isTextToolInvocation("The DSML protocol can represent tool calls."), false);
});
