import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorExecutionContext } from "@zhujun/agentloop-connector-sdk";
import { feishuConnector } from "../src/index.ts";

async function connected() {
  return await feishuConnector.connect({
    connection: { id: "feishu-connection", connectorKey: "feishu", ownerType: "user", ownerId: "user-1", scopes: [], credentialRef: "secret", status: "active" },
    credentialProvider: { get: async () => ({ accessToken: "u-token" }) },
  });
}

function context(connection: any): ConnectorExecutionContext {
  return { runId: "run-1", connection, actorUserId: "user-1", signal: AbortSignal.timeout(1_000), credentialProvider: { get: async () => ({ accessToken: "u-token" }) } };
}

test("Feishu document search uses the cloud document search contract", async (t) => {
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => { requests.push(new Request(input, init)); return Response.json({ code: 0, data: { docs_entities: [] } }); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const instance = await connected();
  await instance.execute("document.search", { query: "周报", pageSize: 10 }, context(instance.connection));
  assert.equal(requests[0]?.url, "https://open.feishu.cn/open-apis/suite/docs-api/search/object");
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer u-token");
  assert.deepEqual(await requests[0]?.json(), { search_key: "周报", count: 10 });
});

test("Feishu document read uses GET raw_content and surfaces API errors", async (t) => {
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => { requests.push(new Request(input, init)); return Response.json({ code: 0, data: { content: "正文" } }); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const instance = await connected();
  const result = await instance.execute("document.read", { documentId: "doxcn123" }, context(instance.connection));
  assert.deepEqual(result.data, { code: 0, data: { content: "正文" } });
  assert.equal(requests[0]?.url, "https://open.feishu.cn/open-apis/docx/v1/documents/doxcn123/raw_content");
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.body, null);

  globalThis.fetch = async () => Response.json({ code: 99991672, msg: "scope denied" });
  const failing = await connected();
  await assert.rejects(failing.execute("document.read", { documentId: "doxcn123" }, context(failing.connection)), { message: "Feishu API request failed (99991672): scope denied" });
});
