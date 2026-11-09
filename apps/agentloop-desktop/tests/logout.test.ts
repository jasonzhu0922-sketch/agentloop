import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const script = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
function section(from: string, to: string) {
  const start = script.indexOf(from), end = script.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return script.slice(start, end);
}

for (const statusCode of [200, 401]) {
  test(`logout reaches the login page with the actual page controls (HTTP ${statusCode})`, async () => {
    // Use the HTML's real control IDs. A permissive element stub would hide
    // removed controls such as allow-execution and reproduce the original gap.
    const controls = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], {
      disabled: false, hidden: false, querySelectorAll: () => [], onclick: undefined as undefined | (() => Promise<void>),
    }]));
    const navigations: string[] = [], errors: string[] = [];
    runInNewContext([
      section("async function api(", "function busy("),
      section("function busy(", "async function loadRuntimes("),
      section("element('logout').onclick =", "element('message').onkeydown ="),
    ].join("\n"), {
      element: (id: string) => controls.get(id) ?? null,
      conversationRuntimeLocked: false, runtimeNames: new Map(), runtimeId: "desktop-default", steerAccount: undefined, conversationId: undefined,
      csrf: "synthetic", generation: 0, locked: false, activeRun: undefined, cancelling: false,
      PENDING_KEY: "test-pending", sessionStorage: { removeItem() {} },
      location: { replace: (url: string) => navigations.push(url) },
      status: (message: string) => errors.push(message),
      fetch: async () => ({ ok: statusCode === 200, status: statusCode,
        json: async () => statusCode === 200 ? { loggedOut: true, cloudRevoked: true } : { error: "session_required" } }),
    });
    await controls.get("logout")!.onclick!();
    assert.deepEqual(navigations, ["/login"], errors.join("\n"));
    assert.equal(errors.some(message => message.includes("Cannot set properties of null")), false);
  });
}
