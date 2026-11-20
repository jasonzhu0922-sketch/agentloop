import assert from "node:assert/strict";
import { once } from "node:events";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createChatServer } from "../src/server.ts";
import type { DataAgent } from "../src/agent.ts";
import type { SettingsService } from "../src/settings.ts";
import { enableUtf8Python, pythonUtf8Environment } from "../src/python-environment.ts";

test("Python child processes always use UTF-8 instead of the Windows code page", () => {
  const inherited = pythonUtf8Environment({ PYTHONUTF8: "0", PYTHONIOENCODING: "cp936", KEEP: "value" });
  assert.equal(inherited.PYTHONUTF8, "1");
  assert.equal(inherited.PYTHONIOENCODING, "utf-8");
  assert.equal(inherited.KEEP, "value");
  const mutable: NodeJS.ProcessEnv = {};
  enableUtf8Python(mutable);
  assert.equal(mutable.PYTHONUTF8, "1");
  assert.equal(mutable.PYTHONIOENCODING, "utf-8");
});

test("settings mutations use host admission, refresh the connection package and preserve request identity", async t => {
  const calls: unknown[] = [];
  const settings = {
    models: { defaultModelKey: "new", registry: { modelCatalog: () => [{ key: "new", displayName: "New" }], modelKeys: () => ["new"] },
      publicConfig: () => ({ revision: "v1", models: [] }), save: async (data: unknown) => { calls.push(data); return { revision: "v2" }; } },
    catalog: async (action: string, data: unknown) => { calls.push({ action, data }); return { saved: true }; },
  } as unknown as SettingsService;
  const agent = {
    skill: { name: "data-analysis" }, configure: async (action: () => Promise<unknown>, refresh = false) => { calls.push({ refresh }); return action(); },
    setModelKeys: (keys: unknown) => calls.push(keys), start: async (message: unknown) => { calls.push(message); return { id: "run" }; },
  } as unknown as DataAgent;
  const server = createChatServer(agent, { webRoot: resolve(import.meta.dirname, "../web"), models: [], defaultModelKey: "old", settings });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const root = await fetch(`${origin}/settings`);
  assert.equal(root.status, 200); assert.match(await root.text(), /知识与数据/);
  const cookie = root.headers.get("set-cookie")!.split(";")[0];
  const write = (route: string, data: unknown, extra = {}) => fetch(`${origin}${route}`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json", ...extra }, body: JSON.stringify(data) });
  assert.equal((await fetch(`${origin}/api/settings/models`)).status, 403);
  assert.equal((await write("/api/settings/connection", {}, { Origin: "https://example.invalid" })).status, 403);
  assert.deepEqual(calls, []);
  assert.equal((await write("/api/settings/connection", { revision: "v1" })).status, 200);
  assert.deepEqual(calls.splice(0), [{ refresh: true }, { action: "connection-save", data: { revision: "v1" } }]);
  assert.equal((await write("/api/settings/models", { revision: "v1" })).status, 200);
  assert.deepEqual(calls.splice(0), [{ refresh: false }, { revision: "v1" }, ["new"]]);
  // A retry carries its original model even if the default has since changed.
  const message = { requestId: "request", conversationId: "conversation", input: "问题", modelKey: "old" };
  const response = await fetch(`${origin}/api/messages`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(message) });
  assert.equal(response.status, 202); assert.deepEqual(calls, [message]);
});
