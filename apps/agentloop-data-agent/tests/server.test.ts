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

test("final artifacts can be listed and downloaded while process files stay private", async t => {
  const finalArtifact = { runId: "run-1", id: "artifact-final", path: "经营报表.xlsx", name: "经营报表.xlsx", bytes: 4,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", role: "final", sourceTool: "computer_run_command", previewable: true };
  const processArtifact = { ...finalArtifact, id: "artifact-process", path: "query.json", name: "query.json", role: "process" };
  const agent = { runs: {
    listConversations: async () => [],
    processArtifacts: async () => [processArtifact, finalArtifact],
    readProcessArtifact: async (_owner: string, _runId: string, artifactId: string) => {
      assert.equal(artifactId, finalArtifact.id); return { artifact: finalArtifact, content: Buffer.from("xlsx") };
    },
  } } as unknown as DataAgent;
  const server = createChatServer(agent, { webRoot: resolve(import.meta.dirname, "../web"), models: [{ key: "test", displayName: "Test" }], defaultModelKey: "test" });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const root = await fetch(url);
  const cookie = root.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await fetch(`${url}/api/runs/run-1/artifacts`)).status, 403);
  const listed = await fetch(`${url}/api/runs/run-1/artifacts`, { headers: { Cookie: cookie } });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).artifacts.map((artifact: { id: string }) => artifact.id), [finalArtifact.id]);
  const downloaded = await fetch(`${url}/api/runs/run-1/artifacts/${finalArtifact.id}/download`, { headers: { Cookie: cookie } });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("content-type"), "application/octet-stream");
  assert.match(downloaded.headers.get("content-disposition") ?? "", /filename\*=UTF-8''/);
  assert.equal(await downloaded.text(), "xlsx");
  assert.equal((await fetch(`${url}/api/runs/run-1/artifacts/${processArtifact.id}/download`, { headers: { Cookie: cookie } })).status, 404);
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

test("browser narration removes SQL even when prose appears before the statement", () => {
  const projected = publicEvent({ seq: 1, type: "assistant.streaming", createdAt: 1, data: {
    content: "正在执行 SQL：SELECT salary, employee_name FROM secret_payroll WHERE company = 1",
  } });
  assert.equal(projected.content, undefined);
});

test("browser technical previews remove SQL embedded in error prose", () => {
  const projected = publicEvent({ seq: 1, type: "tool.failed", createdAt: 1, data: {
    toolName: "computer_run_command", error: "Query failed while running SELECT salary FROM secret_payroll WHERE company = 1",
  } });
  assert.doesNotMatch(String(projected.data.errorPreview), /secret_payroll|salary/);
  assert.match(String(projected.data.errorPreview), /SQL omitted/);
});
