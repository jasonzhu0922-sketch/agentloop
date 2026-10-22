import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createModelSelection } from "../web/client/state/model-selection.js";
import { createModelCatalog } from "../web/client/state/model-catalog.js";
import { conversationMessagesFromTurns } from "../web/client/projections/conversation-history.js";
import { persistSessions } from "../web/client/state/session-persistence.js";

const cloud = { key: "user:cloud", local: false };
const local = { key: "user:device", local: true };
const cloudModels = [{ key: "cloud-first" }, { key: "cloud-second" }];
// Deliberately interleave sources: defaulting must follow source, not list order.
const localModels = [{ key: "cloud:cloud-first" }, { key: "local:first" }, { key: "local:second" }, { key: "cloud:cloud-second" }];
const history = (id: string, key: string) => ({ id, messages: [{ id: `${id}-turn`, role: "assistant", requestedModelKey: key }] });

test("new conversations default to the first model for the execution source", () => {
  const selection = createModelSelection();
  assert.equal(selection.resolve({ conversation: { id: "new-local" }, context: local, models: localModels, loading: false }), "local:first");
  selection.choose("local:second");
  assert.equal(selection.resolve({ conversation: { id: "another-local" }, context: local, models: localModels, loading: false }), "local:first");
  assert.equal(selection.resolve({ conversation: { id: "new-cloud" }, context: cloud, models: cloudModels, loading: false }), "cloud-first");
  assert.equal(selection.resolve({ conversation: { id: "new-without-local-models" }, context: local, models: localModels.filter((m) => m.key.startsWith("cloud:")), loading: false }), "cloud:cloud-first");
  assert.equal(selection.resolve({ conversation: { id: "empty" }, context: local, models: [], loading: false }), "");
});

test("history restores the last turn selection and falls back within its model source", () => {
  const selection = createModelSelection();
  const resolve = (conversation: ReturnType<typeof history>, context = local, models = localModels) => selection.resolve({ conversation, context, models, loading: false });
  const conversation = history("last-turn", "local:first");
  conversation.messages.push({ id: "latest", role: "assistant", requestedModelKey: "local:second" });
  assert.equal(resolve(conversation), "local:second");
  assert.equal(resolve(history("local-deleted", "local:deleted")), "local:first");
  assert.equal(resolve(history("cloud-on-local", "cloud:cloud-second")), "cloud:cloud-second");
  assert.equal(resolve(history("cloud-deleted-on-local", "cloud:deleted")), "cloud:cloud-first");
  assert.equal(resolve(history("local-all-deleted", "local:deleted"), local, localModels.filter((m) => m.key.startsWith("cloud:"))), "cloud:cloud-first");
  assert.equal(resolve(history("cloud-history", "cloud-second"), cloud, cloudModels), "cloud-second");
  assert.equal(resolve(history("cloud-deleted", "removed"), cloud, cloudModels), "cloud-first");
});

test("loading, refreshes and control updates preserve manual choices while reopening restores history", () => {
  const selection = createModelSelection();
  const conversation = history("existing", "local:second");
  const input = { conversation, context: local, models: localModels, loading: false };
  assert.equal(selection.resolve({ ...input, models: [], loading: true }), "");
  assert.equal(selection.resolve(input), "local:second");
  selection.choose("cloud:cloud-second");
  assert.equal(selection.resolve({ ...input, models: [], loading: true }), "");
  assert.equal(selection.resolve({ ...input, models: [], loading: false }), "");
  assert.equal(selection.resolve(input), "cloud:cloud-second");
  selection.resolve({ ...input, conversation: { id: "other", messages: [] } });
  assert.equal(selection.resolve(input), "local:second");
  assert.equal(selection.resolve({ ...input, context: cloud, models: cloudModels }), "cloud-first");
});

test("requested selection survives history projection and browser recovery independently of resolved model", () => {
  for (const assignment of [undefined, { id: "failed", hasRun: false }, { id: "running", hasRun: true }]) {
    const messages = conversationMessagesFromTurns([{
      clientMessageId: "message", input: "hello", createdAt: 1, requestedModelKey: "cloud:chosen", assignment,
    }]);
    assert.equal(messages[1]?.requestedModelKey, "cloud:chosen");
  }
  const messages = conversationMessagesFromTurns([{
    clientMessageId: "message", input: "hello", createdAt: 1, requestedModelKey: "cloud:chosen",
    assignment: { id: "completed", hasRun: true },
    finalTurn: { status: "completed", modelKey: "runtime-resolved-key" },
  }]);
  let snapshot = "";
  persistSessions({ setItem(_key: string, value: string) { snapshot = value; }, removeItem() {} }, [{ id: "history", messages }]);
  const conversation = JSON.parse(snapshot)[0];
  assert.equal(conversation.messages[1].modelKey, "runtime-resolved-key");
  assert.equal(createModelSelection().resolve({ conversation, context: local, models: [{ key: "local:first" }, { key: "cloud:chosen" }], loading: false }), "cloud:chosen");
});

test("page wiring restores history after hydration and resets a new chat with a cached catalog", async () => {
  const app = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
  let active = { id: "a", messages: [] as Array<{ id: string; role: string; requestedModelKey?: string }> };
  let context = cloud;
  const select = { value: "", innerHTML: "", disabled: false };
  const catalogSource = app.slice(app.indexOf("const modelCatalog = createModelCatalog("), app.indexOf("// Compatibility bridge"));
  const syncSource = app.slice(app.indexOf("function syncModelSelection()"), app.indexOf("async function loadModels()"));
  const sandbox = {
    createModelCatalog, modelSelection: createModelSelection(), availableModels: [], modelsLoading: false,
    $: () => select, activeConversation: () => active, modelCatalogContext: () => context,
    routerClient: { request: async () => ({ ok: true, json: async () => ({ models: cloudModels }) }) },
    localAgentFetch: async () => ({ ok: true, json: async () => ({ models: localModels }) }),
    escapeHtml: (text: string) => text, setStatus() {}, modelSelectionStatus() {},
  };
  const page = vm.runInNewContext(`${catalogSource}\n${syncSource}\n({ modelCatalog, syncModelSelection });`, sandbox);
  await page.modelCatalog.load(context);
  assert.equal(select.value, "cloud-first");
  active = history("b", "cloud-second");
  page.syncModelSelection();
  assert.equal(select.value, "cloud-second");
  active = { id: "new", messages: [] };
  await page.modelCatalog.load(context); // Same context: no catalog onChange callback.
  page.syncModelSelection();
  assert.equal(select.value, "cloud-first");
  context = local;
  active = history("loading-history", "cloud:cloud-second");
  const loading = page.modelCatalog.load(context);
  assert.equal(select.value, "");
  await loading;
  assert.equal(select.value, "cloud:cloud-second");
  active = { id: "unhydrated", messages: [] };
  page.syncModelSelection();
  assert.equal(select.value, "local:first");
  active.messages = history("unhydrated", "local:second").messages;
  page.syncModelSelection();
  assert.equal(select.value, "local:second");
});
