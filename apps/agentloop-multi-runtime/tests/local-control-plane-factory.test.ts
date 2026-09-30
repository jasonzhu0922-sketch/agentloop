import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalRuntimeFactory } from "../local-agent-runtime/src/application/local-runtime-factory.ts";
import type { LocalRuntimeDefinition } from "../local-agent-runtime/src/application/runtime-supervisor.ts";
import type { RuntimeConfigurationSnapshot } from "../control-plane/contracts/index.ts";

const definition: LocalRuntimeDefinition = { id: "runtime-local", displayName: "Local test", storageKey: "runtime-local", isDefault: false };
const hash = "a".repeat(64);

test("Local Runtime Factory admits a control-plane snapshot, restores only an unexpired cache, and fails closed on device revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-local-factory-control-plane-"));
  const requests: string[] = [];
  const resolvedAt = Date.now();
  const snapshot = makeSnapshot("snapshot-fresh", "fresh-model", resolvedAt, resolvedAt + 60_000);
  let mode: "fresh" | "unavailable" | "revoked" = "fresh";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/desired-configuration")) {
      if (mode === "revoked") return new Response("", { status: 403 });
      if (mode === "unavailable") return new Response("", { status: 503 });
      return new Response(JSON.stringify(snapshot), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/apply-receipts")) return new Response(JSON.stringify({ status: "recorded" }), { status: 201 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    await mkdir(join(root, "empty-skills"));
    await writeFile(join(root, "skill-directories.json"), JSON.stringify({ schema: "agentloop.skillDirectories/v1", customSkillDirectories: [] }));
    const appRoot = join(process.cwd(), "apps", "agentloop-multi-runtime");
    const base = {
      appRoot,
      statePath: join(root, "state.json"),
      databasePath: join(root, "agentloop.db"),
      workspaceRoot: join(root, "workspace"),
      skillPackageStoreRoot: join(root, "skill-packages"),
      runtimeDataRoot: join(root, "runtimes"),
      providerConfigPath: join(appRoot, "config", "llm-providers.json"),
      skillDirectoriesConfigPath: join(root, "skill-directories.json"),
      stepExecutionStrategyConfigPath: join(appRoot, "config", "step-execution-strategy.json"),
      practiceProfileConfigPath: join(appRoot, "config", "practice-profiles.json"),
      environment: { AGENTLOOP_BUNDLED_SKILL_DIRECTORIES: join(root, "empty-skills") },
      integrationEnvironment: { TEST_API_KEY: "local-test-key", WEB_SEARCH_DISABLED: "1" },
      computerCommandEnvironment: { ENTERPRISE_INFO_ENV_FILE: "/never-forward-this-path" },
      controlPlane: { deliveryUrl: "https://control-plane.example.test", deviceId: "device-local", deviceToken: "device-token", tenantId: "tenant-local", devicePrivateKey: "device-private-key" },
    } as const;

    const first = await new LocalRuntimeFactory(base).create(definition, join(root, "workspace"), join(root, "uploads"));
    try {
      assert.deepEqual(first.modelKeys, ["fresh-model"]);
      assert.ok(requests.some((request) => request.startsWith("POST https://control-plane.example.test/delivery/v1/apply-receipts")));
    } finally {
      await first.database.close();
    }

    mode = "unavailable";
    const restored = await new LocalRuntimeFactory(base).create(definition, join(root, "workspace"), join(root, "uploads"));
    try {
      assert.deepEqual(restored.modelKeys, ["fresh-model"]);
    } finally {
      await restored.database.close();
    }

    mode = "revoked";
    await assert.rejects(
      () => new LocalRuntimeFactory(base).create({ ...definition, id: "runtime-revoked", storageKey: "runtime-revoked" }, join(root, "workspace"), join(root, "uploads")),
      (error: unknown) => error instanceof Error && error.message === "device_not_authorized",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

function makeSnapshot(snapshotId: string, modelKey: string, resolvedAt: number, validUntil: number): RuntimeConfigurationSnapshot {
  return {
    contractVersion: "control-plane/v1", snapshotId, configurationRevision: 1,
    target: { plane: "local", tenantId: "tenant-local", runtimeId: "runtime-local", deviceId: "device-local" },
    resolvedAt, validUntil,
    modelRoute: {
      releaseId: "model-release", contentHash: hash,
      providerConfiguration: {
        defaultProvider: "test", defaultModelKey: modelKey,
        providers: { test: { kind: "openai-compatible", baseUrl: "https://models.example.test/v1", apiKeyEnv: "TEST_API_KEY", defaultModel: modelKey, protocol: "chat-completions" } },
        models: { [modelKey]: { providerKey: "test", providerModel: modelKey, displayName: modelKey } },
      },
    },
    integrations: [], skills: [], policies: [],
  };
}
