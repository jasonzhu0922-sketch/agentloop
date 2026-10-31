import assert from "node:assert/strict";
import test from "node:test";
import { createLocalConnectorSettings } from "../web/client/local-runtime/local-connector-settings.js";

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
  setAttribute() {}
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
