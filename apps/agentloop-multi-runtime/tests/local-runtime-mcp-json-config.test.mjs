import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeMcpConfiguration, runtimeMcpConfigurationExample } from "../web/client/local-runtime/mcp-json-config.js";

const server = {
  displayName: "Knowledge", key: "knowledge", transport: "http",
  url: "https://mcp.example.test/mcp", auth: { kind: "none" },
};

test("Runtime MCP JSON preserves editable policies and existing credential references", () => {
  const configuration = [{
    ...server, id: "server-id", auth: { kind: "bearer", credentialConfigured: true },
    aliases: ["知识库", "knowledge-base"],
    capabilities: [{ id: "search", category: "search", producesEvidenceKinds: ["source_summary"] }],
    toolAllowlist: ["search"], toolBlocklist: ["delete"],
    timeoutMs: 20000, protocolVersion: "2024-11-05", trust: "trusted",
  }];
  assert.deepEqual(parseRuntimeMcpConfiguration(JSON.stringify(configuration)), configuration);
  assert.deepEqual(parseRuntimeMcpConfiguration("[]"), []);
  assert.deepEqual(parseRuntimeMcpConfiguration(JSON.stringify(runtimeMcpConfigurationExample)), runtimeMcpConfigurationExample);
});

test("Runtime MCP JSON preserves newly entered credentials for every supported auth kind", () => {
  for (const auth of [
    { kind: "none" }, { kind: "bearer", token: "new-token" },
    { kind: "api_key_header", headerName: "X-API-Key", value: "new-key" },
    { kind: "basic", username: "reader", password: "new-password" },
    { kind: "query_parameter", parameterName: "key", value: "new-key" },
    { kind: "custom_headers", headers: { "X-Custom": "new-key" } },
    { kind: "custom_headers", headerNames: ["X-Custom"], credentialConfigured: true },
  ]) {
    const configuration = [{ ...server, auth }];
    assert.deepEqual(parseRuntimeMcpConfiguration(JSON.stringify(configuration)), configuration);
  }
});

test("Runtime MCP JSON rejects malformed documents and invalid server fields", () => {
  assert.throws(() => parseRuntimeMcpConfiguration("["), /JSON 格式错误/);
  for (const value of [null, {}, { mcpServers: [] }]) {
    assert.throws(() => parseRuntimeMcpConfiguration(JSON.stringify(value)), /JSON 数组/);
  }
  for (const [value, error] of [
    [[null], /JSON 对象/],
    [[{ ...server, key: "" }], /\.key/],
    [[{ ...server, transport: "stdio" }], /\.transport/],
    [[{ ...server, url: "invalid" }], /\.url/],
    [[{ ...server, url: "file:///tmp/mcp" }], /HTTP/],
    [[{ ...server, url: "https://user:password@mcp.example.test/mcp" }], /用户名或密码/],
    [[{ ...server, url: "https://mcp.example.test/mcp?api_key=secret" }], /凭据参数/],
    [[{ ...server, auth: { kind: "unknown" } }], /auth.kind/],
    [[{ ...server, id: 1 }], /\.id/],
    [[{ ...server, timeoutMs: -1 }], /timeoutMs/],
    [[{ ...server, aliases: "知识库" }], /aliases/],
    [[{ ...server, capabilities: ["search"] }], /capabilities/],
    [[{ ...server, toolAllowlist: [1] }], /toolAllowlist/],
    [[{ ...server, trust: "other" }], /trust/],
    [[server, server], /key 不能重复/],
    [[{ ...server, auth: { kind: "basic" } }], /username/],
    [[{ ...server, auth: { kind: "bearer", token: "" } }], /token/],
    [[{ ...server, auth: { kind: "custom_headers", headers: { Key: 1 } } }], /headers/],
  ]) {
    assert.throws(() => parseRuntimeMcpConfiguration(JSON.stringify(value)), error);
  }
});
