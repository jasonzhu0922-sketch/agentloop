import assert from "node:assert/strict";
import { once } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createChatServer, publicEvent } from "../src/server.ts";
import type { DataAgent } from "../src/agent.ts";
import { MODEL_CONFIGURATION_EDITOR_SCHEMA } from "@zhujun/agentloop";

test("chat opens without login and protects mutations from other origins", async t => {
  const starts: unknown[] = [];
  const agent = { runs: { listConversations: async () => [] }, start: async (message: unknown) => { starts.push(message); return { id: "run" }; } } as unknown as DataAgent;
  const server = createChatServer(agent, { webRoot: resolve(import.meta.dirname, "../web"), models: [{ key: "test", displayName: "Test" }], defaultModelKey: "test" });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const root = await fetch(url);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /输入你的业务问题/);
  const markdown = await fetch(`${url}/markdown.js`);
  assert.equal(markdown.status, 200);
  assert.match(await markdown.text(), /renderMarkdown/);
  const settingsScript = await fetch(`${url}/settings.js`);
  assert.equal(settingsScript.status, 200);
  assert.match(await settingsScript.text(), /request\('\/api\/mcp\/verify'/);
  const cookie = root.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await fetch(`${url}/api/config`)).status, 403);
  const config = await fetch(`${url}/api/config`, { headers: { Cookie: cookie } });
  assert.equal(config.status, 200);
  assert.deepEqual((await config.json()).models, [{ key: "test", displayName: "Test" }]);
  const mcp = await fetch(`${url}/api/mcp/server`, { headers: { Cookie: cookie } });
  assert.equal(mcp.status, 200);
  assert.equal((await mcp.json()).endpoint, `${url}/mcp/sse`);
  assert.equal((await fetch(`${url}/api/model-configuration/schema`)).status, 403);
  const schema = await fetch(`${url}/api/model-configuration/schema`, { headers: { Cookie: cookie } });
  assert.equal(schema.status, 200);
  assert.deepEqual(await schema.json(), MODEL_CONFIGURATION_EDITOR_SCHEMA);
  const data = { requestId: "request", conversationId: "conversation", input: "指标", modelKey: "test", ownerUserId: "untrusted" };
  const crossSite = await fetch(`${url}/api/messages`, { method: "POST", headers: { Cookie: cookie, Origin: "https://elsewhere.invalid", "Content-Type": "application/json" }, body: JSON.stringify(data) });
  assert.equal(crossSite.status, 403); assert.equal(starts.length, 0);
  const result = await fetch(`${url}/api/messages`, { method: "POST", headers: { Cookie: cookie, Origin: url, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  assert.equal(result.status, 202);
  assert.deepEqual(starts, [{ requestId: "request", conversationId: "conversation", input: "指标", modelKey: "test" }]);
});

test("browser technical events retain real summaries without exposing credentials, SQL or result rows", () => {
  const planned = publicEvent({ seq: 1, type: "tool.planned", createdAt: 10, data: {
    toolCallId: "call", toolName: "computer_run_command", arguments: {
      command: "python3",
      args: ["scripts/data_client.py", "--token", "command-secret", "--api-key=inline-secret", "SELECT * FROM private_table"],
      databaseUrl: "tidb://alice:private-password@db.example:4000/catalog?token=url-secret",
      nested: { password: "nested-password", apiKey: "nested-key", authorization: "Bearer bearer-secret", visible: "group catalog" },
      longArray: Array.from({ length: 30 }, (_, index) => index),
      longObject: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, index])),
    },
  } });
  const plannedText = JSON.stringify(planned);
  for (const secret of ["command-secret", "inline-secret", "private-password", "url-secret", "nested-password", "nested-key", "bearer-secret", "private_table"]) {
    assert.equal(plannedText.includes(secret), false, secret);
  }
  assert.match(plannedText, /group catalog/);
  assert.match(plannedText, /SQL omitted/);
  assert.match(plannedText, /more item/);
  assert.match(plannedText, /more field/);

  const result = publicEvent({ seq: 2, type: "tool.completed", createdAt: 20, data: {
    toolCallId: "call", toolName: "computer_run_command", durationMs: 1250, operationStatus: "succeeded",
    result: JSON.stringify({ exitCode: 0, status: "completed", stdout: JSON.stringify({
      rows: Array.from({ length: 40 }, (_, index) => ({ employee: `employee-${index}`, salary: 10000 + index })),
      summary: "40 matching employees", token: "result-secret",
    }), stderr: "" }),
  } });
  const preview = String((result.data as Record<string, unknown>).resultPreview);
  assert.match(preview, /40 matching employees/);
  assert.match(preview, /itemCount/);
  assert.match(preview, /itemsOmitted/);
  assert.equal(preview.includes("employee-0"), false);
  assert.equal(preview.includes("10000"), false);
  assert.equal(preview.includes("result-secret"), false);
  assert.ok(preview.length <= 5_020);

  const model = publicEvent({ seq: 3, type: "model.request.started", createdAt: 30, data: { content: "private prompt", phase: "execution" } });
  assert.equal(Object.hasOwn(model, "content"), false);
  const narration = publicEvent({ seq: 4, type: "assistant.committed", createdAt: 40, data: {
    content: "正在核对查询结果。\n\nSELECT salary FROM private_table WHERE token='narration-secret'\n\nstdout={\"rows\":[1]}",
  } });
  assert.equal(narration.content, "正在核对查询结果。");
  const skill = publicEvent({ seq: 5, type: "tool.completed", createdAt: 50, data: { toolName: "load_skill", result: "private Skill instructions" } });
  assert.equal((skill.data as Record<string, unknown>).resultPreview, "Skill package content omitted (26 persisted characters)");
});
