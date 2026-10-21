import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = fileURLToPath(new URL("../deploy/production/", import.meta.url));
const serverScript = await readFile(join(scripts, "server-operations.sh"), "utf8");

// Exercise the real server script and its file changes. Only external host
// commands are replaced; no SSH connection or production directory is used.
async function fixture(options: { invalid?: boolean; active?: boolean; failReady?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentloop-production-test-"));
  const job = join(root, "job");
  const bin = join(root, "bin");
  const previous = join(root, "releases", "old");
  const compose = join(previous, "source/apps/agentloop-multi-runtime/deploy/centos7/compose.yaml");
  await Promise.all([mkdir(job), mkdir(bin), mkdir(dirname(compose), { recursive: true }), mkdir(join(root, "config")), mkdir(join(root, "secrets"))]);
  const config = join(root, "config/llm-providers.json");
  const envFile = join(root, "secrets/runtime.env");
  await writeFile(compose, "services: {}\n");
  await writeFile(config, '{"marker":"original"}\n');
  await writeFile(envFile, "MODEL_KEY=original-secret\nSKILL_KEY=preserved-secret\n", { mode: 0o600 });
  await writeFile(join(root, ".env"), `MULTI_RUNTIME_IMAGE=agentloop-multi-runtime:old\nRUNTIME_ENV_FILE=${envFile}\nWEB_PORT=13001\nROUTER_PORT=15001\n`);
  await writeFile(join(job, "llm-providers.json"), '{"marker":"candidate"}\n');
  await writeFile(join(previous, "release-manifest.env"), "NODE_IMAGE=example/node@sha256:" + "a".repeat(64) + "\nAPT_MIRROR=https://apt.example\nPIP_INDEX_URL=https://pip.example\nPIP_FALLBACK_INDEX_URL=https://fallback.example\nPLAYWRIGHT_DOWNLOAD_HOST=https://browser.example\n");
  const helper = join(root, "helper.sh");
  await writeFile(helper, serverScript.replace("root=/opt/agentloop", `root='${root}'`));
  const docker = `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path');
const a=process.argv.slice(2),root=process.env.FIXTURE_ROOT;
fs.appendFileSync(p.join(root,'commands.jsonl'),JSON.stringify(a)+'\\n');
if(a[0]==='inspect'){
 const f=a[a.indexOf('--format')+1];
 if(f.includes('config_files')) console.log(process.env.FIXTURE_COMPOSE);
 else if(f.includes('/run/config/llm-providers.json')) console.log(p.join(root,'config/llm-providers.json'));
 else if(f.includes('.Config.Image')) console.log(fs.readFileSync(p.join(root,'.env'),'utf8').match(/^MULTI_RUNTIME_IMAGE=(.*)$/m)[1]);
} else if(a[0]==='exec'){
 if(a.includes('printenv')) console.log('postgres');
 else if(a.includes('-i')){const input=JSON.parse(fs.readFileSync(0,'utf8')); if(!input.config)process.exit(2); if(process.env.INVALID_CONFIG==='1')process.exit(1);}
 else if(a.some(x=>x.includes('Container readiness timed out')) && process.env.FAIL_READY==='1' && !fs.existsSync(p.join(root,'readiness-failed'))){fs.writeFileSync(p.join(root,'readiness-failed'),'1'); process.exit(1);}
} else if(a[0]==='buildx'){console.log('CACHED tool layers; rebuilt application');}
`;
  const sudo = `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_ROOT+'/commands.jsonl',JSON.stringify(['sudo',...a])+'\\n');
if(a.includes('psql')) console.log(process.env.ACTIVE_RUNS==='1'?'1':'0');
else if(a.includes('pg_dump')) process.stdout.write('fixture-database-dump');
else if(a.includes('pg_restore')) fs.readFileSync(0);
`;
  for (const [name, content] of Object.entries({ docker, sudo, id: "#!/bin/sh\necho 0\n", flock: "#!/bin/sh\nexit 0\n" })) {
    await writeFile(join(bin, name), content);
    await chmod(join(bin, name), 0o755);
  }
  const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_ROOT: root, FIXTURE_COMPOSE: compose, INVALID_CONFIG: options.invalid ? "1" : "0", ACTIVE_RUNS: options.active ? "1" : "0", FAIL_READY: options.failReady ? "1" : "0" };
  const run = (operation = "llm", extra: string[] = []) => spawnSync("bash", [helper, operation, job, ...extra], { env: environment, encoding: "utf8" });
  const commands = async (): Promise<string[][]> => (await readFile(join(root, "commands.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { root, job, config, envFile, run, commands };
}

test("LLM config update preserves secrets and recreates only the two Runtime services", async () => {
  const f = await fixture();
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(f.config, "utf8"), '{"marker":"candidate"}\n');
  assert.match(await readFile(f.envFile, "utf8"), /SKILL_KEY=preserved-secret/);
  const up = (await f.commands()).filter(a => a[0] === "compose" && a.includes("up"));
  assert.equal(up.length, 1);
  assert.deepEqual(up[0].slice(-5), ["--no-deps", "--no-build", "--force-recreate", "runtime-general-01", "runtime-general-02"]);
  assert.doesNotMatch(result.stdout + result.stderr, /original-secret|preserved-secret/);
});

test("LLM config rejects invalid candidate before replacing files or restarting services", async () => {
  const f = await fixture({ invalid: true });
  assert.notEqual(f.run().status, 0);
  assert.equal(await readFile(f.config, "utf8"), '{"marker":"original"}\n');
  assert.equal((await f.commands()).some(a => a.includes("up")), false);
});

test("nonterminal Runs block a config switch", async () => {
  const f = await fixture({ active: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Active\/nonterminal Runs: 1/);
  assert.equal(await readFile(f.config, "utf8"), '{"marker":"original"}\n');
  assert.equal((await f.commands()).some(a => a.includes("up")), false);
});

test("Runtime readiness failure restores both config and complete env file", async () => {
  const f = await fixture({ failReady: true });
  await writeFile(join(f.job, "runtime.env"), "MODEL_KEY=replacement-secret\n");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(f.config, "utf8"), '{"marker":"original"}\n');
  assert.match(await readFile(f.envFile, "utf8"), /SKILL_KEY=preserved-secret/);
  assert.equal((await f.commands()).filter(a => a[0] === "compose" && a.includes("up")).length, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /replacement-secret/);
});

test("cloud release reuses immutable build inputs and preserves deployed port config", async () => {
  const f = await fixture();
  const source = join(f.root, "archive-source");
  const centos = join(source, "apps/agentloop-multi-runtime/deploy/centos7");
  await mkdir(centos, { recursive: true });
  await writeFile(join(centos, "compose.yaml"), "services: {}\n");
  await writeFile(join(centos, "deploy.sh"), "#!/bin/sh\nexit 0\n");
  await mkdir(join(f.root, ".docker-build-cache/multi-runtime-linux-amd64"), { recursive: true });
  await writeFile(join(f.root, ".docker-build-cache/multi-runtime-linux-amd64/index.json"), "{}");
  const archive = join(f.job, "source.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", source, "."]);
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  const sha = "b".repeat(40);
  const result = f.run("cloud", [sha, digest]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const build = (await f.commands()).find(a => a[0] === "buildx")!;
  assert.ok(build.includes("NODE_IMAGE=example/node@sha256:" + "a".repeat(64)));
  assert.ok(build.includes("--cache-from") && build.includes("--cache-to"));
  const env = await readFile(join(f.root, ".env"), "utf8");
  assert.match(env, new RegExp(`MULTI_RUNTIME_IMAGE=agentloop-multi-runtime:${sha}`));
  assert.match(env, /WEB_PORT=13001\nROUTER_PORT=15001/);
  assert.equal(await readFile(f.config, "utf8"), '{"marker":"original"}\n');
  assert.match(result.stdout, /Rollback: bash/);
});

test("all public scripts support help; release preview needs no SSH", () => {
  for (const script of ["release-cloud.sh", "update-cloud-llm.sh", "package-local-agent.sh"]) {
    const result = spawnSync("bash", [join(scripts, script), "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  }
  const result = spawnSync("bash", [join(scripts, "release-cloud.sh"), "--dry-run"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Preview only/);
});

test("real registry preflight rejects missing credentials in a complete env replacement", async () => {
  const marker = 'node --input-type=module -e \'\n    import fs from "node:fs";';
  const start = serverScript.indexOf(marker);
  assert.ok(start >= 0);
  const codeStart = start + 'node --input-type=module -e \''.length;
  const end = serverScript.indexOf("\n  '\nfrom pathlib", codeStart);
  assert.ok(end > codeStart);
  const code = serverScript.slice(codeStart, end);
  const config = JSON.parse(await readFile(new URL("../config/llm-providers.example.json", import.meta.url), "utf8"));
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const environment = { ...process.env, OPENAI_API_KEY: "fixture-openai-key", MY_LLM_API_KEY: "fixture-other-key" };
  const invoke = (newEnvironment: string | null) => spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd, env: environment, encoding: "utf8", input: JSON.stringify({ config, oldEnvironment: "OPENAI_API_KEY=old\nMY_LLM_API_KEY=old\n", newEnvironment }),
  });
  const valid = invoke(null);
  assert.equal(valid.status, 0, valid.stderr);
  const missing = invoke("OPENAI_API_KEY=replacement\n");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /check its credential variable/);
  assert.doesNotMatch(valid.stdout + valid.stderr + missing.stdout + missing.stderr, /fixture-openai-key|fixture-other-key|replacement/);
});
