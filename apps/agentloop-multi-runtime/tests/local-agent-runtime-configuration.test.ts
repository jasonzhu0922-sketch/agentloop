import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureLocalAgentRuntimeConfiguration, localAgentRuntimeConfiguration, readLocalAgentIntegrationEnvironment } from "../local-agent-runtime/src/runtime-configuration.ts";

test("Local Agent uses its top-level source configuration in development and device storage when packaged", () => {
  const configuration = localAgentRuntimeConfiguration("/application", "/device-data", {});
  assert.equal(configuration.root, "/application/local-agent-runtime");
  assert.equal(configuration.environmentFile, "/application/local-agent-runtime/.env");
  assert.deepEqual(configuration.computerCommandEnvironment, {
    ENTERPRISE_INFO_ENV_FILE: "/application/local-agent-runtime/.env",
    STEEL_MARKET_DB_ENV_FILE: "/application/local-agent-runtime/.env",
  });

  const packaged = localAgentRuntimeConfiguration("/application", "/device-data", { AGENTLOOP_AGENT_PACKAGED: "1" });
  assert.equal(packaged.environmentFile, "/device-data/agent-loop-runtime/.env");

  const managed = localAgentRuntimeConfiguration("/application", "/device-data", {
    LOCAL_AGENT_RUNTIME_CONFIG_ROOT: "/managed/agent-runtime",
    LOCAL_AGENT_RUNTIME_ENV_FILE: "steel.env",
  });
  assert.equal(managed.environmentFile, "/managed/agent-runtime/steel.env");
});

test("Local Agent seeds only the credential-free template and preserves deployment .env", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-agent-runtime-config-"));
  const appRoot = join(root, "application");
  const configuration = localAgentRuntimeConfiguration(appRoot, join(root, "device-data"), { AGENTLOOP_AGENT_PACKAGED: "1" });
  try {
    await mkdir(join(appRoot, "agent-loop-runtime"), { recursive: true });
    await writeFile(join(appRoot, "agent-loop-runtime", ".env.example"), "STEEL_MARKET_DB_HOST=template\n");
    await ensureLocalAgentRuntimeConfiguration(appRoot, configuration);
    assert.equal(await readFile(join(configuration.root, ".env.example"), "utf8"), "STEEL_MARKET_DB_HOST=template\n");

    await writeFile(configuration.environmentFile, "STEEL_MARKET_DB_HOST=deployment\n");
    await ensureLocalAgentRuntimeConfiguration(appRoot, configuration);
    assert.equal(await readFile(configuration.environmentFile, "utf8"), "STEEL_MARKET_DB_HOST=deployment\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Local Agent reads integration secrets only from its own environment file", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-agent-runtime-env-"));
  const configuration = localAgentRuntimeConfiguration(join(root, "application"), root, { AGENTLOOP_AGENT_PACKAGED: "1" });
  try {
    assert.deepEqual(await readLocalAgentIntegrationEnvironment(configuration), {});
    await mkdir(configuration.root, { recursive: true });
    await writeFile(configuration.environmentFile, [
      "OPENAI_API_KEY=local-model-key",
      "WEB_SEARCH_ENDPOINT=https://search.example.test/v1",
      "WEB_SEARCH_API_KEY=local-search-key",
      "STEEL_MARKET_DB_PASSWORD=not-forwarded-to-commands",
      "# comment",
    ].join("\n"));
    assert.deepEqual(await readLocalAgentIntegrationEnvironment(configuration), {
      OPENAI_API_KEY: "local-model-key",
      WEB_SEARCH_ENDPOINT: "https://search.example.test/v1",
      WEB_SEARCH_API_KEY: "local-search-key",
      STEEL_MARKET_DB_PASSWORD: "not-forwarded-to-commands",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
