import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
const lifecycleSource = source.slice(source.indexOf("function setLocalRuntimeLifecycleStatus("), source.indexOf("async function toggleLocalRuntimeStarted("));

test("local Runtime lifecycle reports per-Runtime pending and completed state", async () => {
  let resolveRequest!: (response: Response) => void;
  const statuses: Array<[string, string]> = [];
  const localRuntimeState = { lifecycleOperations: {} as Record<string, { message: string; tone: string; pending: boolean }> };
  const timers = new Map<number, () => void>();
  let nextTimerId = 0;
  const lifecycle = vm.runInNewContext(`${lifecycleSource}\napplyLocalRuntimeLifecycle`, {
    Error,
    encodeURIComponent,
    selectedLocalRuntime: () => ({ id: "runtime-1", displayName: "查数小专家" }),
    localRuntimeState,
    syncLocalRuntimeManager: () => undefined,
    setTimeout: (callback: () => void) => { const id = ++nextTimerId; timers.set(id, () => { timers.delete(id); callback(); }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    localAgentRouterPath: (path: string) => path,
    routerClient: { request: async () => await new Promise<Response>((resolve) => { resolveRequest = resolve; }) },
    loadLocalRuntimes: async () => undefined,
    loadLocalScopes: async () => undefined,
    setStatus: (message: string, tone: string) => statuses.push([message, tone]),
  });

  const pending = lifecycle("start", "runtime-1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(statuses, [["查数小专家：正在启动…", "running"]]);
  assert.equal(JSON.stringify(localRuntimeState.lifecycleOperations["runtime-1"]), JSON.stringify({ message: "查数小专家：正在启动…", tone: "running", pending: true }));

  resolveRequest(Response.json({ runtime: { displayName: "查数小专家", status: "ready" } }, { status: 200 }));
  await pending;
  assert.deepEqual(statuses.at(-1), ["查数小专家：已启动", "ok"]);
  assert.equal(JSON.stringify(localRuntimeState.lifecycleOperations["runtime-1"]), JSON.stringify({ message: "查数小专家：已启动", tone: "ok", pending: false }));
  assert.equal(timers.size, 1);
  timers.values().next().value!();
  assert.equal(localRuntimeState.lifecycleOperations["runtime-1"], undefined);

  for (const [action, pendingMessage, completedMessage, finalStatus] of [
    ["restart", "查数小专家：正在重启…", "查数小专家：重启请求已提交", "ready"],
    ["stop", "查数小专家：正在停止…", "查数小专家：已停止", "stopped"],
  ] as const) {
    statuses.length = 0;
    const next = lifecycle(action, "runtime-1");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(JSON.stringify(localRuntimeState.lifecycleOperations["runtime-1"]), JSON.stringify({ message: pendingMessage, tone: "running", pending: true }));
    resolveRequest(Response.json({ runtime: { displayName: "查数小专家", status: finalStatus } }, { status: 200 }));
    await next;
    assert.equal(JSON.stringify(localRuntimeState.lifecycleOperations["runtime-1"]), JSON.stringify({ message: completedMessage, tone: "ok", pending: false }));
    timers.values().next().value!();
    assert.equal(localRuntimeState.lifecycleOperations["runtime-1"], undefined);
  }
});

test("local Runtime action clicks close an open menu before dispatch", () => {
  assert.match(source, /button\.closest\("details"\)\?\.removeAttribute\("open"\)/);
});
