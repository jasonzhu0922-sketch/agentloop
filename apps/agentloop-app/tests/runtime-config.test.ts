import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { resolveApplicationRuntimePaths } from "../src/runtime-config.ts";

const appRoot = "/srv/agentloop/apps/agentloop-app";

test("application-owned runtime paths do not depend on the process working directory", () => {
  const paths = resolveApplicationRuntimePaths({ appRoot });

  assert.equal(paths.workspaceRoot, resolve(appRoot, "workspace"));
  assert.equal(paths.databasePath, resolve(appRoot, "data/agentloop.db"));
  assert.deepEqual(paths.customSkillDirectories, []);
});

test("runtime path overrides support absolute paths and app-relative paths", () => {
  const paths = resolveApplicationRuntimePaths({
    appRoot,
    databasePath: ":memory:",
    providerConfigPath: "./config/providers.json",
    workspaceRoot: "/var/lib/agentloop/workspace",
    customSkillDirectories: ["./custom-skills", "/opt/agentloop-skills"],
  });

  assert.equal(paths.databasePath, ":memory:");
  assert.equal(paths.providerConfigPath, resolve(appRoot, "config/providers.json"));
  assert.equal(paths.workspaceRoot, "/var/lib/agentloop/workspace");
  assert.deepEqual(paths.customSkillDirectories, [
    resolve(appRoot, "custom-skills"),
    "/opt/agentloop-skills",
  ]);
});
