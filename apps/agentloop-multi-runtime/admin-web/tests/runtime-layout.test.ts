import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Runtime inventory keeps Local Runtime read-only and confirms Cloud row operations", async () => {
  const source = await readFile(new URL("../src/app/shell.ts", import.meta.url), "utf8");
  assert.match(source, /本地 Runtime 不支持运维操作/);
  assert.match(source, /window\.confirm\(/);
  assert.match(source, /data-runtime-operation="restart"/);
  assert.doesNotMatch(source, /data-runtime-select/);
  assert.doesNotMatch(source, /id="runtime-form"/);
  assert.doesNotMatch(source, /apiOperation = operation === "restart" \? "recover"/);
});
