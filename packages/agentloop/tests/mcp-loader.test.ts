import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { loadMcpToolsFromConfigWithFactory, parseMcpServersConfig, type McpSessionFactory } from "../src/mcp/mcp-loader.ts";

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
