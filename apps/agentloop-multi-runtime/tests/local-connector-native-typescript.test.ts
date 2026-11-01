import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LocalConnectorConfigurationStore } from "../local-agent-runtime/src/persistence/local-connector-configuration-store.ts";

test("Local Agent connector modules are parseable by Node's native TypeScript runtime", () => {
  for (const relativePath of [
    "../src/connectors/connector-runtime-service.ts",
    "../src/connectors/environment-connector-connections.ts",
    "../local-agent-runtime/src/persistence/local-connector-configuration-store.ts",
  ]) {
    const result = spawnSync(process.execPath, ["--check", fileURLToPath(new URL(relativePath, import.meta.url))], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("Local connector credential providers retain their configured secret store", async () => {
  const secrets = new Map<string, Readonly<Record<string, string>>>([
    ["connector-secret", { accessToken: "token-value" }],
  ]);
  const store = new LocalConnectorConfigurationStore(
    { exec: async () => undefined, prepare: () => ({ all: async () => [] }) },
    {
      write: async () => "unused",
      read: async (key) => secrets.get(key),
      remove: async () => undefined,
    },
  );

  const resolved = await store.resolve("runtime-1");
  assert.deepEqual(await resolved.runtime.credentialProvider.get("connector-secret"), { accessToken: "token-value" });
});
