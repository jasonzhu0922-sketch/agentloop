import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
const centosCompose = await readFile(new URL("../deploy/centos7/compose.yaml", import.meta.url), "utf8");
const launcher = await readFile(new URL("../deploy/centos7/deploy.sh", import.meta.url), "utf8");
const imageBuilder = await readFile(new URL("../deploy/centos7/build-image.sh", import.meta.url), "utf8");

test("Web proxies to the Router service instead of its own container loopback", () => {
  assert.match(compose, /web:\n[\s\S]*?ROUTER_URL: http:\/\/router:8788/);
  assert.doesNotMatch(compose, /web:\n[\s\S]*?ROUTER_URL: http:\/\/localhost:8788/);
});

test("CentOS deployment exposes an Agent-reachable Router URL and proves both routes", () => {
  assert.doesNotMatch(centosCompose, /^\s+build:/m);
  assert.match(centosCompose, /"\$\{ROUTER_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{ROUTER_PORT:-8788\}:8788"/);
  assert.match(centosCompose, /ROUTER_URL: http:\/\/router:8788/);
  assert.match(centosCompose, /PLANNING_MAX_TURNS: \$\{PLANNING_MAX_TURNS:-4\}/);
  assert.match(centosCompose, /STEP_MAX_TURNS: \$\{STEP_MAX_TURNS:-32\}/);
  assert.match(centosCompose, /ROUTER_PUBLIC_URL: \$\{PUBLIC_ROUTER_URL:\?set the externally routable Router URL\}/);
  assert.equal((centosCompose.match(/host\.docker\.internal:host-gateway/g) ?? []).length, 3);
  assert.match(centosCompose, /"\$\{WEB_BIND_ADDRESS:-0\.0\.0\.0\}:\$\{WEB_PORT:-80\}:5174"/);
  assert.match(launcher, /\/api\/healthz/);
  assert.match(launcher, /docker load -i/);
  assert.match(imageBuilder, /agentloop-centos7-release/);
  assert.match(imageBuilder, /custom-skills\.zip/);
});
