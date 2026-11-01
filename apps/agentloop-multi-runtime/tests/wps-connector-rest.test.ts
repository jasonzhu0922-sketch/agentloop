import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorExecutionContext } from "@zhujun/agentloop-connector-sdk";
import { createConfiguredWpsConnector } from "../../../packages/connector-wps/src/index.ts";

async function connected(fetch: typeof globalThis.fetch) {
  const connector = createConfiguredWpsConnector({ config: {}, fetch });
  return await connector.connect({
    connection: { id: "wps-connection", connectorKey: "kingsoft-wps", ownerType: "user", ownerId: "user-1", scopes: [], credentialRef: "secret", status: "active" },
    credentialProvider: { get: async () => ({ accessToken: "local-wps-token" }) },
  });
}

function executionContext(input: Pick<ConnectorExecutionContext, "runId" | "connection" | "signal">): ConnectorExecutionContext {
  return {
    ...input,
    actorUserId: "user-1",
    credentialProvider: { get: async () => ({ accessToken: "local-wps-token" }) },
  };
}

test("configured WPS Connector searches through WPS REST with the user Bearer token", async () => {
  const requests: Request[] = [];
  const instance = await connected(async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ code: 0, data: { files: [{ file_id: "file-1", file_name: "周报", file_type: "doc", drive_id: "drive-1", web_url: "https://wps.example/file-1" }] } });
  });
  const result = await instance.execute("document.search", { query: "周报", limit: 5 }, executionContext({ runId: "run-1", connection: instance.connection, signal: AbortSignal.timeout(1_000) }));
  assert.deepEqual(result.data, [{ id: "file-1", name: "周报", kind: "document", driveId: "drive-1", url: "https://wps.example/file-1" }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://openapi.wps.cn/v7/files/search?keyword=%E5%91%A8%E6%8A%A5&page_size=5");
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer local-wps-token");
  assert.equal(requests[0]?.headers.get("mcp-method"), null);
});

test("configured WPS Connector resolves drive id and extracts Markdown through REST", async () => {
  const requests: Request[] = [];
  const instance = await connected(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).pathname.endsWith("/meta")) return Response.json({ code: 0, data: { drive_id: "drive-1" } });
    return Response.json({ code: 0, data: { file_name: "项目计划", content: "# 项目计划" } });
  });
  const result = await instance.execute("document.read", { documentId: "file-1" }, executionContext({ runId: "run-1", connection: instance.connection, signal: AbortSignal.timeout(1_000) }));
  assert.deepEqual(result.data, { id: "file-1", name: "项目计划", kind: "document", text: "# 项目计划" });
  assert.deepEqual(requests.map((request) => request.url), [
    "https://openapi.wps.cn/v7/files/file-1/meta?with_drive=true",
    "https://openapi.wps.cn/v7/drives/drive-1/files/file-1/content?format=markdown",
  ]);
});

test("configured WPS Connector reads only a bounded range from the selected worksheet", async () => {
  const requests: Request[] = [];
  const instance = await connected(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/worksheets")) return Response.json({ code: 0, data: { worksheets: [{ worksheet_id: "sheet-1", worksheet_name: "预算" }, { worksheet_id: "sheet-2", worksheet_name: "不应读取" }] } });
    return Response.json({ code: 0, data: { columns: ["月份", "金额"], values: [["十月", 100]] } });
  });
  const result = await instance.execute("spreadsheet.read", { documentId: "book-1", driveId: "drive-1", sheetId: "sheet-1" }, executionContext({ runId: "run-1", connection: instance.connection, signal: AbortSignal.timeout(1_000) }));
  assert.deepEqual(result.data, { id: "book-1", name: "book-1", kind: "spreadsheet", sheets: [{ id: "sheet-1", name: "预算", columns: ["月份", "金额"], rows: [["十月", 100]] }] });
  assert.deepEqual(requests.map((request) => request.url), [
    "https://openapi.wps.cn/v7/sheets/book-1/worksheets",
    "https://openapi.wps.cn/v7/sheets/book-1/worksheets/sheet-1/range_data?range=A1%3AZ200",
  ]);
});

test("WPS REST business errors are surfaced rather than returned as empty documents", async () => {
  const instance = await connected(async () => Response.json({ code: 403001, msg: "scope denied" }));
  await assert.rejects(
    instance.execute("document.search", { query: "周报" }, executionContext({ runId: "run-1", connection: instance.connection, signal: AbortSignal.timeout(1_000) })),
    { message: "WPS REST request failed: scope denied" },
  );
});
