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
  assert.match(centosCompose, /"\$\{ROUTER_BIND_ADDRESS:-0\.0\.0\.0\}:\$\{ROUTER_PORT:-8788\}:8788"/);
  assert.match(centosCompose, /ROUTER_URL: http:\/\/router:8788/);
  assert.match(centosCompose, /PLANNING_MAX_TURNS: \$\{PLANNING_MAX_TURNS:-4\}/);
  assert.match(centosCompose, /STEP_MAX_TURNS: \$\{STEP_MAX_TURNS:-32\}/);
  assert.match(centosCompose, /ROUTER_PUBLIC_URL: \$\{PUBLIC_ROUTER_URL:\?set the externally routable Router URL\}/);
  assert.equal((centosCompose.match(/host\.docker\.internal:host-gateway/g) ?? []).length, 3);
  assert.match(centosCompose, /"\$\{WEB_BIND_ADDRESS:-0\.0\.0\.0\}:\$\{WEB_PORT:-3001\}:5174"/);
  assert.match(launcher, /PUBLIC_WEB_ORIGIN=http:\/\/%s:3001/);
  assert.match(launcher, /PUBLIC_ROUTER_URL=http:\/\/%s:8788/);
  assert.match(launcher, /WEB_PORT=3001/);
  assert.match(launcher, /\/api\/healthz/);
  assert.match(launcher, /docker load -i/);
  assert.match(imageBuilder, /agentloop-centos7-release/);
  assert.match(imageBuilder, /custom-skills\.zip/);
  assert.match(imageBuilder, /config\/llm-providers\.example\.json/);
  assert.match(launcher, /\$APP_ROOT\/config\/llm-providers\.example\.json/);
  assert.match(imageBuilder, /git -C "\$REPOSITORY_ROOT" archive/);
  assert.match(imageBuilder, /release-manifest\.env/);
  assert.match(imageBuilder, /--cache-to/);
  assert.match(imageBuilder, /--build-arg "NODE_IMAGE=\$NODE_IMAGE"/);
  assert.match(imageBuilder, /--build-arg "APT_MIRROR=\$APT_MIRROR"/);
  assert.match(imageBuilder, /--build-arg "PIP_FALLBACK_INDEX_URL=\$PIP_FALLBACK_INDEX_URL"/);
  assert.match(imageBuilder, /--build-arg "PLAYWRIGHT_DOWNLOAD_HOST=\$PLAYWRIGHT_DOWNLOAD_HOST"/);
  assert.match(imageBuilder, /PLAYWRIGHT_DOWNLOAD_HOST=\$PLAYWRIGHT_DOWNLOAD_HOST/);
  assert.match(launcher, /release IMAGE_ARCHIVE RELEASE_MANIFEST/);
  assert.match(launcher, /release failed; restoring prior deployment configuration/);
  assert.match(launcher, /for name in NODE_IMAGE APT_MIRROR PIP_INDEX_URL PIP_FALLBACK_INDEX_URL PLAYWRIGHT_DOWNLOAD_HOST/);
});
