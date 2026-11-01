import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { createLocalConnectorSettings } from "../web/client/local-runtime/local-connector-settings.js";

const removedEditorIds = new Set([
  "local-connector-json", "local-connector-json-editor", "local-connector-json-empty",
  "local-connector-format", "local-connector-delete", "local-connector-save", "local-connector-discard",
]);

class Element {
  value = "";
  textContent = "";
  disabled = false;
  hidden = false;
  inert = false;
  className = "";
  type = "";
  children: Element[] = [];
  listeners = new Map<string, () => void>();
  classList = { toggle() {} };
  attributes = new Map<string, string>();
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  focus() {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener); }
  emit(type: string) { this.listeners.get(type)?.(); }
}

test("Connector settings add the selected catalog preset instead of a blank generic module", async (t) => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  globalThis.document = { createElement: () => new Element() } as unknown as Document;
  globalThis.window = { confirm: () => true } as unknown as Window & typeof globalThis;
  t.after(() => { globalThis.document = originalDocument; globalThis.window = originalWindow; });
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    assert.equal(removedEditorIds.has(id), false, `controller must not depend on removed editor element ${id}`);
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const catalog = [{
    key: "126-mail",
    displayName: "126 邮箱",
    description: "搜索和读取已授权的 126 邮件。",
    capabilities: ["邮件搜索", "邮件读取"],
    setupHint: "填写账号和客户端授权码。",
    binding: {
      title: "绑定 126 邮箱", description: "填写账号和客户端授权码。",
      fields: [
        { key: "email", label: "126 邮箱账号", target: "credential" },
        { key: "authorizationCode", label: "客户端授权码", target: "credential", secret: true },
      ],
    },
    template: {
      connectorKey: "126-mail", displayName: "我的 126 邮箱", modulePath: "/agent/connectors/126-mail.mjs",
      exportName: "createConfigured126MailConnector", enabled: false, config: {}, scopes: ["email:search", "email:read"],
    },
  }];
  let savedConnector: { connectorKey?: string; modulePath?: string; credentials?: Record<string, string> } | undefined;
  const settings = createLocalConnectorSettings({
    getElement: (id: string) => element(id) as unknown as HTMLElement,
    getRuntimeId: () => "runtime-1",
    onSaved: async () => undefined,
    notify: () => undefined,
    async request(path: string, init?: RequestInit) {
      if (init?.method === "POST") {
        savedConnector = JSON.parse(String(init.body)).connector;
        return Response.json({ connector: { ...savedConnector, credentialConfigured: true } });
      }
      return Response.json(path === "/v1/local-connectors/catalog" ? { connectors: catalog } : { connectors: [] });
    },
  });
  await settings.load();
  element("local-connector-catalog").children[0]!.children.at(-1)!.emit("click");
  assert.equal(element("local-connector-binding").hidden, false);
  const fields = element("local-connector-binding-fields").children;
  fields[0]!.children[1]!.value = "person@126.com";
  fields[1]!.children[1]!.value = "authorization-code";
  element("local-connector-binding-save").emit("click");
  await new Promise((resolve) => setImmediate(resolve));
  const saved = savedConnector;
  assert.ok(saved);
  assert.equal(saved.connectorKey, "126-mail");
  assert.equal(saved.modulePath, "/agent/connectors/126-mail.mjs");
  assert.deepEqual(saved.credentials, { email: "person@126.com", authorizationCode: "authorization-code" });
});

async function deletionFixture(t: TestContext, options: { confirm?: boolean; deleteResponse?: () => Promise<Response>; catalog?: unknown[] } = {}) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const confirmations: string[] = [];
  globalThis.document = { createElement: () => new Element() } as unknown as Document;
  globalThis.window = { confirm: (message: string) => { confirmations.push(message); return options.confirm !== false; } } as unknown as Window & typeof globalThis;
  t.after(() => { globalThis.document = originalDocument; globalThis.window = originalWindow; });
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    assert.equal(removedEditorIds.has(id), false, `controller must not depend on removed editor element ${id}`);
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const initial = ["a", "b"].map((id) => ({
    id: `instance-${id}`, connectorKey: `unseen-provider-${id}`, displayName: `实例 ${id}`,
    modulePath: `/connectors/${id}.mjs`, enabled: true, config: {}, credentialConfigured: true,
  }));
  let persisted = structuredClone(initial);
  const requests: string[] = [];
  let refreshes = 0;
  const settings = createLocalConnectorSettings({
    getElement: (id: string) => element(id) as unknown as HTMLElement,
    getRuntimeId: () => "runtime / one",
    onSaved: async () => { refreshes += 1; },
    notify: () => undefined,
    async request(path: string, init?: RequestInit) {
      if (init?.method === "DELETE") {
        requests.push(path);
        const response = await (options.deleteResponse?.() ?? Promise.resolve(Response.json({ removed: true })));
        if (response.ok) persisted = persisted.filter((item) => !path.endsWith(encodeURIComponent(item.id)));
        return response;
      }
      return Response.json({ connectors: path === "/v1/local-connectors/catalog" ? options.catalog ?? [] : persisted });
    },
  });
  await settings.load();
  const rows = () => element("local-connector-list").children;
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return { settings, element, rows, tick, requests, confirmations, refreshes: () => refreshes };
}

test("each Connector instance exposes an independent accessible delete action targeting that instance", async (t) => {
  const fixture = await deletionFixture(t);
  assert.equal(fixture.rows()[1]!.children[1]!.attributes.get("aria-label"), "删除 实例 b");
  fixture.rows()[1]!.children[1]!.emit("click");
  await fixture.tick();
  assert.deepEqual(fixture.requests, ["/v1/local-runtimes/runtime%20%2F%20one/connectors/instance-b"]);
  assert.match(fixture.confirmations[0]!, /实例 b/);
  assert.match(fixture.confirmations[0]!, /本机配置和已保存凭据/);
  assert.match(fixture.confirmations[0]!, /不会删除服务中的邮件或文档/);
  assert.equal(fixture.rows().length, 1);
  assert.equal(fixture.rows()[0]!.children[0]!.children[0]!.textContent, "实例 a");
  assert.equal(fixture.refreshes(), 1);
  await fixture.settings.load();
  assert.equal(fixture.rows().length, 1, "deletion persists after reloading settings");
});

test("cancelling instance deletion preserves configuration and never calls DELETE", async (t) => {
  const fixture = await deletionFixture(t, { confirm: false });
  fixture.rows()[0]!.children[1]!.emit("click");
  await fixture.tick();
  assert.deepEqual(fixture.requests, []);
  assert.equal(fixture.rows().length, 2);
  assert.equal(fixture.refreshes(), 0);
});

test("failed Connector deletion retains the instance and restores enabled controls", async (t) => {
  const fixture = await deletionFixture(t, { deleteResponse: async () => Response.json({ error: "failed" }, { status: 500 }) });
  fixture.rows()[0]!.children[1]!.emit("click");
  await fixture.tick();
  assert.equal(fixture.rows().length, 2);
  assert.match(fixture.element("local-connector-save-status").textContent, /删除失败.*500/);
  assert.equal(fixture.rows()[0]!.children[1]!.disabled, false);
  assert.equal(fixture.refreshes(), 0);
});

test("in-flight Connector deletion prevents concurrent requests and closing settings", async (t) => {
  let finish!: (response: Response) => void;
  const fixture = await deletionFixture(t, { deleteResponse: () => new Promise((resolve) => { finish = resolve; }) });
  const remove = fixture.rows()[0]!.children[1]!;
  remove.emit("click");
  assert.equal(remove.disabled, true);
  remove.emit("click");
  fixture.rows()[1]!.children[1]!.emit("click");
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.settings.canClose(), false);
  finish(Response.json({ removed: true }));
  await fixture.tick();
  assert.equal(fixture.rows()[0]!.children[0]!.children[0]!.textContent, "实例 b");
  assert.equal(fixture.rows()[0]!.children[1]!.disabled, false);
  assert.equal(fixture.settings.canClose(), true);
});

test("deleting an instance preserves a separate in-progress binding form", async (t) => {
  const fixture = await deletionFixture(t, { catalog: [{
    key: "new-provider", displayName: "新服务", template: { connectorKey: "new-provider" },
    binding: { fields: [{ key: "account", label: "账号", target: "credential" }] },
  }] });
  fixture.element("local-connector-catalog").children[0]!.children.at(-1)!.emit("click");
  const fields = fixture.element("local-connector-binding-fields").children;
  fields[0]!.children[1]!.value = "in-progress-account";
  fixture.rows()[0]!.children[1]!.emit("click");
  await fixture.tick();
  assert.equal(fixture.element("local-connector-binding").hidden, false);
  assert.equal(fixture.element("local-connector-binding-fields").children[0]!.children[1]!.value, "in-progress-account");
  assert.equal(fixture.element("local-connector-binding-save").disabled, false);
  assert.equal(fixture.rows().length, 1);
});

test("deleting the final instance shows the empty list without an editor", async (t) => {
  const fixture = await deletionFixture(t);
  fixture.rows()[0]!.children[1]!.emit("click");
  await fixture.tick();
  fixture.rows()[0]!.children[1]!.emit("click");
  await fixture.tick();
  assert.equal(fixture.confirmations.length, 2);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.rows()[0]!.textContent, "尚未配置本机 Connector");
  assert.equal(fixture.settings.canClose(), true);
});

test("loading Connector instances is read-only and does not require JSON editing controls", async (t) => {
  const fixture = await deletionFixture(t);
  assert.equal(fixture.rows().length, 2);
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(fixture.confirmations, []);
  assert.equal(fixture.settings.canClose(), true);
});

test("Connector page exposes binding and instance management without the raw JSON editor or its save bar", async () => {
  const html = await readFile(new URL("../web/pages/app.html", import.meta.url), "utf8");
  for (const id of removedEditorIds) assert.ok(!html.includes(`id="${id}"`), `${id} should be removed from the page`);
  assert.match(html, /id="local-connector-binding"/);
  assert.match(html, /id="local-connector-list"/);
});
