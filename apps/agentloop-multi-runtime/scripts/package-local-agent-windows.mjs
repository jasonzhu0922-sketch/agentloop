import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(appRoot, "../..");
const version = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")).version;
const releaseRoot = resolve(appRoot, "release/local-agent/windows-x64");
const stagingRoot = join(releaseRoot, "staging");
const payloadRoot = join(stagingRoot, "AgentLoop Local Runtime");
const resources = join(payloadRoot, "Resources");
const trayOutput = join(releaseRoot, "tray");
const bundle = join(releaseRoot, "agentloop-local-runtime-agent.mjs");
const seaBundle = join(releaseRoot, "agentloop-local-runtime-agent-sea.cjs");
const seaConfig = join(releaseRoot, "sea-config.json");
const seaBlob = join(releaseRoot, "sea-prep.blob");
const seaExecutable = join(resources, "agentloop-local-runtime-agent.exe");
const launcher = join(resources, "agentloop-local-runtime-agent.cmd");
const msi = join(releaseRoot, `AgentLoop-Local-Runtime-${version}-windows-x64.msi`);
const releaseEnvironment = process.env.AGENTLOOP_RELEASE_ENV ?? "development";
const routerUrl = process.env.AGENTLOOP_ROUTER_URL ?? ({
  development: process.env.AGENTLOOP_ROUTER_URL_DEVELOPMENT ?? "http://127.0.0.1:8788",
  test: process.env.AGENTLOOP_ROUTER_URL_TEST,
  production: process.env.AGENTLOOP_ROUTER_URL_PRODUCTION,
}[releaseEnvironment]);
const webOrigin = process.env.AGENTLOOP_WEB_ORIGIN ?? ({
  development: process.env.AGENTLOOP_WEB_ORIGIN_DEVELOPMENT ?? "http://127.0.0.1:5174",
  test: process.env.AGENTLOOP_WEB_ORIGIN_TEST,
  production: process.env.AGENTLOOP_WEB_ORIGIN_PRODUCTION,
}[releaseEnvironment]);
const upgradeCode = process.env.AGENTLOOP_WINDOWS_MSI_UPGRADE_CODE ?? "A0B2C948-5B16-4CB4-9F58-6520892D0A01";
if (typeof routerUrl !== "string" || typeof webOrigin !== "string") throw new Error(`Missing fixed Router/Web URL for release environment: ${releaseEnvironment}`);
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("package-local-agent-windows must run on 64-bit Windows");

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(resources, { recursive: true });

await buildAgentBundles();
await writeFile(seaConfig, JSON.stringify({ main: seaBundle, output: seaBlob }, null, 2));
run(process.execPath, ["--experimental-sea-config", seaConfig]);
let seaInjected = true;
try {
  await cp(process.execPath, seaExecutable);
  run(postjectPath(), [seaExecutable, "NODE_SEA_BLOB", seaBlob, "NODE_OPTIONS=--no-addons", "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"]);
} catch (error) {
  seaInjected = false;
  process.stderr.write(`Node executable has no SEA fuse; using bundled Node fallback: ${error instanceof Error ? error.message : String(error)}\n`);
  await cp(process.execPath, join(resources, "agentloop-local-runtime-node.exe"));
  await cp(bundle, join(resources, "agentloop-local-runtime-agent.mjs"));
}
await writeLauncher(seaInjected);
await copyRuntimePayload();
run("dotnet", ["publish", join(appRoot, "distribution/windows/AgentLoopLocalRuntimeTray.csproj"), "-c", "Release", "-r", "win-x64", "--self-contained", "true", "-p:PublishSingleFile=true", "-p:DebugType=None", "-o", trayOutput]);
await cp(trayOutput, payloadRoot, { recursive: true });
run("wix", ["build", "-arch", "x64", "-d", `PayloadDir=${payloadRoot}`, "-d", `Version=${version}`, "-d", `UpgradeCode=${upgradeCode}`, "-out", msi, join(appRoot, "distribution/windows/AgentLoopLocalRuntime.wxs")]);
process.stdout.write(`Built ${msi} (${seaInjected ? "Node SEA" : "bundled Node fallback"})\n`);

async function buildAgentBundles() {
  const common = {
    entryPoints: [join(appRoot, "local-agent-runtime/src/local-agent-main.ts")],
    bundle: true,
    platform: "node",
    target: "node26",
    sourcemap: false,
    legalComments: "none",
    define: {
      "process.env.AGENTLOOP_BUILD_ROUTER_URL": JSON.stringify(routerUrl),
      "process.env.AGENTLOOP_BUILD_WEB_ORIGIN": JSON.stringify(webOrigin),
    },
  };
  await build({ ...common, format: "esm", outfile: bundle, banner: { js: "#!/usr/bin/env node\nimport { createRequire as __agentloopCreateRequire } from 'node:module';\nconst require = __agentloopCreateRequire(import.meta.url);" } });
  await build({
    ...common,
    format: "cjs",
    outfile: seaBundle,
    banner: { js: "#!/usr/bin/env node" },
    define: {
      ...common.define,
      "import.meta.url": JSON.stringify("file:///C:/Program%20Files/AgentLoop%20Local%20Runtime/Resources/agentloop-local-runtime-agent.exe"),
      "import.meta.dirname": JSON.stringify("C:\\Program Files\\AgentLoop Local Runtime\\Resources"),
    },
  });
}

async function writeLauncher(seaInjected) {
  const invoke = seaInjected
    ? `"%RESOURCE_ROOT%agentloop-local-runtime-agent.exe" %*`
    : `"%RESOURCE_ROOT%agentloop-local-runtime-node.exe" "%RESOURCE_ROOT%agentloop-local-runtime-agent.mjs" %*`;
  await writeFile(launcher, `@echo off\r\nsetlocal\r\nset "RESOURCE_ROOT=%~dp0"\r\nset "LOG_ROOT=%LOCALAPPDATA%\\AgentLoop Local Runtime\\logs"\r\nif not exist "%LOG_ROOT%" mkdir "%LOG_ROOT%"\r\nset "AGENTLOOP_AGENT_PACKAGED=1"\r\nset "AGENTLOOP_AGENT_APP_ROOT=%RESOURCE_ROOT%"\r\nset "AGENTLOOP_BUNDLED_SKILL_DIRECTORIES=%RESOURCE_ROOT%skills"\r\n${invoke} >> "%LOG_ROOT%\\agent.out.log" 2>> "%LOG_ROOT%\\agent.err.log"\r\n`, "utf8");
}

async function copyRuntimePayload() {
  await cp(join(repositoryRoot, "packages/agentloop-skills/skills"), join(resources, "skills"), { recursive: true });
  await cp(join(appRoot, "local-agent-runtime"), join(resources, "agent-loop-runtime"), { recursive: true });
  await cp(join(repositoryRoot, "packages/agentloop/src/assets"), join(payloadRoot, "assets"), { recursive: true });
  await mkdir(join(resources, "config"), { recursive: true });
  await cp(join(appRoot, "config/llm-providers.example.json"), join(resources, "config/llm-providers.json"));
  await writeFile(join(resources, "config/skill-directories.json"), JSON.stringify({ schema: "agentloop.skillDirectories/v1", customSkillDirectories: [] }, null, 2));
  await cp(join(appRoot, "config/step-execution-strategy.json"), join(resources, "config/step-execution-strategy.json"));
  await cp(join(appRoot, "config/practice-profiles.json"), join(resources, "config/practice-profiles.json"));
  await writeFile(join(resources, "agentloop-local-runtime.manifest.json"), `${JSON.stringify({ schema: "agentloop.localRuntimeRelease/v1", routerUrl, webOrigin }, null, 2)}\n`);
}

function postjectPath() {
  const extension = process.platform === "win32" ? ".cmd" : "";
  const path = join(repositoryRoot, "node_modules/.bin", `postject${extension}`);
  if (!existsSync(path)) throw new Error("postject is not installed; run npm install from the repository root");
  return path;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd") });
  if (result.status !== 0) throw new Error(`${command} failed with ${result.status ?? "signal"}`);
}
