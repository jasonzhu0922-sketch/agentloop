import assert from "node:assert/strict";
import test from "node:test";
import { localRuntimeMcpStartupLogLines } from "../local-agent-runtime/src/service/local-runtime-factory.ts";

test("Local Runtime reports every MCP source outcome at startup without secrets", () => {
  assert.deepEqual(localRuntimeMcpStartupLogLines({
    loadedServers: [{ key: "ontoflow-jtbc", toolCount: 1 }],
    failedServers: [{ key: "other-source", message: "HTTP 503" }],
  }), [
    { stream: "stdout", text: "Local Runtime MCP server ontoflow-jtbc loaded 1 tool(s)" },
    { stream: "stderr", text: "Local Runtime MCP server other-source failed: HTTP 503" },
  ]);
});
