import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { localAgentPort, localAgentUrl } from "../src/shared/local-agent-endpoint.mjs";

test("source and installed Agents reserve separate defaults regardless of NODE_ENV", () => {
  for (const NODE_ENV of ["development", "test", "production"]) {
    assert.equal(localAgentPort(false, { NODE_ENV }), 8790);
    assert.equal(localAgentPort(true, { NODE_ENV }), 18790);
  }
});

test("explicit Agent port remains validated and Web uses the same override", () => {
  for (const packaged of [false, true]) {
    assert.equal(localAgentPort(packaged, { LOCAL_AGENT_PORT: "28790" }), 28790);
    for (const value of ["", "0", "-1", "65536", "8790.5", "invalid"]) {
      assert.throws(() => localAgentPort(packaged, { LOCAL_AGENT_PORT: value }), /LOCAL_AGENT_PORT/);
    }
  }
  assert.equal(localAgentUrl({ LOCAL_AGENT_PORT: "28790" }), "http://127.0.0.1:28790");
  assert.equal(localAgentUrl({ NODE_ENV: "production", LOCAL_AGENT_PORT: "28790" }), "http://127.0.0.1:28790");
  assert.equal(localAgentUrl({ NODE_ENV: "production", LOCAL_AGENT_URL: "http://127.0.0.1:38790" }), "http://127.0.0.1:38790");
});

test("Web runtime configuration selects only its environment's Agent endpoint", () => {
  const serverUrl = new URL("../web/server.mjs", import.meta.url).href;
  for (const [NODE_ENV, expected] of [["development", "http://127.0.0.1:8790"], ["production", "http://127.0.0.1:18790"]]) {
    const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV };
    delete environment.LOCAL_AGENT_PORT;
    delete environment.LOCAL_AGENT_URL;
    const script = execFileSync(process.execPath, ["--input-type=module", "-e",
      `import { runtimeConfigScript } from ${JSON.stringify(serverUrl)}; process.stdout.write(runtimeConfigScript("https://router.example"));`,
    ], { env: environment, encoding: "utf8" });
    const browser: { AGENTLOOP_LOCAL_AGENT_URL?: string } = {};
    runInNewContext(script, browser);
    assert.equal(browser.AGENTLOOP_LOCAL_AGENT_URL, expected);
  }
});

test("production Compose directs browsers to the installed Agent and preserves deployment overrides", async () => {
  const compose = await readFile(new URL("../deploy/centos7/compose.yaml", import.meta.url), "utf8");
  assert.match(compose, /LOCAL_AGENT_URL: \$\{LOCAL_AGENT_URL:-http:\/\/127\.0\.0\.1:18790\}/);
});

test("both installer manifests declare the same installed Agent port as their bundled entrypoint", async () => {
  for (const platform of ["macos", "windows"]) {
    const packager = await readFile(new URL(`../scripts/package-local-agent-${platform}.mjs`, import.meta.url), "utf8");
    assert.match(packager, /localAgentPort: PACKAGED_LOCAL_AGENT_PORT/);
  }
  const main = await readFile(new URL("../local-agent-runtime/src/main.ts", import.meta.url), "utf8");
  assert.match(main, /const port = localAgentPort\(packaged\)/);
  assert.match(main, /AGENTLOOP_AGENT_PACKAGED === "1" \|\| packagedExecutable/);
});
