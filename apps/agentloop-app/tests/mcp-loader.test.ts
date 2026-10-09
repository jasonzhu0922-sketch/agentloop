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
