import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { loadMcpToolsFromConfig, loadMcpToolsFromConfigWithFactory, parseMcpServersConfig, type McpSessionFactory } from "../src/mcp/mcp-loader.ts";

function executionContext(toolName: string) {
  return {
    grant: createCapabilityGrant({
      actorUserId: "user-mcp-loader",
      runId: "run-mcp-loader",
      depth: 0,
      allowedToolNames: [toolName],
      allowedSkillIds: [],
    }),
  };
}

function tabularFactory(): McpSessionFactory {
  return {
    create: async () => ({
      request: async (method, params) => {
        if (method === "tools/list") {
          return {
            tools: [
              { name: "schema_query", inputSchema: { type: "object" } },
              { name: "count_query", inputSchema: { type: "object" } },
            ],
          };
        }
        const toolName = typeof params?.name === "string" ? params.name : "";
        const payload = toolName === "schema_query"
          ? {
            fields: ["COLNAME", "TYPENAME", "LENGTH", "NULLS", "COLNO"],
            rows: [["CUSTOMER_ID", "INTEGER", 10, "N", 1]],
          }
          : { fields: ["CNT"], rows: [[4117]] };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          isError: false,
        };
      },
      close: async () => undefined,
    }),
  };
}

test("MCP tabular receipts promote declared schema and count evidence", async () => {
  const config = parseMcpServersConfig({
    servers: [{
      key: "ods-source",
      transport: "http",
      url: "https://mcp.example.test",
      capabilities: [{
        id: "data_asset.ods_read",
        category: "data_asset",
        producesEvidenceKinds: ["source_summary", "schema_summary", "record_counts"],
      }],
    }],
  });
  const integration = await loadMcpToolsFromConfigWithFactory(config, tabularFactory());
  const schemaTool = integration.tools.find((tool) => tool.name === "mcp_ods_source_schema_query");
  const countTool = integration.tools.find((tool) => tool.name === "mcp_ods_source_count_query");
  assert.ok(schemaTool);
  assert.ok(countTool);

  const schemaResult = await schemaTool.execute(executionContext(schemaTool.name), {});
  const countResult = await countTool.execute(executionContext(countTool.name), {});
  const schemaReceipt = (schemaResult as { evidenceReceipt: { facts: Array<Record<string, unknown>>; evidenceKinds: { satisfied: string[] } } }).evidenceReceipt;
  const countReceipt = (countResult as { evidenceReceipt: { facts: Array<Record<string, unknown>>; evidenceKinds: { satisfied: string[] } } }).evidenceReceipt;

  assert.ok(schemaReceipt.evidenceKinds.satisfied.includes("source_summary"));
  assert.ok(schemaReceipt.evidenceKinds.satisfied.includes("schema_summary"));
  assert.equal(schemaReceipt.evidenceKinds.satisfied.includes("record_counts"), false);
  assert.equal(schemaReceipt.facts.some((fact) => fact.kind === "schema_summary"), true);
  assert.ok(countReceipt.evidenceKinds.satisfied.includes("source_summary"));
  assert.ok(countReceipt.evidenceKinds.satisfied.includes("record_counts"));
  assert.equal(countReceipt.evidenceKinds.satisfied.includes("schema_summary"), false);
  assert.equal(countReceipt.facts.some((fact) => fact.kind === "record_counts"), true);
});

test("MCP tabular receipts do not fabricate semantic evidence without a capability declaration", async () => {
  const config = parseMcpServersConfig({
    servers: [{ key: "undeclared-source", transport: "http", url: "https://mcp.example.test" }],
  });
  const integration = await loadMcpToolsFromConfigWithFactory(config, tabularFactory());
  const schemaTool = integration.tools.find((tool) => tool.name === "mcp_undeclared_source_schema_query");
  assert.ok(schemaTool);
  const result = await schemaTool.execute(executionContext(schemaTool.name), {});
  const receipt = (result as { evidenceReceipt: { facts: Array<Record<string, unknown>>; evidenceKinds: { satisfied: string[] } } }).evidenceReceipt;
  assert.ok(receipt.evidenceKinds.satisfied.includes("source_summary"));
  assert.equal(receipt.evidenceKinds.satisfied.includes("schema_summary"), false);
  assert.equal(receipt.evidenceKinds.satisfied.includes("record_counts"), false);
  assert.equal(receipt.facts.some((fact) => fact.kind === "structured_result_shape"), true);
});

test("direct Local Agent-style MCP credentials use the shared HTTP loader", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ readonly url: string; readonly headers: Headers; readonly method: string }> = [];
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const method = JSON.parse(String(init?.body ?? "{}")).method as string;
    requests.push({ url: String(input), headers, method });
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    const body = method === "tools/list"
      ? { jsonrpc: "2.0", id: 2, result: { tools: [] } }
      : { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const integration = await loadMcpToolsFromConfig(parseMcpServersConfig({
      servers: [
        {
          key: "amap-maps",
          transport: "http",
          url: "https://mcp.example.test/amap",
          auth: { kind: "query_parameter", parameterName: "key", value: "AMAP_DIRECT_KEY" },
        },
        {
          key: "ontoflow-jtbc",
          transport: "http",
          url: "https://mcp.example.test/ontoflow",
          auth: { kind: "api_key_header", headerName: "X-API-Key", value: "ONTOFLOW_DIRECT_KEY" },
        },
      ],
    }));
    assert.deepEqual(integration.failedServers, []);
    assert.equal(integration.loadedServers.length, 2);
    const amapInitialize = requests.find((request) => request.method === "initialize" && request.url.includes("/amap"));
    const ontoflowInitialize = requests.find((request) => request.method === "initialize" && request.url.includes("/ontoflow"));
    assert.equal(new URL(amapInitialize!.url).searchParams.get("key"), "AMAP_DIRECT_KEY");
    assert.equal(ontoflowInitialize!.headers.get("X-API-Key"), "ONTOFLOW_DIRECT_KEY");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP startup handshake and discovery honor the configured request timeout", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    const integration = await loadMcpToolsFromConfig(parseMcpServersConfig({
      servers: [{ key: "slow-source", transport: "http", url: "https://mcp.example.test", timeoutMs: 20 }],
    }));
    assert.deepEqual(integration.loadedServers, []);
    assert.equal(integration.failedServers.length, 1);
    assert.equal(integration.failedServers[0]?.key, "slow-source");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
