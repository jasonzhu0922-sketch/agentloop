import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { readSkillExecutionManifest } from "../../../packages/agentloop/src/skills/skill-execution-manifest.ts";

const executeFile = promisify(execFile);
const AIHOT_SKILL_ROOT = resolve(import.meta.dirname, "..", "custom-skills", "aihot");
const AIHOT_RUNTIME = resolve(AIHOT_SKILL_ROOT, "scripts", "query-aihot.mjs");

test("AIHOT declares package-owned query actions with no fabricated workspace computation input", async () => {
  const [entrypoint] = await readSkillExecutionManifest(AIHOT_SKILL_ROOT);
  assert.deepEqual(entrypoint, {
    id: "aihot-query",
    description: "Query the package-owned AIHOT public v1 items API or report its explicit monthly boundary.",
    command: "node",
    script: "scripts/query-aihot.mjs",
    actions: [
      {
        id: "list-items",
        description: "List bounded AIHOT selected or public-pool items for one supported rolling window.",
        inputs: [
          { name: "window", description: "One supported rolling window: 24h or 7d.", required: true },
          { name: "mode", description: "AIHOT pool: selected or all.", required: true },
          { name: "limit", description: "Maximum returned items from 1 to 50.", required: true },
          { name: "by", description: "Time axis: timeline or published.", required: true },
        ],
        args: ["items", "--window", "{{window}}", "--mode", "{{mode}}", "--limit", "{{limit}}", "--by", "{{by}}"],
        result: "An AIHOT items response with a source-summary and source-URLs evidence receipt.",
        producesEvidenceKinds: ["source_summary", "source_urls"],
      },
      {
        id: "search-items",
        description: "Search bounded AIHOT selected or public-pool items by one keyword query.",
        inputs: [
          { name: "window", description: "One supported rolling window: 24h or 7d.", required: true },
          { name: "mode", description: "AIHOT pool: selected or all.", required: true },
          { name: "limit", description: "Maximum returned items from 1 to 50.", required: true },
          { name: "query", description: "One keyword query passed to the API q parameter.", required: true },
          { name: "by", description: "Time axis: timeline or published.", required: true },
        ],
        args: ["items", "--window", "{{window}}", "--mode", "{{mode}}", "--limit", "{{limit}}", "--q", "{{query}}", "--by", "{{by}}"],
        result: "An AIHOT keyword-search response with a source-summary and source-URLs evidence receipt.",
        producesEvidenceKinds: ["source_summary", "source_urls"],
      },
      {
        id: "category-items",
        description: "List bounded AIHOT selected or public-pool items for one category.",
        inputs: [
          { name: "window", description: "One supported rolling window: 24h or 7d.", required: true },
          { name: "mode", description: "AIHOT pool: selected or all.", required: true },
          { name: "limit", description: "Maximum returned items from 1 to 50.", required: true },
          { name: "category", description: "One AIHOT category slug.", required: true },
          { name: "by", description: "Time axis: timeline or published.", required: true },
        ],
        args: ["items", "--window", "{{window}}", "--mode", "{{mode}}", "--limit", "{{limit}}", "--category", "{{category}}", "--by", "{{by}}"],
        result: "An AIHOT category response with a source-summary and source-URLs evidence receipt.",
        producesEvidenceKinds: ["source_summary", "source_urls"],
      },
      {
        id: "month-boundary",
        description: "State the package-owned boundary for an unavailable rolling 30-day AIHOT items request.",
        inputs: [],
        args: ["month-boundary"],
        result: "An explicit unavailable monthly-window source receipt without inventing a 30-day items result.",
        producesEvidenceKinds: ["source_summary", "source_urls"],
      },
    ],
  });
});

test("AIHOT month boundary emits the declared source receipt without network access", async () => {
  const { stdout } = await executeFile(process.execPath, [AIHOT_RUNTIME, "month-boundary"], { cwd: AIHOT_SKILL_ROOT });
  const result = JSON.parse(stdout) as { fulfillment: string; evidenceReceipt: { evidenceKinds: { satisfied: string[]; caveated: string[] } } };
  assert.equal(result.fulfillment, "unavailable");
  assert.deepEqual(result.evidenceReceipt.evidenceKinds, {
    satisfied: ["source_summary", "source_urls"],
    caveated: ["explicit_caveats"],
    failed: [],
  });
});
