import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpJsonImport } from "../web/client/local-runtime/mcp-json-import.js";

test("MCP JSON import turns a standard server map and URL key into encrypted-form input", () => {
  const servers = parseMcpJsonImport(JSON.stringify({
    mcpServers: {
      "amap-maps": {
        url: "https://mcp.amap.com/mcp?key=device-secret",
        toolAllowlist: [],
        toolBlocklist: [],
      },
    },
  }));
  assert.deepEqual(servers, [{
    displayName: "amap-maps",
    key: "amap-maps",
    transport: "http",
    url: "https://mcp.amap.com/mcp",
    auth: { kind: "query_parameter", parameterName: "key", value: "device-secret" },
  }]);
});

test("MCP JSON import recognizes bearer headers without putting credentials in the URL", () => {
  const [server] = parseMcpJsonImport(JSON.stringify({
    servers: [{
      key: "private-source",
      displayName: "Private source",
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer private-token" },
      toolAllowlist: ["search", "search"],
    }],
  }));
  assert.deepEqual(server, {
    displayName: "Private source",
    key: "private-source",
    transport: "http",
    url: "https://mcp.example.test/mcp",
    auth: { kind: "bearer", token: "private-token" },
    toolAllowlist: ["search"],
  });
});

test("MCP JSON import rejects unsupported stdio servers", () => {
  assert.throws(() => parseMcpJsonImport(JSON.stringify({
    mcpServers: { local: { command: "node", args: ["server.js"] } },
  })), /仅支持 HTTP/);
});
