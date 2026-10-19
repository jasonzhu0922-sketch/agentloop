import assert from "node:assert/strict";
import test from "node:test";
import { modelSelectionStatus } from "../web/client/ui/model-selection-status.js";

test("composer selection, rather than the first model catalog item, owns the model status", () => {
  const models = [
    { key: "deepseek-v4-flash", displayName: "DeepSeek v4 Flash" },
    { key: "gpt-5.6-luna", displayName: "GPT-5.6 luna" },
  ];
  assert.equal(modelSelectionStatus(models, "gpt-5.6-luna"), "模型：GPT-5.6 luna");
  assert.equal(modelSelectionStatus(models, ""), "模型：使用 Runtime 默认模型");
});
