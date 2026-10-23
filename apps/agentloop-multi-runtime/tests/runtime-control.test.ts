import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createWebServer } from "../web/server.mjs";
import { mountRuntimeReload } from "../web/pages/cloud-runtime-reload.js";

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    try { const value = await read(); if (ready(value)) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error("condition did not become true");
}

test("Web -> Unix host control authenticates, tracks reload, rejects overlap and preserves completion across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "alc-"));
  const socket = join(root, "control.sock");
  const token = "fixture-operator-credential-" + "a".repeat(32);
  const helper = join(root, "helper.sh");
  await writeFile(join(root, "token"), token);
  await writeFile(helper, `#!/bin/bash\nset -eu\ntest "$1" = reload\necho started >> '${root}/starts'\nwhile [ ! -f '${root}/finish' ]; do sleep 0.02; done\necho 'Ready: runtime'\n`);
  let daemon: ChildProcess;
  let stderr = "";
  function start() {
    daemon = spawn("python3", [fileURLToPath(new URL("../deploy/production/runtime-control.py", import.meta.url)),
      "--root", root, "--socket", socket, "--helper", helper, "--token-file", join(root, "token")]);
    daemon.stderr?.on("data", chunk => { stderr += String(chunk); });
  }
  async function stop() {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return;
    const exit = new Promise(resolve => daemon.once("exit", resolve));
    daemon.kill();
    await exit;
  }
  const web = createWebServer({ runtimeControlSocket: socket });
  await new Promise<void>(resolve => web.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await stop(); await new Promise<void>(resolve => web.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const address = web.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/operations/runtime-reload`;
  const call = (method = "GET", credential = token) => fetch(url, { method, headers: { authorization: `Bearer ${credential}` } });
  start();
  await until(() => call(), r => r.status === 200);
  assert.equal((await call("POST", "wrong")).status, 401);
  assert.equal((await call("DELETE")).status, 405);
  assert.equal((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "arbitrary-command" })).status, 400);
  assert.equal((await call("POST")).status, 202);
  const duplicate = await call("POST");
  assert.equal(duplicate.status, 409);
  const running = await duplicate.json();
  assert.equal(running.status, "running");
  await until(() => readFile(join(root, "starts"), "utf8"), s => s === "started\n");
  await writeFile(join(root, "finish"), "");
  const done = await until(async () => (await call()).json(), s => s.status === "succeeded");
  assert.equal(done.id, running.id);
  assert.doesNotMatch(JSON.stringify(done), new RegExp(token));
  assert.equal(await readFile(join(root, "starts"), "utf8"), "started\n");
  await stop();
  start();
  const restored = await until(async () => (await call()).json(), s => s.status === "succeeded");
  assert.equal(restored.id, done.id);
  await stop();
  assert.equal((await call()).status, 503);
  assert.equal(stderr, "");
});

test("host control records failure without exposing helper output and marks interrupted operations unconfirmed", async () => {
  const python = fileURLToPath(new URL("../deploy/production/runtime-control.py", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "alc-"));
  try {
    await writeFile(join(root, "token"), "a".repeat(64));
    await writeFile(join(root, "helper.sh"), "echo 'Active/nonterminal Runs: 1; secret-should-not-leak'\nexit 1\n");
    const code = `import importlib.util,json,time\ns=importlib.util.spec_from_file_location('control',${JSON.stringify(python)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nr=${JSON.stringify(root)}\nc=m.RuntimeControl(r,r+'/helper.sh',r+'/token')\nc.start()\nwhile c.state['status']=='running': time.sleep(.01)\nprint(json.dumps(c.state))\nc.update(status='running')\nd=m.RuntimeControl(r,r+'/helper.sh',r+'/token')\nprint(json.dumps(d.state))\n`;
    const child = spawn("python3", ["-B", "-c", code]);
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    const exit = await new Promise(resolve => child.once("exit", resolve));
    assert.equal(exit, 0);
    const [failed, interrupted] = output.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(failed.status, "failed");
    assert.equal(failed.phase, "active_runs");
    assert.equal(interrupted.phase, "reload_interrupted");
    assert.doesNotMatch(output, /secret-should-not-leak/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reload page submits only the operation, polls to completion, and distinguishes rejection and unknown result", async () => {
  const elements = new Map<string, any>();
  for (const id of ["reload-form", "operator-token", "reload-runtime", "reload-status-refresh", "reload-status"]) {
    elements.set(id, { value: "", disabled: false, dataset: {}, listeners: {}, addEventListener(event: string, fn: unknown) { this.listeners[event] = fn; } });
  }
  elements.get("operator-token").value = "private-operator-token";
  const calls: any[] = [];
  const states: any[] = [{ status: "running", id: "operation-1" }, { status: "succeeded", id: "operation-1" }];
  let poll: () => void;
  mountRuntimeReload({ document: { getElementById: (id: string) => elements.get(id) }, confirm: () => true,
    fetch: async (url: string, options: any) => { calls.push({ url, options }); const state = states.shift(); if (state instanceof Error) throw state; return { ok: !state.error, status: state.error ? 401 : 200, json: async () => state }; },
    setTimeout: (fn: () => void) => { poll = fn; }, clearTimeout: () => {} });
  elements.get("reload-form").listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body, undefined);
  assert.equal(elements.get("reload-runtime").disabled, true);
  poll!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[1].options.method, "GET");
  assert.match(elements.get("reload-status").textContent, /重新加载完成/);
  states.push({ error: "operator_unauthorized" });
  elements.get("reload-status-refresh").listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(elements.get("reload-status").textContent, /凭证不正确/);
  states.push(new Error("connection lost"));
  elements.get("reload-status-refresh").listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(elements.get("reload-status").textContent, /可能仍在服务器执行/);
  assert.doesNotMatch(elements.get("reload-status").textContent, /重新加载完成/);
});
