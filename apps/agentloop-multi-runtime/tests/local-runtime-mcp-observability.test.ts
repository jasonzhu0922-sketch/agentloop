import assert from "node:assert/strict";
import test from "node:test";
import { localRuntimeMcpStartupLogLines, redactMcpDiagnostic } from "../local-agent-runtime/src/service/local-runtime-factory.ts";

test("Local Runtime reports every MCP source outcome at startup without secrets", () => {
  assert.deepEqual(localRuntimeMcpStartupLogLines({
    loadedServers: [{ key: "ontoflow-jtbc", toolCount: 1 }],
    failedServers: [{ key: "other-source", message: "HTTP 503" }],
  }), [
    { stream: "stdout", text: "Local Runtime MCP server ontoflow-jtbc loaded 1 tool(s)" },
    { stream: "stderr", text: "Local Runtime MCP server other-source failed: HTTP 503" },
  ]);
});

test("Local Runtime MCP diagnostics redact raw, URL-encoded, and Basic authorization secrets", () => {
  const raw = "token with/slash";
  const basic = "Basic dXNlcjpwYXNzd29yZA==";
  const diagnostic = redactMcpDiagnostic(
    `request ?key=${encodeURIComponent(raw)} failed with ${basic}; raw=${raw}`,
    [raw, basic],
  );
  assert.equal(diagnostic.includes(raw), false);
  assert.equal(diagnostic.includes(encodeURIComponent(raw)), false);
  assert.equal(diagnostic.includes(basic), false);
  assert.match(diagnostic, /\[redacted\]/);
});
