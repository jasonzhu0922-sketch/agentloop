import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCapabilityGrant,
  loadMcpToolsFromConfig,
  loadMcpToolsFromConfigWithFactory,
  loadOptionalMcpToolsFromConfigFile,
  parseMcpServersConfig,
  type McpSessionFactory,
} from "@zhujun/agentloop";

test("MCP registration file parses server auth and materializes runtime tools", async () => {
  const config = parseMcpServersConfig({
    defaultTrust: "untrusted",
    servers: [
      {
        key: "amap-maps",
        transport: "http",
        url: "https://mcp.amap.com/mcp",
        auth: { kind: "query", name: "key", secretEnv: "AMAP_MCP_KEY" },
        toolAllowlist: ["search", "route"],
        aliases: ["高德", "amap"],
        capabilities: [{
          id: "spatial_planning.route",
          category: "spatial_planning",
          label: "Route planning",
        }],
      },
    ],
  });

  const factory: McpSessionFactory = {
    create: async () => ({
      request: async (method) => {
        if (method === "tools/list") {
          return {
            tools: [{
              name: "search",
              title: "Search",
              description: "Search map data",
              inputSchema: { type: "object" },
            }],
          };
        }
        if (method === "tools/call") {
          return {
            content: [{ type: "text", text: "ok" }],
            isError: false,
          };
        }
        return {};
      },
      close: async () => undefined,
    }),
  };

  const integration = await loadMcpToolsFromConfigWithFactory(config, factory);
  assert.equal(integration.failedServers.length, 0);
  assert.equal(integration.loadedServers.length, 1);
  assert.equal(integration.tools.length, 1);
  assert.equal(integration.tools[0]?.name, "mcp_amap_maps_search");
  assert.deepEqual(integration.tools[0]?.source, {
    id: "amap-maps",
    aliases: ["高德", "amap"],
    transport: "mcp",
    capabilities: [{
      id: "spatial_planning.route",
      category: "spatial_planning",
      label: "Route planning",
    }],
  });

  const result = await integration.tools[0]!.execute(
    {
      grant: createCapabilityGrant({
        actorUserId: "user-1",
        runId: "run-1",
        depth: 0,
        allowedToolNames: ["mcp_amap_maps_search"],
        allowedSkillIds: [],
      }),
      signal: undefined,
    },
    { query: "hotel" },
  );
  assert.equal((result as { readonly text?: string }).text, "ok");
  assert.equal((result as { readonly evidenceReceipt?: { readonly schema?: string } }).evidenceReceipt?.schema, "agentloop.toolEvidenceReceipt/v1");
});

test("tabular MCP responses project schema and returned-row facts without inferring source cardinality", async () => {
  const config = parseMcpServersConfig({
    servers: [{ key: "structured-db", transport: "http", url: "https://mcp.example.test" }],
  });
  const integration = await loadMcpToolsFromConfigWithFactory(config, {
    create: async () => ({
      request: async (method) => method === "tools/list"
        ? { tools: [{ name: "query", inputSchema: { type: "object" } }] }
        : {
          content: [{
            type: "text",
            text: JSON.stringify({
              fields: [{ name: "TABLE_NAME" }, { name: "ROW_COUNT" }],
              rows: [["T_ODS_CUSTOMER", 4117], ["T_ODS_ORDER", 200]],
              totalRows: 4117,
            }),
          }],
          isError: false,
        },
      close: async () => undefined,
    }),
  });
  const result = await integration.tools[0]!.execute({
    grant: createCapabilityGrant({
      actorUserId: "user-structured-db",
      runId: "run-structured-db",
      depth: 0,
      allowedToolNames: ["mcp_structured_db_query"],
      allowedSkillIds: [],
    }),
  }, {});
  const receipt = (result as { evidenceReceipt: { facts: Array<Record<string, unknown>>; evidenceKinds: { satisfied: string[] } } }).evidenceReceipt;
  assert.deepEqual(receipt.evidenceKinds.satisfied, ["mcp_tool_call", "source_summary", "schema_summary", "record_counts"]);
  assert.deepEqual(receipt.facts.find((fact) => fact.kind === "schema_summary"), {
    kind: "schema_summary",
    fieldCount: 2,
    fields: ["TABLE_NAME", "ROW_COUNT"],
  });
  assert.deepEqual(receipt.facts.find((fact) => fact.kind === "record_counts"), {
    kind: "record_counts",
    returnedRows: 2,
    countSemantics: "returned_rows",
  });
});

test("multiple MCP servers retain separate sources and tool namespaces", async () => {
  const config = parseMcpServersConfig({
    servers: [
      { key: "amap-maps", transport: "http", url: "https://mcp.amap.com/mcp" },
      { key: "weather", transport: "http", url: "https://weather.example.test/mcp" },
    ],
  });
  const integration = await loadMcpToolsFromConfigWithFactory(config, {
    create: async (server) => ({
      request: async (method) => method === "tools/list"
        ? { tools: [{ name: "lookup", inputSchema: { type: "object" } }] }
        : {},
      close: async () => undefined,
    }),
  });
  assert.deepEqual(integration.loadedServers.map((server) => server.key), ["amap-maps", "weather"]);
  assert.deepEqual(integration.tools.map((tool) => tool.name), ["mcp_amap_maps_lookup", "mcp_weather_lookup"]);
  assert.deepEqual(integration.tools.map((tool) => tool.source?.id), ["amap-maps", "weather"]);
});

test("MCP server keys are unique ToolSource identities", () => {
  assert.throws(() => parseMcpServersConfig({
    servers: [
      { key: "duplicate", transport: "http", url: "https://first.example.test/mcp" },
      { key: "duplicate", transport: "http", url: "https://second.example.test/mcp" },
    ],
  }), /duplicate key duplicate/);
  assert.throws(() => parseMcpServersConfig({
    servers: [
      { key: "weather-api", transport: "http", url: "https://first.example.test/mcp" },
      { key: "weather_api", transport: "http", url: "https://second.example.test/mcp" },
    ],
  }), /duplicate normalized key weather_api/);
});

test("structured MCP tool results promote source_summary evidence receipts", async () => {
  const config = parseMcpServersConfig({
    defaultTrust: "untrusted",
    servers: [
      {
        key: "amap-maps",
        transport: "http",
        url: "https://mcp.amap.com/mcp",
        toolAllowlist: ["maps_direction_driving"],
      },
    ],
  });

  const factory: McpSessionFactory = {
    create: async () => ({
      request: async (method) => {
        if (method === "tools/list") {
          return {
            tools: [{
              name: "maps_direction_driving",
              title: "Drive",
              description: "Driving directions",
              inputSchema: { type: "object" },
            }],
          };
        }
        if (method === "tools/call") {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                origin: "116.397463,39.909187",
                destination: "121.144625,28.859042",
                paths: [{
                  distance: "1455377",
                  duration: "54633",
                  steps: [{ instruction: "向北行驶396米右转" }],
                }],
              }),
            }],
            isError: false,
          };
        }
        return {};
      },
      close: async () => undefined,
    }),
  };

  const integration = await loadMcpToolsFromConfigWithFactory(config, factory);
  const result = await integration.tools[0]!.execute(
    {
      grant: createCapabilityGrant({
        actorUserId: "user-1",
        runId: "run-1",
        depth: 0,
        allowedToolNames: ["mcp_amap_maps_maps_direction_driving"],
        allowedSkillIds: [],
      }),
      signal: undefined,
    },
    { origin: "116.397463,39.909187", destination: "121.144625,28.859042" },
  );

  const receipt = (result as { readonly evidenceReceipt?: { readonly facts?: Array<{ readonly kind?: string; readonly fields?: Array<{ readonly name?: string; readonly value?: string }>; readonly textPreview?: string }>; readonly evidenceKinds?: { readonly satisfied?: string[] } } }).evidenceReceipt;
  assert.equal(receipt?.facts?.[0]?.kind, "source_summary");
  assert.deepEqual(receipt?.evidenceKinds?.satisfied?.sort(), ["mcp_tool_call", "source_summary"]);
  assert.ok(receipt?.facts?.[0]?.fields?.some((field) => field.name === "paths[0].distance" && field.value === "1455377"));
  assert.ok(receipt?.facts?.[0]?.fields?.some((field) => field.name === "paths[0].duration" && field.value === "54633"));
  assert.match(receipt?.facts?.[0]?.textPreview ?? "", /origin=116\.397463,39\.909187/);
});

test("fixed MCP config file is optional at startup", async () => {
  await withWorkingDirectory(mkdtempSync(join(tmpdir(), "agentloop-mcp-")), async () => {
    const result = await loadOptionalMcpToolsFromConfigFile(join(process.cwd(), "config/mcp-servers.json"));
    assert.equal(result.loadedServers.length, 0);
    assert.equal(result.failedServers.length, 0);
    assert.equal(result.tools.length, 0);
  });
});

test("fixed MCP config file is auto-discovered from config directory", async () => {
  await withWorkingDirectory(mkdtempSync(join(tmpdir(), "agentloop-mcp-")), async (dir) => {
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config/mcp-servers.json"), JSON.stringify({
      servers: [{
        key: "broken",
        transport: "http",
        url: "http://127.0.0.1:1/mcp",
      }],
    }), "utf8");

    const result = await loadOptionalMcpToolsFromConfigFile(join(dir, "config/mcp-servers.json"));
    assert.equal(result.loadedServers.length, 0);
    assert.equal(result.failedServers.length, 1);
    assert.equal(result.failedServers[0]?.key, "broken");
  });
});

test("notifications initialized can be fire-and-forget", async () => {
  const config = parseMcpServersConfig({
    servers: [{
      key: "amap-maps",
      transport: "http",
      url: "https://mcp.amap.com/mcp",
      auth: { kind: "query", name: "key", secretEnv: "AMAP_MCP_KEY" },
    }],
  });
  const seenMethods: string[] = [];
  const factory: McpSessionFactory = {
    create: async () => ({
      request: async (method) => {
        seenMethods.push(method);
        if (method === "tools/list") {
          return { tools: [] };
        }
        return {};
      },
      close: async () => undefined,
    }),
  };
  const integration = await loadMcpToolsFromConfigWithFactory(config, factory);
  assert.deepEqual(seenMethods, ["tools/list"]);
  assert.equal(integration.failedServers.length, 0);
});

test("MCP credentials resolve from the explicit deployment environment", async () => {
  let receivedKey: string | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    receivedKey = new URL(String(input)).searchParams.get("key") ?? undefined;
    const method = new Headers(init?.headers).get("mcp-method");
    if (method === "notifications/initialized") return new Response(null, { status: 204 });
    if (method === "tools/list") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const integration = await loadMcpToolsFromConfig(parseMcpServersConfig({
      servers: [{
        key: "amap-maps",
        transport: "http",
        url: "https://mcp.example.test/mcp",
        auth: { kind: "query", name: "key", secretEnv: "AMAP_MCP_KEY" },
      }],
    }), { environment: { AMAP_MCP_KEY: "device-owned-key" } });
    assert.equal(integration.failedServers.length, 0);
    assert.equal(receivedKey, "device-owned-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP arbitrary headers resolve from the explicit deployment environment", async () => {
  let receivedApiKey: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    receivedApiKey = headers.get("x-api-key");
    const method = headers.get("mcp-method");
    if (method === "notifications/initialized") return new Response(null, { status: 204 });
    if (method === "tools/list") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const config = parseMcpServersConfig({
      servers: [{
        key: "ontoflow-jtbc",
        transport: "http",
        url: "https://mcp.example.test/mcp",
        auth: { kind: "headers_env", headerEnvs: { "X-API-Key": "ONTOFLOW_JTBC_API_KEY" } },
      }],
    });
    const integration = await loadMcpToolsFromConfig(config, { environment: { ONTOFLOW_JTBC_API_KEY: "device-owned-key" } });
    assert.equal(integration.failedServers.length, 0);
    assert.equal(receivedApiKey, "device-owned-key");
    const missingSecret = await loadMcpToolsFromConfig(parseMcpServersConfig({
      servers: [{
        key: "missing-secret",
        transport: "http",
        url: "https://mcp.example.test/mcp",
        auth: { kind: "headers_env", headerEnvs: { "X-API-Key": "MISSING_KEY" } },
      }],
    }), { environment: {} });
    assert.equal(missingSecret.failedServers.length, 1);
    assert.match(missingSecret.failedServers[0]?.message ?? "", /Missing MCP header env MISSING_KEY/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP server uses its configured protocol version and session ID for the whole HTTP session", async () => {
  const requests: Array<{ readonly method: string; readonly protocolVersion: string | null; readonly sessionId: string | null; readonly payload: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const method = String(payload.method);
    requests.push({ method, protocolVersion: headers.get("mcp-protocol-version"), sessionId: headers.get("mcp-session-id"), payload });
    if (method === "notifications/initialized") return new Response(null, { status: 204 });
    if (method === "tools/list") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { tools: [] } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} })}\r\n\r\n`, {
      headers: { "content-type": "text/event-stream", "mcp-session-id": "test-session" },
    });
  };
  try {
    const integration = await loadMcpToolsFromConfig(parseMcpServersConfig({
      servers: [{
        key: "legacy-fastmcp",
        transport: "http",
        url: "https://mcp.example.test/mcp",
        protocolVersion: "2024-11-05",
      }],
    }));
    assert.equal(integration.failedServers.length, 0);
    assert.equal((requests[0]?.payload.params as { protocolVersion?: string }).protocolVersion, "2024-11-05");
    assert.deepEqual(
      requests.map(({ method, protocolVersion, sessionId }) => ({ method, protocolVersion, sessionId })),
      [
        { method: "initialize", protocolVersion: null, sessionId: null },
        { method: "notifications/initialized", protocolVersion: "2024-11-05", sessionId: "test-session" },
        { method: "tools/list", protocolVersion: "2024-11-05", sessionId: "test-session" },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function withWorkingDirectory<T>(dir: string, callback: (dir: string) => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await callback(dir);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}
