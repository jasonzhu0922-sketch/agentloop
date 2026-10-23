import assert from "node:assert/strict";
import test from "node:test";
import { mergeEnvLines, providerKeyNames, readEnvValue } from "../web/pages/cloud-model-config.js";

test("cloud model configuration exports preserve unrelated env settings and safely round-trip keys", () => {
  const original = ["# deployment keys", "OPENAI_API_KEY='old-key'", "WEB_SEARCH_DISABLED=1", "", "OPENAI_API_KEY='last-value'"];
  const value = "new\\key'with spaces";
  const merged = mergeEnvLines(original, [["OPENAI_API_KEY", value], ["SECONDARY_KEY", ""]]);

  assert.equal(readEnvValue(merged, "OPENAI_API_KEY"), value);
  assert.equal(readEnvValue(merged, "SECONDARY_KEY"), "");
  assert.equal(merged[0], original[0]);
  assert.equal(merged[2], original[2]);
  assert.equal(merged[3], original[3]);
  assert.equal(merged.filter((line) => line.startsWith("OPENAI_API_KEY=")).length, 2);
});

test("cloud model configuration reads provider key variables in declaration order", () => {
  assert.deepEqual(providerKeyNames({
    providers: {
      first: { apiKeyEnv: "FIRST_KEY" },
      second: { apiKeyEnv: "SECOND_KEY" },
      third: { apiKeyEnv: "FIRST_KEY" },
    },
    models: {},
  }), ["FIRST_KEY", "SECOND_KEY"]);
  assert.throws(() => providerKeyNames({ providers: { bad: { apiKeyEnv: "NOT A KEY" } }, models: {} }), /apiKeyEnv/);
});
