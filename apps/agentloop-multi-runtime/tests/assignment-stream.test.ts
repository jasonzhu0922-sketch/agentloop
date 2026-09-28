import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { observeAssignment } from "../web/assignment-stream.js";
import { projectAssistantEvent } from "../web/assistant-event-projection.js";

const event = (seq: number, type: string, data = {}) => ({ seq, type, data, createdAt: seq });
const packet = (value: ReturnType<typeof event>) => `id: ${value.seq}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });
const json = (value: unknown) => Response.json(value);

for (const errorType of ["error", "stream.error"]) test(`transient ${errorType} does not fail a Run; reconnect resumes and deduplicates`, async () => {
  const assistant: Record<string, unknown> = { status: "running", text: "prior work" };
  const urls: string[] = [];
  const sequences: number[] = [];
  const connectionStates: string[] = [];
  let streams = 0;
  await observeAssignment({ baseUrl: "http://fixture/assignment", headers: {}, signal: new AbortController().signal,
    fetchImpl: async (url, init) => {
      urls.push(String(url)); assert.equal(init?.method, undefined, "observation must never POST a task/cancel/recovery");
      if (String(url).includes("/stream")) return ++streams === 1
        ? sse(packet(event(1, "assistant.streaming", { content: "existing work" })) + `event: ${errorType}\ndata: {"error":"upstream temporarily unavailable"}\n\n`)
        : sse(packet(event(1, "assistant.streaming", { content: "duplicate" })) + packet(event(2, "run.completed", { output: "done" })));
      return json({ run: { remoteRunId: "run", status: "running" } });
    },
    wait: async (ms) => { assert.equal(assistant.status, "running"); assert.equal(assistant.text, "existing work"); assert.equal(ms, 500); },
    onEvent: (value) => { sequences.push(value.seq); return projectAssistantEvent(assistant, value as unknown as Record<string, unknown>); },
    onRun: () => assert.fail("completion arrived via events"), onConnection: (state) => { connectionStates.push(state); },
  });
  assert.deepEqual(sequences, [1, 2]);
  assert.equal(assistant.status, "completed"); assert.equal(assistant.text, "done");
  assert.ok(urls.includes("http://fixture/assignment/events/stream?afterSeq=1"));
  assert.deepEqual(connectionStates, ["connected", "reconnecting", "connected"]);
});

for (const status of ["completed", "failed", "cancelled"] as const) test(`lost terminal packet is reconciled from authoritative ${status} snapshot`, async () => {
  let observed: unknown;
  const seen: number[] = [];
  await observeAssignment({ baseUrl: "http://fixture/a", headers: {}, signal: new AbortController().signal, afterSeq: 9,
    fetchImpl: async (url) => String(url).includes("/stream") ? sse("") : String(url).includes("/events?")
      ? json({ events: [event(10, "plan.step.completed")] }) : json({ run: { remoteRunId: "run", status, output: "persisted", finishedAt: 20 } }),
    wait: async () => assert.fail("terminal snapshot should finish observation"),
    onEvent: (value) => { seen.push(value.seq); return false; }, onRun: (run) => { observed = run; }, onConnection() {},
  });
  assert.deepEqual(seen, [10]); assert.deepEqual(observed, { remoteRunId: "run", status, output: "persisted", finishedAt: 20 });
});

test("network failures back off without manufacturing failure; abort stops retries", async () => {
  const abort = new AbortController(); const delays: number[] = []; let requests = 0;
  await observeAssignment({ baseUrl: "http://fixture/a", headers: {}, signal: abort.signal,
    fetchImpl: async () => { requests++; throw new Error("offline"); },
    wait: async (ms) => { delays.push(ms); if (delays.length === 7) abort.abort(); },
    onEvent: () => assert.fail(), onRun: () => assert.fail(), onConnection: (state) => assert.equal(state, "reconnecting"),
  });
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 10000, 10000]); assert.equal(requests, 14);
});

test("terminal snapshot frame completes an already caught-up stream without fabricating a seq", async () => {
  let status;
  await observeAssignment({ baseUrl: "http://fixture/a", headers: {}, signal: new AbortController().signal, afterSeq: 398,
    fetchImpl: async () => sse('event: run.snapshot\ndata: {"run":{"remoteRunId":"run","status":"completed","output":"done"}}\n\n'),
    onEvent: () => assert.fail("snapshot must not masquerade as a durable event"), onRun: (run) => { status = run.status; }, onConnection() {},
  });
  assert.equal(status, "completed");
});

test("live Runtime status exposes the resolved model before terminal events", async () => {
  let observed: unknown;
  await observeAssignment({ baseUrl: "http://fixture/a", headers: {}, signal: new AbortController().signal,
    fetchImpl: async (url) => String(url).includes("/stream")
      ? sse(packet(event(1, "run.completed", { output: "done" })))
      : json({ run: { remoteRunId: "run", status: "running", modelKey: "deepseek-v4-flash" } }),
    onStatus: (run) => { observed = run; },
    onEvent: (value) => value.type === "run.completed", onRun: () => assert.fail("completion arrived via events"), onConnection() {},
  });
  assert.deepEqual(observed, { remoteRunId: "run", status: "running", modelKey: "deepseek-v4-flash" });
});

test("silent open stream times out, reconnects, and receives split CRLF frames", async () => {
  let streams = 0;
  let finished = false;
  const encoder = new TextEncoder();
  await observeAssignment({ baseUrl: "http://fixture/a", headers: {}, signal: new AbortController().signal, idleTimeoutMs: 20,
    fetchImpl: async (url, init) => {
      if (!String(url).includes("/stream")) return json({ run: { remoteRunId: "run", status: "running" } });
      if (++streams === 1) return new Response(new ReadableStream({ start(controller) { init!.signal!.addEventListener("abort", () => controller.error(new Error("idle")), { once: true }); } }));
      const text = packet(event(1, "run.completed")).replaceAll("\n", "\r\n");
      return new Response(new ReadableStream({ start(controller) { for (const byte of encoder.encode(text)) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
    }, wait: async () => {}, onConnection() {}, onRun: () => assert.fail(),
    onEvent: (value) => { finished = value.type === "run.completed"; return finished; },
  });
  assert.equal(streams, 2); assert.equal(finished, true);
});

test("explicit observer abort closes only its stream without declaring a Run outcome", async () => {
  const abort = new AbortController(); let cancelled = false;
  await observeAssignment({ baseUrl: "http://fixture/a", headers: {}, signal: abort.signal,
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": keepalive\n\n")); }, cancel() { cancelled = true; } })),
    onConnection: () => abort.abort(), onRun: () => assert.fail(), onEvent: () => assert.fail(),
  });
  assert.equal(cancelled, true);
});

test("actual app error handler no longer converts connection errors into terminal UI failure", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const context = vm.createContext({ setStatus() {} });
  vm.runInContext(source.slice(source.indexOf("function onEvent("), source.indexOf("async function refreshArtifacts(")), context);
  const assistant = { status: "running", text: "work remains visible", reasoning: "progress" };
  assert.equal(context.onEvent({ type: "error", data: { error: "fetch failed" } }, {}, assistant), false);
  assert.deepEqual(assistant, { status: "running", text: "work remains visible", reasoning: "progress" });
});

test("a persisted pre-admission failure completes the submitted message without opening SSE", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(source, /if \(body\.assignment\.status === "failed"\) \{[\s\S]*?completeAssistantMessage\(assistantMessage\);[\s\S]*?return;/);
  const failureBranch = source.match(/if \(body\.assignment\.status === "failed"\) \{[\s\S]*?\n\s*\}\n\s*setStatus/)?.[0] ?? "";
  assert.doesNotMatch(failureBranch, /streamAssignment\(/);
});

test("a later turn's live event repaints only its own assistant card", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const conversation = {
    id: "conversation",
    messages: [
      { id: "completed", role: "assistant", status: "completed" },
      { id: "streaming", role: "assistant", status: "running" },
    ],
  };
  let fullRenders = 0;
  const bindings: string[] = [];
  const writes = new Map<string, number>();
  const outputs = new Map<string, { scrollTop: number; scrollHeight: number; clientHeight: number }>();
  const cards = new Map<string, { outerHTMLWrites: number; querySelector(selector: string): unknown; outerHTML: string }>();
  const card = (id: string) => {
    const value = {
      outerHTMLWrites: 0,
      querySelector(selector: string) { return selector === ".live-output-text" ? outputs.get(id) ?? null : null; },
      set outerHTML(_html: string) {
        value.outerHTMLWrites += 1;
        writes.set(id, (writes.get(id) || 0) + 1);
        cards.set(id, card(id));
      },
    };
    return value;
  };
  cards.set("completed", card("completed"));
  cards.set("streaming", card("streaming"));
  outputs.set("streaming", { scrollTop: 0, scrollHeight: 20, clientHeight: 20 });
  const scroll = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
  const context = vm.createContext({
    pendingLiveAssistantIds: new Set(["streaming"]),
    activeConversation: () => conversation,
    renderedConversationId: "conversation",
    CSS: { escape: (value: string) => value },
    document: { querySelector: (selector: string) => {
      const messageId = /data-assistant-message="([^"]+)"/.exec(selector)?.[1];
      return messageId === undefined ? null : cards.get(messageId) ?? null;
    } },
    $: () => scroll,
    isNearBottom: () => true,
    nextScrollTop: () => 0,
    renderMessage: (message: { id: string }) => `<article>${message.id}</article>`,
    bindAssistantCard: (_card: unknown, _conversation: unknown, messages: Array<{ id: string }>) => bindings.push(messages.find((message) => message.id === "streaming")?.id || "missing"),
    render: () => { fullRenders += 1; },
    liveUpdates: { request() {}, flush() {} },
  });
  vm.runInContext(source.slice(source.indexOf("function requestLiveAssistantUpdate("), source.indexOf("function render()")), context);

  context.renderPendingLiveAssistantMessages();

  assert.equal(writes.get("completed") || 0, 0);
  assert.equal(writes.get("streaming"), 1);
  assert.deepEqual(bindings, ["streaming"]);
  assert.equal(fullRenders, 0);
});

test("actual app repairs legacy false failure but never regresses a confirmed terminal Run", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const context = vm.createContext({ completeAssistantMessage() {}, recoveredFailureMessage: () => "Host failure" });
  vm.runInContext(source.slice(source.indexOf("function applyRecoveredRunState("), source.indexOf("function recoveredFailureMessage(")), context);
  const old = { status: "failed", text: "network error", error: "network error", completedAt: 20, events: [] };
  assert.equal(context.applyRecoveredRunState(old, { status: "running" }), true);
  assert.equal(old.status, "running"); assert.equal(old.completedAt, undefined); assert.equal(old.error, undefined);
  const terminal = { status: "completed", events: [event(2, "run.completed")] };
  assert.equal(context.applyRecoveredRunState(terminal, { status: "running" }), false);
  assert.equal(terminal.status, "completed");
});

test("server recency correction replaces stale browser cache ordering", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const context = vm.createContext({ activeRunsByConversation: new Map() });
  vm.runInContext('const recoveredSessions = [{ id: "old", title: "old", createdAt: 1, updatedAt: 10000, messages: [] }]; let sessions = [];', context);
  vm.runInContext(source.slice(source.indexOf("function mergeConversationSummaries("), source.indexOf("async function selectConversation(")), context);
  context.mergeConversationSummaries([{ id: "old", createdAt: 1, updatedAt: 200 }, { id: "recent", createdAt: 400, updatedAt: 500 }], true);
  assert.equal(vm.runInContext('sessions[0].id', context), "recent");
  assert.equal(vm.runInContext('sessions[1].updatedAt', context), 200);
});

test("server refresh invalidates cached history so Assignment artifacts are hydrated again", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const context = vm.createContext({ activeRunsByConversation: new Map() });
  vm.runInContext(`
    const recoveredSessions = [{
      id: "cached",
      title: "cached",
      createdAt: 1,
      updatedAt: 2,
      historyLoaded: true,
      messages: [{ role: "assistant", assignmentId: "assignment-cached", artifacts: [] }],
    }];
    let sessions = [];
  `, context);
  vm.runInContext(source.slice(source.indexOf("function mergeConversationSummaries("), source.indexOf("async function selectConversation(")), context);

  context.mergeConversationSummaries([{ id: "cached", createdAt: 1, updatedAt: 3, runCount: 1 }], true);

  assert.equal(vm.runInContext('sessions[0].historyLoaded', context), false);
  assert.equal(vm.runInContext('sessions[0].messages[0].assignmentId', context), "assignment-cached");
});
