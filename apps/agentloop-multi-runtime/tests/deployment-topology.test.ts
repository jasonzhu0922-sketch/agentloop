import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const renderer = fileURLToPath(new URL("../deploy/centos7/render-topology.py", import.meta.url));

async function fixture(settings: string) {
  const root = await mkdtemp(join(tmpdir(), "agentloop-topology-render-"));
  const envFile = join(root, ".env");
  const runtimeEnv = join(root, "runtime.env");
  await writeFile(runtimeEnv, "MODEL_KEY=fixture-secret-not-in-artifacts\n");
  await writeFile(envFile, `MULTI_RUNTIME_IMAGE=agentloop-multi-runtime:test
PUBLIC_WEB_ORIGIN=http://example:3001
PUBLIC_ROUTER_URL=http://example:5001
RUNTIME_DISPATCH_TOKEN=fixture-dispatch-secret
RUNTIME_ATTACHMENT_TOKEN=fixture-attachment-secret
DEPLOY_ROOT=${root}
RUNTIME_ENV_FILE=${runtimeEnv}
RUNTIME_WORKSPACE_HOST_PATH=${root}/workspace
CUSTOM_SKILLS_HOST_PATH=${root}/skills
LLM_PROVIDER_CONFIG_FILE=${root}/llm.json
${settings}\n`);
  const render = () => spawnSync("python3", [renderer, "--root", root, "--env-file", envFile], {encoding:"utf8"});
  return { root, envFile, render };
}

for (const [settings, count, capacity] of [["",2,20], ["RUNTIME_COUNT=1",1,20], ["RUNTIME_COUNT='4' # capacity\nMAX_CONCURRENT_RUNS=8",4,8], ["RUNTIME_COUNT=12",12,20], ["RUNTIME_COUNT=256",256,20]] as const) {
  test(`render count=${count}, capacity=${capacity}: real Compose and Router catalog agree`, async () => {
    const f = await fixture(settings);
    const result = f.render();
    assert.equal(result.status, 0, result.stderr);
    const path = result.stdout.trim();
    const compose = spawnSync("docker", ["compose", "--env-file",f.envFile,"-f",path,"config","--format","json"], {encoding:"utf8", env: {...process.env, MAX_CONCURRENT_RUNS:"999"}, maxBuffer: 8 * 1024 * 1024});
    assert.equal(compose.status,0,compose.stderr);
    const services = JSON.parse(compose.stdout).services;
    const catalog = JSON.parse(await readFile(join(dirname(path),"runtimes.json"),"utf8"));
    assert.equal(Object.keys(services).length,count+2);
    assert.equal(catalog.runtimes.length,count);
    const ids = new Set();
    const volumes = new Set();
    for (const runtime of catalog.runtimes) {
      const host = services[`runtime-${runtime.id}`];
      assert.ok(host);
      assert.equal(host.environment.RUNTIME_ID,runtime.id);
      assert.equal(Number(host.environment.MAX_CONCURRENT_RUNS),capacity);
      assert.equal(runtime.maxConcurrentRuns,capacity);
      assert.equal(runtime.endpoint,`http://runtime-${runtime.id}:${host.environment.PORT}`);
      assert.equal(host.ports,undefined);
      ids.add(host.environment.RUNTIME_ID);
      volumes.add(host.volumes.find((v: {target: string}) => v.target === "/app/apps/agentloop-multi-runtime/data").source);
    }
    assert.equal(ids.size,count);
    assert.equal(volumes.size,count);
    assert.equal(services.router.environment.RUNTIME_CONFIG_PATH,"/run/topology/runtimes.json");
    assert.equal(services.router.environment.MODEL_KEY,undefined);
    assert.equal(services.web.environment.MODEL_KEY,undefined);
    for (const file of await readdir(dirname(path))) {
      assert.doesNotMatch(await readFile(join(dirname(path),file),"utf8"),/fixture-(secret|dispatch-secret|attachment-secret)/);
    }
    // Each render preserves the previous immutable files for rollback.
    const previous = await readFile(path,"utf8");
    const next = f.render();
    assert.equal(next.status,0,next.stderr);
    assert.notEqual(next.stdout.trim(),path);
    assert.equal(await readFile(path,"utf8"),previous);
  });
}

for (const settings of ["RUNTIME_COUNT=0", "RUNTIME_COUNT=257", "RUNTIME_COUNT=-1", "RUNTIME_COUNT=1.5", "RUNTIME_COUNT=$(echo 4)", "RUNTIME_COUNT=2\nRUNTIME_COUNT=3", "MAX_CONCURRENT_RUNS=0"]) {
  test(`reject invalid topology input: ${settings}`, async () => {
    const f = await fixture(settings);
    const result = f.render();
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Topology error:/);
    assert.equal((await readdir(f.root)).includes("deployments"),false);
  });
}
