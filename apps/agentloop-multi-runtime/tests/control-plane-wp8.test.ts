import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd().endsWith("agentloop-multi-runtime") ? process.cwd() : join(process.cwd(), "apps", "agentloop-multi-runtime");

test("WP-8 keeps file configuration behind explicit development mode", async () => {
  const host = await readFile(join(root, "src", "runtime-host", "main.ts"), "utf8");
  const localMain = await readFile(join(root, "local-agent-runtime", "src", "main.ts"), "utf8");
  const localFactory = await readFile(join(root, "local-agent-runtime", "src", "application", "local-runtime-factory.ts"), "utf8");
  const launcher = await readFile(join(root, "scripts", "start-local.mjs"), "utf8");
  assert.match(host, /value === undefined \|\| value === "control_plane"/);
  assert.match(host, /configurationSource === "file" \? await loadSkillDirectoriesConfig/);
  assert.match(host, /configurationSource === "file" \? await loadStepExecutionStrategyProfileConfig/);
  assert.match(localMain, /LOCAL_RUNTIME_CONFIGURATION_SOURCE \?\? "control_plane"/);
  assert.match(localMain, /localConfigurationSource === "file" \? await readLocalAgentIntegrationEnvironment/);
  assert.match(localFactory, /const fileConfigurationMode = this\.input\.controlPlane === undefined/);
  assert.match(localFactory, /fileConfigurationMode \? await loadPracticeProfileConfig/);
  assert.match(launcher, /RUNTIME_CONFIGURATION_SOURCE \?\? "file"/);
  assert.match(launcher, /RUNTIME_CONFIGURATION_SOURCE: runtimeConfigurationSource/);
});
