import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { LocalModelConfigurationStore } from "../local-agent-runtime/src/persistence/local-model-configuration-store.ts";
import { LocalRuntimeConfigurationStore } from "../local-agent-runtime/src/persistence/local-runtime-configuration-store.ts";
import { EncryptedLocalRuntimeSecretStore } from "../local-agent-runtime/src/persistence/encrypted-local-runtime-secret-store.ts";
import { LocalRuntimeSupervisor, type LocalRuntimeControl } from "../local-agent-runtime/src/service/runtime-supervisor.ts";
import { ensureLocalAgentRuntimeConfiguration, localAgentRuntimeConfiguration, readLocalAgentIntegrationEnvironment } from "../local-agent-runtime/src/config/runtime-configuration.ts";

test("Local Agent uses its top-level source configuration in development and device storage when packaged", () => {
  const configuration = localAgentRuntimeConfiguration("/application", "/device-data", {});
  assert.equal(configuration.root, "/application/local-agent-runtime");
  assert.equal(configuration.environmentFile, "/application/local-agent-runtime/.env");
  assert.equal(configuration.providerConfigPath, "/application/local-agent-runtime/config/llm-providers.json");
  assert.deepEqual(configuration.computerCommandEnvironment, {});

  const packaged = localAgentRuntimeConfiguration("/application", "/device-data", { AGENTLOOP_AGENT_PACKAGED: "1" });
  assert.equal(packaged.environmentFile, "/device-data/agent-loop-runtime/.env");
  assert.equal(packaged.providerConfigPath, "/device-data/agent-loop-runtime/config/llm-providers.json");

  const managed = localAgentRuntimeConfiguration("/application", "/device-data", {
    LOCAL_AGENT_RUNTIME_CONFIG_ROOT: "/managed/agent-runtime",
    LOCAL_AGENT_RUNTIME_ENV_FILE: "steel.env",
    LOCAL_AGENT_PROVIDER_CONFIG_PATH: "/managed/models.json",
  });
  assert.equal(managed.environmentFile, "/managed/agent-runtime/steel.env");
  assert.equal(managed.providerConfigPath, "/managed/models.json");
});

test("Local Agent seeds credential-free templates and preserves deployment-owned files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-agent-runtime-config-"));
  const appRoot = join(root, "application");
  const configuration = localAgentRuntimeConfiguration(appRoot, join(root, "device-data"), { AGENTLOOP_AGENT_PACKAGED: "1" });
  try {
    await mkdir(join(appRoot, "agent-loop-runtime"), { recursive: true });
    await writeFile(join(appRoot, "agent-loop-runtime", ".env.example"), "STEEL_MARKET_DB_HOST=template\n");
    await mkdir(join(appRoot, "agent-loop-runtime", "config"), { recursive: true });
    await writeFile(join(appRoot, "agent-loop-runtime", "config", "mcp-servers.json"), "{\"servers\":[]}\n");
    await writeFile(join(appRoot, "agent-loop-runtime", "config", "llm-providers.example.json"), "{\"providers\":{\"example\":{\"apiKeyEnv\":\"OPENAI_API_KEY\"}}}\n");
    await ensureLocalAgentRuntimeConfiguration(appRoot, configuration);
    assert.equal(await readFile(join(configuration.root, ".env.example"), "utf8"), "STEEL_MARKET_DB_HOST=template\n");
    assert.equal(await readFile(join(configuration.root, "config", "mcp-servers.json"), "utf8"), "{\"servers\":[]}\n");
    assert.equal(await readFile(configuration.providerConfigPath, "utf8"), "{\"providers\":{\"example\":{\"apiKeyEnv\":\"OPENAI_API_KEY\"}}}\n");

    await writeFile(configuration.environmentFile, "STEEL_MARKET_DB_HOST=deployment\n");
    await writeFile(configuration.providerConfigPath, "{\"providers\":{\"deployment\":{}}}\n");
    await writeFile(join(configuration.root, "config", "mcp-servers.json"), "{\"servers\":[{\"key\":\"deployment\"}]}\n");
    await ensureLocalAgentRuntimeConfiguration(appRoot, configuration);
    assert.equal(await readFile(configuration.environmentFile, "utf8"), "STEEL_MARKET_DB_HOST=deployment\n");
    assert.equal(await readFile(configuration.providerConfigPath, "utf8"), "{\"providers\":{\"deployment\":{}}}\n");
    assert.equal(await readFile(join(configuration.root, "config", "mcp-servers.json"), "utf8"), "{\"servers\":[{\"key\":\"deployment\"}]}\n");
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

test("new packaged application roots reopen the existing model, MCP credentials, and Runtime configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-device-upgrade-"));
  const data = join(root, "device-data");
  await mkdir(data);
  let database = new AppDatabase(join(data, "supervisor.db"));
  let supervisor: LocalRuntimeSupervisor | undefined;
  try {
    const openStores = async () => {
      const secrets = new EncryptedLocalRuntimeSecretStore(join(data, "runtime-secrets"));
      const models = new LocalModelConfigurationStore(database, new EncryptedLocalRuntimeSecretStore(join(data, "model-secrets")));
      const runtimes = new LocalRuntimeConfigurationStore(database, secrets, [], undefined, models);
      await models.ready();
      supervisor = new LocalRuntimeSupervisor(database, async definition => ({
        ...definition,
        database: new AppDatabase(":memory:"),
        runs: {} as LocalRuntimeControl["runs"],
        scopes: {} as LocalRuntimeControl["scopes"],
        modelKeys: [], activeRunIds: new Set<string>(),
      }), undefined, undefined, runtimes);
      await supervisor.ready("device-runtime");
      return { secrets, models, runtimes };
    };
    const original = await openStores();
    await original.models.write({ reuseCloudModels: false, providers: [{
      key: "device-provider", displayName: "My provider", baseUrl: "https://models.example.test/v1", apiKey: "fixture-model-secret",
      models: [{ key: "my-model", displayName: "My model", providerModel: "upstream", protocol: "chat-completions" }],
    }] });
    await original.runtimes.apply("device-runtime", { mcpServers: [{
      key: "my-mcp", displayName: "My MCP", transport: "http", url: "https://mcp.example.test/",
      auth: { kind: "bearer", token: "fixture-mcp-secret" },
    }] });
    const savedRuntime = await original.runtimes.configuration("device-runtime");
    const savedModels = await original.models.read();
    const second = await supervisor!.create("Saved device Runtime");
    const keys = await original.runtimes.secretStorageKeysForRuntime("device-runtime");
    const savedSecrets = await Promise.all(keys.map(key => original.secrets.read(key)));
    for (const version of ["old-application", "new-application"]) {
      const app = join(root, version);
      await mkdir(join(app, "agent-loop-runtime/config"), { recursive: true });
      await writeFile(join(app, "agent-loop-runtime/config/mcp-servers.json"), JSON.stringify({ servers: [], release: version }));
      await writeFile(join(app, "agent-loop-runtime/config/llm-providers.example.json"), JSON.stringify({ providers: {}, release: version }));
      const configuration = localAgentRuntimeConfiguration(app, data, { AGENTLOOP_AGENT_PACKAGED: "1" });
      await ensureLocalAgentRuntimeConfiguration(app, configuration);
      if (version === "old-application") {
        await writeFile(configuration.providerConfigPath, "device provider configuration");
        await writeFile(join(configuration.root, "config/mcp-servers.json"), "device MCP configuration");
        await writeFile(configuration.environmentFile, "DEVICE_SETTING=preserved\n");
      }
      assert.equal(await readFile(configuration.providerConfigPath, "utf8"), "device provider configuration");
      assert.equal(await readFile(join(configuration.root, "config/mcp-servers.json"), "utf8"), "device MCP configuration");
      assert.equal(await readFile(configuration.environmentFile, "utf8"), "DEVICE_SETTING=preserved\n");
    }
    await supervisor!.close();
    database = new AppDatabase(join(data, "supervisor.db"));
    const upgraded = await openStores();
    assert.deepEqual(await upgraded.models.read(), savedModels);
    assert.equal((await upgraded.models.resolve()).environment.LOCAL_MODEL_KEY_DEVICE_PROVIDER, "fixture-model-secret");
    assert.deepEqual(await upgraded.runtimes.configuration("device-runtime"), savedRuntime);
    assert.equal((await supervisor!.list()).find(runtime => runtime.id === second.id)?.displayName, "Saved device Runtime");
    assert.deepEqual(await Promise.all(keys.map(key => upgraded.secrets.read(key))), savedSecrets);
    assert.deepEqual(await upgraded.runtimes.missingCredentialServerKeys("device-runtime"), []);
  } finally {
    if (supervisor) await supervisor.close();
    else await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
