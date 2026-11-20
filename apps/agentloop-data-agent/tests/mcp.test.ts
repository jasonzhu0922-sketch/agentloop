import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createMcpService } from "../src/mcp.ts";

test("MCP SSE exposes tools, progress, structured query results and durable call state", async t => {
  const calls = new Map<string, any>();
  let started = false;
  const agent = {
    defaultModelKey: "flash",
    mcpCalls: {
      async save(call: any, create = false) { if (create) calls.set(call.id, structuredClone(call)); else calls.set(call.id, structuredClone(call)); },
      async list() { return [...calls.values()]; },
      async get(id: string) { return calls.get(id); },
    },
    start: async () => { started = true; return { id: "run_mcp", input: "查询销售额", conversationId: "conv_mcp", modelKey: "flash", status: "running", createdAt: 1 }; },
    runs: {
      async get(_owner: string, id: string) { return { id, input: "查询销售额", conversationId: "conv_mcp", modelKey: "flash", status: "completed", output: "销售额为 10", createdAt: 1, finishedAt: 2 }; },
      async eventsAfter() { return [{ seq: 1, type: "run.started", createdAt: 1, data: { phase: "planning" } }]; },
      async currentHumanLoop() { return undefined; },
    },
  } as any;
  const service = createMcpService({ agent, defaultModelKey: "flash", searchTables: async question => ({ tables: [{ name: "sales", matched: question }] }) });
  const server = createServer((request, response) => { void service.handle(request, response, new URL(request.url ?? "/", `http://${request.headers.host}`)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { service.close(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const stream = await fetch(`${origin}/mcp/sse`);
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  let pending = "";
  async function event() {
    for (;;) {
      const split = pending.indexOf("\n\n");
      if (split >= 0) {
        const frame = pending.slice(0, split); pending = pending.slice(split + 2);
        const data = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6);
        if (data !== undefined) { try { return JSON.parse(data); } catch { return data; } }
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("MCP SSE closed");
      pending += new TextDecoder().decode(chunk.value);
    }
  }
  const endpoint = await event();
  assert.match(endpoint, /^\/mcp\/messages\/\?session_id=/);
  const post = (body: unknown) => fetch(`${origin}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })).status, 202);
  assert.equal((await event()).result.serverInfo.name, "AgentLoop Data Agent");
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual((await event()).result.tools.map((tool: any) => tool.name), ["query", "search_tables"]);
  await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "query", arguments: { question: "查询销售额" }, _meta: { progressToken: "p1" } } });
  const progress = await event();
  assert.equal(progress.method, "notifications/progress");
  let result: any;
  do { result = await event(); } while (!result.result);
  assert.equal(result.result.structuredContent.status, "completed");
  assert.equal(result.result.structuredContent.output, "销售额为 10");
  assert.equal(started, true);
  const call = [...calls.values()][0];
  assert.equal(call.status, "completed");
  assert.equal(call.runId, "run_mcp");
  assert.equal(call.events[0].type, "run.started");
  await reader.cancel();
  const verification = await service.verify("search_tables", { question: "验证目录检索" });
  assert.equal(verification.ok, true);
  assert.equal((verification.initialize as any).result.protocolVersion, "2024-11-05");
  assert.deepEqual((verification.tools as any).map((tool: any) => tool.name), ["query", "search_tables"]);
  assert.equal((verification.call as any).result.structuredContent.schema, "agentloop.tableSearchResult/v1");
  assert.equal([...calls.values()].some((item: any) => item.tool === "search_tables" && item.status === "completed"), true);
});
