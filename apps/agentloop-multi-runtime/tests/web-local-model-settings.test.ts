import assert from "node:assert/strict";
import test from "node:test";
import { createLocalModelSettings } from "../web/client/local-runtime/local-model-settings.js";

// Only the DOM operations used by the settings controller; transport and
// editor events are exercised through the same handlers as the browser.
class Element {
  value = "";
  textContent = "";
  checked = false;
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
  fill(value: unknown) { this.value = typeof value === "string" ? value : JSON.stringify(value); this.emit("input"); }
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(t: test.TestContext) {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: () => new Element() } as unknown as Document;
  t.after(() => { globalThis.document = originalDocument; });
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  let writes = 0;
  let rejectSave = false;
  let rejectRefresh = false;
  const notifications: Array<{ message: string; kind: string }> = [];
  let confirm = false;
  let saved = { reuseCloudModels: false, providers: [
    { key: "first", displayName: "First", baseUrl: "https://one.test/v1", credentialConfigured: true, models: [] },
    { key: "second", displayName: "Second", baseUrl: "https://two.test/v1", credentialConfigured: true, models: [] },
  ] };
  const settings = createLocalModelSettings({
    getElement: (id) => element(id) as unknown as HTMLElement,
    confirm: () => confirm,
    async onSaved() { if (rejectRefresh) throw new Error("catalog_unavailable"); },
    notify(message, kind) { notifications.push({ message, kind }); },
    async request(_path, init) {
      if (init?.method === "PUT") {
        writes += 1;
        if (rejectSave) return Response.json({ error: "runtime_reload_failed" }, { status: 409 });
        const value = JSON.parse(String(init.body));
        saved = { ...value, providers: value.providers.map(({ apiKey: _key, ...provider }: { apiKey?: string }) => ({ ...provider, credentialConfigured: true })) };
      }
      return Response.json({ configuration: saved });
    },
  });
  await settings.load();
  return { settings, element, notifications, writes: () => writes, saved: () => saved, confirm: (value: boolean) => { confirm = value; }, rejectSave: (value: boolean) => { rejectSave = value; }, rejectRefresh: () => { rejectRefresh = true; } };
}

test("JSON syntax errors prevent saving and Provider switching without losing the draft", async (t) => {
  const f = await fixture(t);
  f.element("local-models-json").fill("[{broken");
  f.element("local-model-save").emit("click");
  await settle();
  assert.equal(f.writes(), 0);
  assert.match(f.element("local-model-save-status").textContent, /JSON 格式错误/);
  assert.equal(f.notifications[0]?.kind, "error");
  assert.match(f.notifications[0]!.message, /保存失败.*JSON 格式错误/);
  f.element("local-model-provider-list").children[1]!.emit("click");
  assert.equal(JSON.parse(f.element("local-provider-json").value).key, "first");
  assert.equal(f.element("local-models-json").value, "[{broken");
  assert.equal(f.settings.canClose(), false);
  assert.equal(f.element("local-models-json").value, "[{broken");
  f.confirm(true);
  f.element("local-model-discard").emit("click");
  assert.equal(f.element("local-models-json").value, "[]");
  assert.equal(f.element("local-model-save").disabled, true);
});

test("failed saves retain JSON and support retry, while successful saves remove plaintext credentials", async (t) => {
  const f = await fixture(t);
  const connection = { key: "first", displayName: "First", baseUrl: "https://one.test/v1", apiKey: "test-only-key" };
  const models = [{ key: "a", displayName: "A", providerModel: "upstream", temperature: 0 }];
  f.element("local-provider-json").fill(connection);
  f.element("local-models-json").fill(models);
  f.rejectSave(true);
  f.element("local-model-save").emit("click");
  await settle();
  assert.match(f.element("local-model-save-status").textContent, /runtime_reload_failed/);
  assert.equal(f.notifications.at(-1)?.kind, "error");
  assert.match(f.notifications.at(-1)!.message, /保存失败.*runtime_reload_failed/);
  assert.deepEqual(JSON.parse(f.element("local-provider-json").value), connection);
  assert.deepEqual(JSON.parse(f.element("local-models-json").value), models);
  assert.equal(f.element("local-model-save").disabled, false);
  f.rejectSave(false);
  f.element("local-model-save").emit("click");
  await settle();
  assert.equal(f.writes(), 2);
  assert.equal(f.element("local-provider-json").value.includes("test-only-key"), false);
  assert.deepEqual(f.saved().providers[0]?.models, models);
  assert.equal(f.element("local-model-save").disabled, true);
  assert.equal(f.notifications.at(-1)?.kind, "success");
  assert.match(f.notifications.at(-1)!.message, /配置已保存.*后续新任务/);
  assert.equal(f.settings.canClose(), true);
  assert.equal(f.element("local-provider-json").value, "");
});

test("a catalog refresh error reports that configuration was saved rather than a save failure", async (t) => {
  const f = await fixture(t);
  f.rejectRefresh();
  f.element("local-models-json").fill([]);
  f.element("local-model-save").emit("click");
  await settle();
  assert.equal(f.writes(), 1);
  assert.equal(f.notifications.at(-1)?.kind, "warning");
  assert.match(f.notifications.at(-1)!.message, /配置已保存，但模型列表刷新失败/);
  assert.equal(f.element("local-model-save").disabled, true);
});
