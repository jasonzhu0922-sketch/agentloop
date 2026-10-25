import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = fileURLToPath(new URL("../deploy/production/", import.meta.url));
const serverScript = await readFile(join(scripts, "server-operations.sh"), "utf8");

// Exercise the real server script and its file changes. Only external host
// commands are replaced; no SSH connection or production directory is used.
async function fixture(options: { invalid?: boolean; active?: boolean; failReady?: boolean; mismatchCatalog?: boolean; count?: number; desiredCount?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentloop-production-test-"));
  const job = join(root, "job");
  const bin = join(root, "bin");
  const previous = join(root, "releases", "old");
  const compose = join(previous, "source/apps/agentloop-multi-runtime/deploy/centos7/active.yaml");
  await Promise.all([mkdir(job), mkdir(bin), mkdir(dirname(compose), { recursive: true }), mkdir(join(root, "config"),{recursive:true}), mkdir(join(root, "secrets")), mkdir(join(root,"config/custom-skills"),{recursive:true})]);
  const config = join(root, "config/llm-providers.json");
  const envFile = join(root, "secrets/runtime.env");
  await writeFile(compose, "services:\n  router: {}\n  web: {}\n" + Array.from({length: options.count ?? 2}, (_, i) => `  runtime-general-${String(i + 1).padStart(2, "0")}: {}\n`).join(""));
  for (const name of ["compose.yaml", "runtime-host.yaml", "render-topology.py", "deploy.sh"]) {
    await copyFile(join(scripts, "../centos7", name), join(dirname(compose), name));
  }
  await writeFile(config, '{"marker":"original","models":{"fixture":{"displayName":"Fixture","providerModel":"fixture"}}}\n');
  await writeFile(envFile, "MODEL_KEY=original-secret\nSKILL_KEY=preserved-secret\n", { mode: 0o600 });
  await mkdir(join(root, "config/custom-skills/legacy-skill"));
  await writeFile(join(root, "config/custom-skills/legacy-skill/SKILL.md"), "# Legacy\n");
  await writeFile(join(root, "config/custom-skills/legacy-skill/.env"), "LEGACY_SECRET=keep-me\n", { mode: 0o600 });
  await writeFile(join(root, ".env"), `RUNTIME_COUNT=${options.desiredCount ?? options.count ?? 2}\nMULTI_RUNTIME_IMAGE=agentloop-multi-runtime:old\nRUNTIME_ENV_FILE=${envFile}\nWEB_PORT=13001\nROUTER_PORT=15001\n`);
  await writeFile(join(job, "llm-providers.json"), '{"marker":"candidate","models":{"fixture":{"displayName":"Fixture","providerModel":"fixture"}}}\n');
  await writeFile(join(previous, "release-manifest.env"), "NODE_IMAGE=example/node@sha256:" + "a".repeat(64) + "\nAPT_MIRROR=https://apt.example\nPIP_INDEX_URL=https://pip.example\nPIP_FALLBACK_INDEX_URL=https://fallback.example\n");
  const helper = join(root, "helper.sh");
  await writeFile(helper, serverScript);
  const docker = `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path');
const a=process.argv.slice(2),root=process.env.FIXTURE_ROOT;
fs.appendFileSync(p.join(root,'commands.jsonl'),JSON.stringify(a)+'\\n');
if(a[0]==='inspect'){
 const f=a[a.indexOf('--format')+1];
 if(f.includes('config_files')) console.log(fs.existsSync(p.join(root,'current-compose'))?fs.readFileSync(p.join(root,'current-compose'),'utf8'):process.env.FIXTURE_COMPOSE);
 else if(f.includes('/run/config/llm-providers.json')) console.log(p.join(root,'config/llm-providers.json'));
 else if(f.includes('/app/apps/agentloop-multi-runtime/custom-skills')) console.log(p.join(root,'config/custom-skills'));
 else if(f.includes('.Config.Image')) console.log(fs.readFileSync(p.join(root,'.env'),'utf8').match(/^MULTI_RUNTIME_IMAGE=(.*)$/m)[1]);
} else if(a[0]==='run'){
 if(a.some(x=>x.includes('validate-skill-archive.mjs'))){const {spawnSync}=require('node:child_process');const result=spawnSync(process.execPath,[process.env.VALIDATOR_SCRIPT],{input:fs.readFileSync(0)});process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status??1;}
} else if(a[0]==='exec'){
 if(a.includes('printenv')) console.log('postgres');
 else if(a.some(x=>x.includes('validate-skill-archive.mjs'))){const {spawnSync}=require('node:child_process');const result=spawnSync(process.execPath,[process.env.VALIDATOR_SCRIPT],{input:fs.readFileSync(0)});process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status??1;}
 else if(a.includes('-i')){const input=JSON.parse(fs.readFileSync(0,'utf8'));if(input.updates){import(process.env.MERGE_MODULE).then(m=>process.stdout.write(m.mergeEnvLines(input.environment.split(/\\r?\\n/),Object.entries(input.updates)).join('\\n')+'\\n'));}else{if(!input.config)process.exit(2); if(process.env.INVALID_CONFIG==='1')process.exit(1);}}
 else if(a.some(x=>x.includes('Container readiness timed out')) && process.env.FAIL_READY==='1' && !fs.existsSync(p.join(root,'readiness-failed'))){fs.writeFileSync(p.join(root,'readiness-failed'),'1'); process.exit(1);}
 else if(a.some(x=>x.includes('Live Runtime model catalog does not match')) && process.env.MISMATCH_CATALOG==='1')process.exit(1);
} else if(a[0]==='compose'){
 const file=a[a.indexOf('-f')+1];
 if(a.includes('--services')){for(const m of fs.readFileSync(file,'utf8').matchAll(/^  (router|web|runtime-general-[0-9]+):/gm)) console.log(m[1]);}
 if(a.includes('--format') && a.includes('json')){const services={};for(const m of fs.readFileSync(file,'utf8').matchAll(/^  (router|web|runtime-general-[0-9]+):/gm))services[m[1]]={image:'agentloop-multi-runtime:old'};console.log(JSON.stringify({services}));}
 if(a.includes('run') && process.env.INVALID_CONFIG==='1'){console.error('Invalid model configuration or missing credential; no Runtime was reloaded.');process.exit(1);}
 if(a.includes('ps') && a.includes('-q')) console.log('agentloop-'+a[a.length-1]+'-1');
 if(a.includes('up')) fs.writeFileSync(p.join(root,'current-compose'),file);
} else if(a[0]==='buildx'){console.log('CACHED tool layers; rebuilt application');}
`;
  const sudo = `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_ROOT+'/commands.jsonl',JSON.stringify(['sudo',...a])+'\\n');
if(a.includes('psql')) console.log(process.env.ACTIVE_RUNS==='1'?'1':'0');
else if(a.includes('pg_dump')) process.stdout.write('fixture-database-dump');
else if(a.includes('pg_restore')) fs.readFileSync(0);
`;
  for (const [name, content] of Object.entries({ docker, sudo, id: "#!/bin/sh\necho 0\n", flock: "#!/bin/sh\nexit 0\n", curl: "#!/bin/sh\nexit 0\n" })) {
    await writeFile(join(bin, name), content);
    await chmod(join(bin, name), 0o755);
  }
  const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENTLOOP_DEPLOY_ROOT: root, FIXTURE_ROOT: root, FIXTURE_COMPOSE: compose, INVALID_CONFIG: options.invalid ? "1" : "0", ACTIVE_RUNS: options.active ? "1" : "0", FAIL_READY: options.failReady ? "1" : "0", MISMATCH_CATALOG: options.mismatchCatalog ? "1" : "0", MERGE_MODULE: new URL("../web/pages/cloud-model-config.js", import.meta.url).href, VALIDATOR_SCRIPT: join(scripts, "validate-skill-archive.mjs") };
  const run = (operation = "llm", extra: string[] = []) => spawnSync("bash", [helper, operation, job, ...extra], { env: environment, encoding: "utf8" });
  const commands = async (): Promise<string[][]> => (await readFile(join(root, "commands.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { root, job, config, envFile, compose, environment, run, commands };
}

test("LLM config update preserves secrets and recreates only the two Runtime services", async () => {
  const f = await fixture();
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(f.config, "utf8"), '{"marker":"candidate","models":{"fixture":{"displayName":"Fixture","providerModel":"fixture"}}}\n');
  assert.match(await readFile(f.envFile, "utf8"), /SKILL_KEY=preserved-secret/);
  const up = (await f.commands()).filter(a => a[0] === "compose" && a.includes("up"));
  assert.equal(up.length, 1);
  assert.deepEqual(up[0].slice(-5), ["--no-deps", "--no-build", "--force-recreate", "runtime-general-01", "runtime-general-02"]);
  assert.doesNotMatch(result.stdout + result.stderr, /original-secret|preserved-secret/);
});

test("Skill configuration validates, preserves Skill env files, replaces the mounted directory, and recreates all Runtimes", async () => {
  const f = await fixture();
  const source = join(f.root, "skill-archive-source");
  await mkdir(join(source, "custom-skills/candidate-skill"), { recursive: true });
  await mkdir(join(source, "custom-skills/legacy-skill"), { recursive: true });
  await mkdir(join(source, "__MACOSX/candidate-skill"), { recursive: true });
  await writeFile(join(source, "custom-skills/candidate-skill/SKILL.md"), "# Candidate\n");
  await writeFile(join(source, "custom-skills/legacy-skill/SKILL.md"), "# Legacy replacement\n");
  await writeFile(join(source, "__MACOSX/._candidate-skill"), "Finder metadata\n");
  await writeFile(join(source, "__MACOSX/candidate-skill/._SKILL.md"), "Finder metadata\n");
  await writeFile(join(source, ".DS_Store"), "Finder metadata\n");
  const archive = join(f.job, "custom-skills.zip");
  execFileSync("zip", ["-qr", archive, "custom-skills"], { cwd: source });
  const result = f.run("skills");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(join(f.root, "config/custom-skills/candidate-skill/SKILL.md"), "utf8"), "# Candidate\n");
  assert.equal(await readFile(join(f.root, "config/custom-skills/legacy-skill/.env"), "utf8"), "LEGACY_SECRET=keep-me\n");
  assert.equal((await f.commands()).filter(a => a[0] === "compose" && a.includes("up")).length, 1);
  assert.match(result.stdout, /Skill package inventory and readiness checks passed/);
});

test("invalid Skill archives are rejected before replacing the mounted directory", async () => {
  const f = await fixture();
  const source = join(f.root, "invalid-skill-archive-source");
  await mkdir(join(source, "custom-skills/candidate-skill"), { recursive: true });
  await writeFile(join(source, "custom-skills/candidate-skill/SKILL.md"), "# Candidate\n");
  await writeFile(join(source, "custom-skills/candidate-skill/.env"), "SHOULD_NOT_UPLOAD=secret\n");
  execFileSync("zip", ["-qr", join(f.job, "custom-skills.zip"), "custom-skills"], { cwd: source });
  const result = f.run("skills");
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(f.root, "config/custom-skills/legacy-skill/SKILL.md"), "utf8"), "# Legacy\n");
  assert.equal((await f.commands()).some(a => a.includes("up")), false);
});

test("Skill removal deletes only the requested directory, preserves its backup path, and recreates all Runtimes", async () => {
  const f = await fixture();
  await writeFile(join(f.job, "skill-name"), "legacy-skill\n");
  const result = f.run("skills-remove");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await assert.rejects(() => readFile(join(f.root, "config/custom-skills/legacy-skill/SKILL.md")));
  assert.equal((await f.commands()).filter(a => a[0] === "compose" && a.includes("up")).length, 1);
  assert.match(result.stdout, /Removed Skill legacy-skill/);
});

test("LLM config rejects invalid candidate before replacing files or restarting services", async () => {
  const f = await fixture({ invalid: true });
  assert.notEqual(f.run().status, 0);
  assert.equal(await readFile(f.config, "utf8"), '{"marker":"original","models":{"fixture":{"displayName":"Fixture","providerModel":"fixture"}}}\n');
  assert.equal((await f.commands()).some(a => a.includes("up")), false);
});

test("nonterminal Runs block a config switch", async () => {
  const f = await fixture({ active: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Active\/nonterminal Runs: 1/);
  assert.equal(await readFile(f.config, "utf8"), '{"marker":"original","models":{"fixture":{"displayName":"Fixture","providerModel":"fixture"}}}\n');
  assert.equal((await f.commands()).some(a => a.includes("up")), false);
});

test("page credential edits merge into the complete server environment without discarding integration variables", async () => {
  const f = await fixture();
  await writeFile(join(f.job, "credential-updates.json"), JSON.stringify({ MODEL_KEY: "replacement-secret" }));
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const env = await readFile(f.envFile, "utf8");
  assert.match(env, /MODEL_KEY='replacement-secret'/);
  assert.match(env, /SKILL_KEY=preserved-secret/);
  assert.doesNotMatch(result.stdout + result.stderr, /replacement-secret|preserved-secret/);
});

test("a healthy Runtime with the wrong live catalog fails apply and restores the old configuration", async () => {
  const f = await fixture({ mismatchCatalog: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(await readFile(f.config, "utf8"), /original/);
  assert.doesNotMatch(result.stdout, /Applied llm/);
  assert.equal((await f.commands()).filter(a => a.includes("up")).length, 2);
});

test("Runtime reload validates fresh Compose environments on all deployed nodes before recreating only Runtimes", async () => {
  const f = await fixture({ count: 3, desiredCount: 8 });
  const result = f.run("reload");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(f.config, "utf8"), '{"marker":"original","models":{"fixture":{"displayName":"Fixture","providerModel":"fixture"}}}\n');
  assert.equal(await readFile(f.envFile, "utf8"), "MODEL_KEY=original-secret\nSKILL_KEY=preserved-secret\n");
  const commands = await f.commands();
  const preflight = commands.filter(a => a[0] === "compose" && a.includes("run"));
  assert.equal(preflight.length, 3);
  for (const a of preflight) assert.ok(a.includes("--rm") && a.includes("--no-deps") && a.includes("--entrypoint"));
  const up = commands.filter(a => a[0] === "compose" && a.includes("up"));
  assert.equal(up.length, 1);
  assert.deepEqual(up[0].slice(-3), ["runtime-general-01", "runtime-general-02", "runtime-general-03"]);
  assert.ok(commands.indexOf(preflight[2]) < commands.indexOf(up[0]));
  assert.equal(commands.filter(a => a[0] === "exec" && a.some(s => s.includes("Effective model configuration OK"))).length, 3);
  assert.doesNotMatch(result.stdout + result.stderr, /original-secret|preserved-secret|Rollback:/);
});

for (const options of [{ invalid: true }, { active: true }]) {
  test(`Runtime reload refuses before recreation: ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options);
    const result = f.run("reload");
    assert.notEqual(result.status, 0);
    assert.equal((await f.commands()).some(a => a.includes("up")), false);
  });
}

test("Runtime reload never reports success if any node fails readiness", async () => {
  const f = await fixture({ failReady: true });
  const result = f.run("reload");
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /Reloaded .*Runtime/);
});

test("Runtime readiness failure restores both config and complete env file", async () => {
  const f = await fixture({ failReady: true });
  await writeFile(join(f.job, "runtime.env"), "MODEL_KEY=replacement-secret\n");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(f.config, "utf8"), '{"marker":"original","models":{"fixture":{"displayName":"Fixture","providerModel":"fixture"}}}\n');
  assert.match(await readFile(f.envFile, "utf8"), /SKILL_KEY=preserved-secret/);
  assert.equal((await f.commands()).filter(a => a[0] === "compose" && a.includes("up")).length, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /replacement-secret/);
});

async function cloudArchive(f: Awaited<ReturnType<typeof fixture>>) {
  const source = join(f.root, "archive-source");
  const centos = join(source, "apps/agentloop-multi-runtime/deploy/centos7");
  const customSkills = join(source, "apps/agentloop-multi-runtime");
  await mkdir(centos, { recursive: true });
  const skillSource = join(f.root, "cloud-skills-source/custom-skills");
  await mkdir(join(skillSource, "candidate-skill"), { recursive: true });
  await mkdir(join(skillSource, "legacy-skill"), { recursive: true });
  await writeFile(join(skillSource, "candidate-skill/SKILL.md"), "# Candidate from code release\n");
  await mkdir(join(skillSource, "candidate-skill/references"), { recursive: true });
  await writeFile(join(skillSource, "candidate-skill/references/说明.md"), "Unicode reference\n");
  await writeFile(join(skillSource, "legacy-skill/SKILL.md"), "# Legacy replacement from code release\n");
  await mkdir(customSkills, { recursive: true });
  execFileSync("zip", ["-qr", join(customSkills, "custom-skills.zip"), "custom-skills"], { cwd: join(f.root, "cloud-skills-source") });
  for (const name of ["compose.yaml", "runtime-host.yaml", "render-topology.py", "deploy.sh"]) {
    await copyFile(join(scripts, "../centos7", name), join(centos, name));
  }
  await writeFile(join(centos, "deploy.sh"), "#!/bin/sh\nexit 0\n");
  await mkdir(join(f.root, ".docker-build-cache/multi-runtime-linux-amd64"), { recursive: true });
  await writeFile(join(f.root, ".docker-build-cache/multi-runtime-linux-amd64/index.json"), "{}");
  const archive = join(f.job, "source.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", source, "."]);
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  const sha = "b".repeat(40);
  return {sha, digest};
}

test("cloud release reuses immutable build inputs and preserves deployed port config", async () => {
  const f = await fixture({desiredCount: 4});
  const {sha, digest} = await cloudArchive(f);
  const result = f.run("cloud", [sha, digest]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const build = (await f.commands()).find(a => a[0] === "buildx")!;
  assert.ok(build.includes("NODE_IMAGE=example/node@sha256:" + "a".repeat(64)));
  assert.ok(build.includes("--cache-from") && build.includes("--cache-to"));
  const env = await readFile(join(f.root, ".env"), "utf8");
  assert.match(env, new RegExp(`MULTI_RUNTIME_IMAGE=agentloop-multi-runtime:${sha}`));
  assert.match(env, /WEB_PORT=13001\nROUTER_PORT=15001/);
  assert.equal(await readFile(f.config, "utf8"), '{"marker":"original","models":{"fixture":{"displayName":"Fixture","providerModel":"fixture"}}}\n');
  assert.equal(await readFile(join(f.root, "config/custom-skills/candidate-skill/SKILL.md"), "utf8"), "# Candidate from code release\n");
  assert.equal(await readFile(join(f.root, "config/custom-skills/candidate-skill/references/说明.md"), "utf8"), "Unicode reference\n");
  assert.equal(await readFile(join(f.root, "config/custom-skills/legacy-skill/SKILL.md"), "utf8"), "# Legacy replacement from code release\n");
  assert.equal(await readFile(join(f.root, "config/custom-skills/legacy-skill/.env"), "utf8"), "LEGACY_SECRET=keep-me\n");
  const current = await readFile(join(f.root,"current-compose"),"utf8");
  assert.equal(JSON.parse(await readFile(join(dirname(current),"topology.json"),"utf8")).runtimeCount,4);
  assert.match(result.stdout, /Rollback: bash/);
});

test("all public scripts support help; release preview needs no SSH", () => {
  for (const script of ["release-cloud.sh", "update-cloud-llm.sh", "package-local-agent.sh", "configure-cloud.sh", "install-runtime-control.sh"]) {
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

for (const count of [1, 3, 12]) {
  test(`LLM update uses all ${count} deployed nodes even if desired count differs`, async () => {
    const f = await fixture({ count, desiredCount: 8 });
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const up = (await f.commands()).find(a => a[0] === "compose" && a.includes("up"))!;
    assert.deepEqual(up.slice(up.indexOf("--force-recreate") + 1), Array.from({length: count}, (_, i) => `runtime-general-${String(i+1).padStart(2,"0")}`));
  });
}

for (const [from, to] of [[2, 4], [4, 1]]) {
  test(`topology change ${from} -> ${to} renders services/catalog and retains volumes`, async () => {
    const f = await fixture({count: from});
    const result = f.run("topology", [String(to), "8"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const commands = await f.commands();
    const up = commands.find(a => a[0] === "compose" && a.includes("up"))!;
    assert.ok(up.includes("--no-build") && up.includes("--remove-orphans"));
    assert.equal(commands.some(a => a[0] === "buildx" || a.includes("down") || a.includes("-v")), false);
    const path = up[up.indexOf("-f")+1];
    const catalog = JSON.parse(await readFile(join(dirname(path), "runtimes.json"), "utf8"));
    assert.equal(catalog.runtimes.length, to);
    assert.ok(catalog.runtimes.every((r: {maxConcurrentRuns: number}) => r.maxConcurrentRuns === 8));
    assert.match(await readFile(join(f.root,".env"),"utf8"), new RegExp(`RUNTIME_COUNT=${to}\\n`));
    for (let i = 1; i <= to; i++) assert.ok(commands.some(a => a[0] === "exec" && a.includes(`agentloop-runtime-general-${String(i).padStart(2,"0")}-1`) && a.some(v => v.includes("Container readiness timed out"))));
  });
}

test("failed resize restores previous topology and active count after desired .env edit", async () => {
  const f = await fixture({count: 2, desiredCount: 5, failReady: true});
  const result = f.run("topology");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Restoring backup/);
  assert.equal(await readFile(join(f.root,"current-compose"),"utf8"), f.compose);
  assert.match(await readFile(join(f.root,".env"),"utf8"), /RUNTIME_COUNT=2\n/);
  const ups = (await f.commands()).filter(a => a[0] === "compose" && a.includes("up"));
  assert.equal(ups.length, 2);
  assert.ok(ups[1].includes("--remove-orphans"));
});

test("active Runs and invalid counts leave topology untouched", async () => {
  for (const options of [{active:true}, {}]) {
    const f = await fixture(options);
    const result = f.run("topology", [options.active ? "4" : "0"]);
    assert.notEqual(result.status, 0);
    assert.equal((await f.commands()).some(a => a.includes("up")), false);
    assert.match(await readFile(join(f.root,".env"),"utf8"), /RUNTIME_COUNT=2\n/);
  }
});

test("subsequent resize uses the generated deployment's original release templates", async () => {
  const f = await fixture();
  let result = f.run("topology", ["3"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = f.run("topology", ["1"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const path = await readFile(join(f.root,"current-compose"),"utf8");
  const manifest = JSON.parse(await readFile(join(dirname(path),"topology.json"),"utf8"));
  assert.equal(manifest.runtimeCount, 1);
  assert.equal(manifest.templateDirectory, await realpath(dirname(f.compose)));
});


test("cloud failure restores old image and actual topology count", async () => {
  const f = await fixture({desiredCount: 4, failReady: true});
  const {sha,digest} = await cloudArchive(f);
  const result = f.run("cloud",[sha,digest]);
  assert.notEqual(result.status,0);
  assert.equal(await readFile(join(f.root,"current-compose"),"utf8"),f.compose);
  const env = await readFile(join(f.root,".env"),"utf8");
  assert.match(env,/RUNTIME_COUNT=2\n/);
  assert.match(env,/MULTI_RUNTIME_IMAGE=agentloop-multi-runtime:old\n/);
  assert.equal(await readFile(join(f.root, "config/custom-skills/legacy-skill/SKILL.md"), "utf8"), "# Legacy\n");
  await assert.rejects(() => readFile(join(f.root, "config/custom-skills/candidate-skill/SKILL.md")));
});

test("code release after resize finds serving release build manifest", async () => {
  const f = await fixture();
  let result = f.run("topology",["3"]);
  assert.equal(result.status,0,result.stdout+result.stderr);
  const {sha,digest} = await cloudArchive(f);
  result = f.run("cloud",[sha,digest]);
  assert.equal(result.status,0,result.stdout+result.stderr);
  const current = await readFile(join(f.root,"current-compose"),"utf8");
  assert.equal(JSON.parse(await readFile(join(dirname(current),"topology.json"),"utf8")).runtimeCount,3);
});


test("deploy.sh up applies configured count through production lifecycle; health reads active topology", async () => {
  const f = await fixture({desiredCount: 3});
  const launcher = join(scripts,"../centos7/deploy.sh");
  let result = spawnSync("bash",[launcher,"up"],{env:f.environment,encoding:"utf8"});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/Runtime count: 3/);
  const current = await readFile(join(f.root,"current-compose"),"utf8");
  const env = await readFile(join(f.root,".env"),"utf8");
  await writeFile(join(f.root,".env"),env.replace("RUNTIME_COUNT=3","RUNTIME_COUNT=invalid-desired"));
  result = spawnSync("bash",[launcher,"health"],{env:f.environment,encoding:"utf8"});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(await readFile(join(f.root,"current-compose"),"utf8"),current);
});
