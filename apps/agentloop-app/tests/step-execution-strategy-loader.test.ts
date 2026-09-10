import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadStepExecutionStrategyFromConfigFile,
  parseStepExecutionStrategyConfig,
} from "../src/step-execution-strategy-loader.ts";

declare global {
  // eslint-disable-next-line no-var
  var __stepExecutionStrategyLoaderTest: {
    options?: unknown;
    context?: unknown;
  } | undefined;
}

test("step execution strategy config defaults to full-catalog profile", () => {
  const config = parseStepExecutionStrategyConfig({});

  assert.equal(config.kind, "profile");
  assert.equal(config.profile, "full-catalog");
  assert.deepEqual(config.projection, {});
});

test("step execution strategy config parses full-catalog profile and projection thresholds", () => {
  const config = parseStepExecutionStrategyConfig({
    schema: "agentloop.stepExecutionStrategyConfig/v1",
    profile: "full-catalog",
    projection: {
      diagnosticProjectionCharacters: 3000,
      diagnosticPreviewCharacters: 900,
      terminalProjectionCharacters: 1200,
      terminalPreviewCharacters: 400,
    },
  });

  assert.equal(config.kind, "profile");
  assert.equal(config.profile, "full-catalog");
  assert.equal(config.projection.diagnosticProjectionCharacters, 3000);
  assert.equal(config.projection.terminalPreviewCharacters, 400);
});

test("step execution strategy config rejects unknown profiles and fields", () => {
  assert.throws(
    () => parseStepExecutionStrategyConfig({ profile: "unknown" }),
    /Unsupported Step execution strategy profile/,
  );
  assert.throws(
    () => parseStepExecutionStrategyConfig({ profile: "action-aware", extra: true }),
    /unsupported field/,
  );
  assert.throws(
    () => parseStepExecutionStrategyConfig({ module: "./strategy.mjs", profile: "action-aware" }),
    /cannot combine module/,
  );
});

test("step execution strategy loader uses full-catalog when default config is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentloop-step-strategy-"));
  const strategy = await loadStepExecutionStrategyFromConfigFile({
    configPath: join(directory, "missing.json"),
  });

  assert.equal(strategy.id, "agentloop.fullCatalogStepExecutionStrategy/v1");
});

test("step execution strategy loader reads configured profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentloop-step-strategy-"));
  const configPath = join(directory, "step-execution.json");
  await writeFile(configPath, JSON.stringify({ profile: "full-catalog" }), "utf8");

  const strategy = await loadStepExecutionStrategyFromConfigFile({ configPath, required: true });
  const decision = strategy.prepareModelStep({
    modelStep: 1,
    maxSteps: 2,
    hardLimit: 2,
    convergenceOnly: false,
    availableTools: [{ name: "read", description: "Read", inputSchema: { type: "object" } }],
    priorToolEvidence: [],
  });

  assert.equal(strategy.id, "agentloop.fullCatalogStepExecutionStrategy/v1");
  assert.equal(decision.toolCatalog.policyId, "agentloop.fullCatalogToolExposurePolicy/v1");
  assert.deepEqual(decision.toolCatalog.availableToolNames, ["read"]);
});

test("step execution strategy loader reads a custom global strategy module", async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "agentloop-step-strategy-plugin-"));
  const configDir = join(appRoot, "config");
  const configPath = join(configDir, "step-execution.json");
  const pluginPath = join(configDir, "custom-step-strategy.mjs");
  const pluginOptionsPath = join(configDir, "custom-step-strategy.options.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(pluginPath, `
    export function createStepExecutionStrategy(options, context) {
      globalThis.__stepExecutionStrategyLoaderTest = { options, context };
      return {
        id: "test.customStepExecutionStrategy/v1",
        prepareModelStep(input) {
          return {
          schema: "agentloop.stepExecutionDecision/v2",
            strategyId: "test.customStepExecutionStrategy/v1",
            toolCatalog: {
              schema: "agentloop.toolCatalogDecision/v2",
              policyId: "test.customToolExposurePolicy/v1",
              mode: "none",
              availableToolNames: [],
              preferredToolNames: [],
              deprioritizedToolGroups: [],
            },
            promptProjection: {
              schema: "agentloop.promptProjectionPolicy/v1",
              policyId: "test.customPromptProjectionPolicy/v1",
              mode: "custom",
              instruction: "custom projection",
            },
            loopStepFrame: {
              schema: "agentloop.loopStepFrame/v2",
              mode: "terminal_candidate",
              modelStep: input.modelStep,
              limits: {
                primaryMaxSteps: input.maxSteps,
                hardLimit: input.hardLimit,
                remainingIncludingCurrent: input.hardLimit - input.modelStep + 1,
              },
              priorEvidence: {
                toolCallCount: input.priorToolEvidence.length,
                successfulToolCallCount: 0,
                failedToolCallCount: 0,
                recentToolNames: [],
              },
              currentStage: {
                objective: "custom",
                toolUsePolicy: "custom",
                availableToolCount: 0,
              },
              handoffContract: {
                reusableOutputPolicy: "custom",
                forbiddenMoves: [],
              },
            },
            trace: {
              schema: "agentloop.stepExecutionPolicyTrace/v1",
              strategyId: "test.customStepExecutionStrategy/v1",
              loopStepPolicyId: "test.customLoopStepPolicy/v1",
              toolExposurePolicyId: "test.customToolExposurePolicy/v1",
              promptProjectionPolicyId: "test.customPromptProjectionPolicy/v1",
            },
          };
        },
      };
    }
  `, "utf8");
  await writeFile(pluginOptionsPath, JSON.stringify({
    mode: "file",
    nested: { preserved: true, replaced: false },
  }), "utf8");
  await writeFile(configPath, JSON.stringify({
    schema: "agentloop.stepExecutionStrategyConfig/v1",
    module: "./custom-step-strategy.mjs",
    factory: "createStepExecutionStrategy",
    optionsPath: "./custom-step-strategy.options.json",
    options: {
      nested: { replaced: true },
    },
  }), "utf8");

  try {
    const strategy = await loadStepExecutionStrategyFromConfigFile({
      appRoot,
      workspaceRoot: join(appRoot, "workspace"),
      configPath,
      required: true,
    });
    const decision = strategy.prepareModelStep({
      modelStep: 1,
      maxSteps: 2,
      hardLimit: 2,
      convergenceOnly: false,
      availableTools: [{ name: "read", description: "Read", inputSchema: { type: "object" } }],
      priorToolEvidence: [],
    });

    assert.equal(strategy.id, "test.customStepExecutionStrategy/v1");
    assert.equal(decision.promptProjection.mode, "custom");
    assert.deepEqual(globalThis.__stepExecutionStrategyLoaderTest?.options, {
      mode: "file",
      nested: { preserved: true, replaced: true },
    });
    assert.equal(
      (globalThis.__stepExecutionStrategyLoaderTest?.context as { configDir?: string } | undefined)?.configDir,
      configDir,
    );
  } finally {
    globalThis.__stepExecutionStrategyLoaderTest = undefined;
    await rm(appRoot, { recursive: true, force: true });
  }
});
