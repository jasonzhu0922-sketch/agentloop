import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPlanningExtensions } from "../src/planning-extension-loader.ts";

declare global {
  // eslint-disable-next-line no-var
  var __planningExtensionLoaderTest: {
    options?: unknown;
    context?: unknown;
    closed?: boolean;
  } | undefined;
}

test("disabled planning extension config does not import plugin modules", async () => {
  const appRoot = await fs.mkdtemp(join(tmpdir(), "agentloop-app-plugin-off-"));
  const configDir = join(appRoot, "config");
  const configPath = join(configDir, "planning-extensions.json");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    enabled: true,
    planningExtensions: [{
      enabled: false,
      module: "./missing-plugin.mjs",
    }],
  }));

  try {
    const loaded = await loadPlanningExtensions({
      appRoot,
      workspaceRoot: join(appRoot, "workspace"),
      configPath,
    });

    assert.deepEqual(loaded.extensions, []);
  } finally {
    await fs.rm(appRoot, { recursive: true, force: true });
  }
});

test("app planning extension config overrides plugin options file", async () => {
  const appRoot = await fs.mkdtemp(join(tmpdir(), "agentloop-app-plugin-"));
  const configDir = join(appRoot, "config");
  const configPath = join(configDir, "planning-extensions.json");
  const pluginPath = join(configDir, "test-planning-plugin.mjs");
  const pluginOptionsPath = join(configDir, "test-planning-plugin.options.json");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(pluginPath, `
    export function createPlugin(options, context) {
      globalThis.__planningExtensionLoaderTest = { options, context, closed: false };
      return {
        extension() {
          return {
            name: "test-planning-plugin",
            beforePlanning: async () => ({ kind: "none" }),
          };
        },
        async close() {
          globalThis.__planningExtensionLoaderTest.closed = true;
        },
      };
    }
  `);
  await fs.writeFile(pluginOptionsPath, JSON.stringify({
    storage: {
      type: "sqlite",
      databasePath: "./plugin-default.db",
      migrateOnStart: true,
    },
    config: {
      enabled: true,
      mode: "observe",
      nested: {
        preserved: true,
        replaced: false,
      },
      arrayValue: ["base"],
    },
  }));
  await fs.writeFile(configPath, JSON.stringify({
    enabled: true,
    planningExtensions: [{
      enabled: true,
      module: "./test-planning-plugin.mjs",
      factory: "createPlugin",
      optionsPath: "./test-planning-plugin.options.json",
      options: {
        config: {
          mode: "planner_context",
          nested: {
            replaced: true,
          },
          arrayValue: ["override"],
        },
      },
    }],
  }));

  try {
    const loaded = await loadPlanningExtensions({
      appRoot,
      workspaceRoot: join(appRoot, "workspace"),
      configPath,
    });

    assert.equal(loaded.extensions.length, 1);
    assert.equal(loaded.extensions[0].name, "test-planning-plugin");
    assert.deepEqual(globalThis.__planningExtensionLoaderTest?.options, {
      storage: {
        type: "sqlite",
        databasePath: "./plugin-default.db",
        migrateOnStart: true,
      },
      config: {
        enabled: true,
        mode: "planner_context",
        nested: {
          preserved: true,
          replaced: true,
        },
        arrayValue: ["override"],
      },
    });
    assert.equal(
      (globalThis.__planningExtensionLoaderTest?.context as { configDir?: string } | undefined)?.configDir,
      configDir,
    );

    await loaded.close();
    assert.equal(globalThis.__planningExtensionLoaderTest?.closed, true);
  } finally {
    globalThis.__planningExtensionLoaderTest = undefined;
    await fs.rm(appRoot, { recursive: true, force: true });
  }
});
