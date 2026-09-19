import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { readSkillExecutionManifest } from "../src/skills/skill-execution-manifest.ts";

const PPTX_SKILL_ROOT = resolve(import.meta.dirname, "..", "..", "agentloop-skills", "skills", "pptx");

test("PPTX unified-theme executor publishes the direct inventory and apply contracts", async () => {
  const entrypoints = await readSkillExecutionManifest(PPTX_SKILL_ROOT);
  assert.deepEqual(entrypoints, [{
    id: "unified-theme",
    description: "Inventory and apply a colour/font-only theme while preserving the editable source deck.",
    command: "python3",
    script: "scripts/apply_unified_theme.py",
    actions: [
      {
        id: "inventory",
        description: "Inspect the source deck's slide count, explicit colours, fonts, and preserved text before choosing a theme map.",
        inputs: [
          { name: "source-path", description: "Absolute workspace path of the materialized source .pptx.", required: true },
          { name: "report-path", description: "Absolute workspace path for the generated inventory JSON.", required: true },
        ],
        args: ["inventory", "{{source-path}}", "--report", "{{report-path}}"],
        result: "A source inventory with slide count, explicit colours, fonts, and text-preservation facts.",
      },
      {
        id: "apply",
        description: "Apply the selected complete colour/font map to a new PPTX and record a preservation receipt. Use after writing the deck-specific theme JSON from the inventory.",
        inputs: [
          { name: "source-path", description: "Absolute workspace path of the materialized source .pptx.", required: true },
          { name: "output-path", description: "Absolute workspace path for the new themed .pptx.", required: true },
          { name: "theme-path", description: "Absolute workspace path of a deck-specific theme JSON with all theme roles and explicit-colour mappings.", required: true },
          { name: "report-path", description: "Absolute workspace path for the generated transformation receipt JSON.", required: true },
        ],
        args: ["apply", "{{source-path}}", "{{output-path}}", "--theme", "{{theme-path}}", "--report", "{{report-path}}", "--require-complete-color-map"],
        result: "A new themed PPTX and a receipt proving the transformation and source-preservation checks.",
      },
    ],
  }]);
});
