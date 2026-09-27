import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(appRoot, "../..");
const version = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")).version;
const releaseRoot = resolve(appRoot, "release/local-agent/macos-arm64");
const stagingRoot = join(releaseRoot, "staging");
const application = join(stagingRoot, "Applications", "AgentLoop Local Runtime.app");
const contents = join(application, "Contents");
const macOS = join(contents, "MacOS");
const resources = join(contents, "Resources");
const swiftModuleCache = join(releaseRoot, "swift-module-cache");
const bundle = join(releaseRoot, "agentloop-local-runtime-agent.mjs");
const seaBundle = join(releaseRoot, "agentloop-local-runtime-agent-sea.cjs");
const seaConfig = join(releaseRoot, "sea-config.json");
const seaBlob = join(releaseRoot, "sea-prep.blob");
const executable = join(resources, "agentloop-local-runtime-agent");
const pkg = join(releaseRoot, `AgentLoop-Local-Runtime-${version}-macos-arm64.pkg`);
const releaseEnvironment = process.env.AGENTLOOP_RELEASE_ENV ?? "development";
const routerUrl = process.env.AGENTLOOP_ROUTER_URL ?? ({
  development: "http://127.0.0.1:8788",
  test: process.env.AGENTLOOP_ROUTER_URL_TEST,
  production: process.env.AGENTLOOP_ROUTER_URL_PRODUCTION,
}[releaseEnvironment]);
const webOrigin = process.env.AGENTLOOP_WEB_ORIGIN ?? ({
  development: "http://127.0.0.1:5174",
  test: process.env.AGENTLOOP_WEB_ORIGIN_TEST,
  production: process.env.AGENTLOOP_WEB_ORIGIN_PRODUCTION,
}[releaseEnvironment]);
if (typeof routerUrl !== "string" || typeof webOrigin !== "string") throw new Error(`Missing fixed Router/Web URL for release environment: ${releaseEnvironment}`);

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("package-local-agent-macos must run on an Apple Silicon Mac");
await rm(releaseRoot, { recursive: true, force: true });
await mkdir(resources, { recursive: true });
await mkdir(swiftModuleCache, { recursive: true });

await build({
  entryPoints: [join(appRoot, "local-agent-runtime/src/local-agent-main.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node26",
  outfile: bundle,
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __agentloopCreateRequire } from 'node:module';\nconst require = __agentloopCreateRequire(import.meta.url);" },
  sourcemap: false,
  legalComments: "none",
  define: {
    "process.env.AGENTLOOP_BUILD_ROUTER_URL": JSON.stringify(routerUrl),
    "process.env.AGENTLOOP_BUILD_WEB_ORIGIN": JSON.stringify(webOrigin),
  },
});
await build({
  entryPoints: [join(appRoot, "local-agent-runtime/src/local-agent-main.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node26",
  outfile: seaBundle,
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
  legalComments: "none",
  define: {
    "import.meta.url": JSON.stringify("file:///Applications/AgentLoop%20Local%20Runtime.app/Contents/Resources/agentloop-local-runtime-agent"),
    "import.meta.dirname": JSON.stringify("/Applications/AgentLoop Local Runtime.app/Contents/Resources"),
    "process.env.AGENTLOOP_BUILD_ROUTER_URL": JSON.stringify(routerUrl),
    "process.env.AGENTLOOP_BUILD_WEB_ORIGIN": JSON.stringify(webOrigin),
  },
});
await writeFile(seaConfig, JSON.stringify({ main: seaBundle, output: seaBlob }, null, 2));
run(process.execPath, ["--experimental-sea-config", seaConfig]);
await cp(process.execPath, executable);
await chmod(executable, 0o755);
run("/usr/bin/codesign", ["--remove-signature", executable], true);
let seaInjected = true;
try {
  run(join(repositoryRoot, "node_modules/.bin/postject"), [executable, "NODE_SEA_BLOB", seaBlob, "NODE_OPTIONS=--no-addons", "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"]);
} catch (error) {
  seaInjected = false;
  process.stderr.write(`Node executable has no SEA fuse; using bundled Node fallback: ${error instanceof Error ? error.message : String(error)}\n`);
  const nodeRuntime = join(resources, "agentloop-local-runtime-node");
  const runtimeLibDir = join(resources, "lib");
  const agentScript = join(resources, "agentloop-local-runtime-agent.mjs");
  await cp(process.execPath, nodeRuntime);
  await chmod(nodeRuntime, 0o755);
  run("/usr/bin/codesign", ["--remove-signature", nodeRuntime], true);
  await bundleMacRuntimeLibraries(process.execPath, nodeRuntime, runtimeLibDir);
  await cp(bundle, agentScript);
  await writeFile(executable, `#!/bin/sh\nset -eu\nRESOURCE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport AGENTLOOP_AGENT_PACKAGED=1\nexport AGENTLOOP_AGENT_APP_ROOT="$RESOURCE_ROOT"\nexport AGENTLOOP_BUNDLED_SKILL_DIRECTORIES="$RESOURCE_ROOT/skills"\nexec "$RESOURCE_ROOT/agentloop-local-runtime-node" "$RESOURCE_ROOT/agentloop-local-runtime-agent.mjs" "$@"\n`, { mode: 0o755 });
  await chmod(executable, 0o755);
}
await cp(join(repositoryRoot, "packages/agentloop-skills/skills"), join(resources, "skills"), { recursive: true });
await cp(join(appRoot, "local-agent-runtime"), join(resources, "agent-loop-runtime"), { recursive: true });
await cp(join(repositoryRoot, "packages/agentloop/src/assets"), join(contents, "assets"), { recursive: true });
await mkdir(join(resources, "config"), { recursive: true });
await cp(join(appRoot, "config/llm-providers.example.json"), join(resources, "config/llm-providers.json"));
await writeFile(join(resources, "config/skill-directories.json"), JSON.stringify({
  schema: "agentloop.skillDirectories/v1",
  customSkillDirectories: [],
}, null, 2));
await cp(join(appRoot, "config/step-execution-strategy.json"), join(resources, "config/step-execution-strategy.json"));
await cp(join(appRoot, "distribution/macos/com.agentloop.local-runtime-agent.plist"), join(resources, "com.agentloop.local-runtime-agent.plist"));
await mkdir(macOS, { recursive: true });
run("/usr/bin/swiftc", [
  "-parse-as-library",
  "-module-cache-path", swiftModuleCache,
  join(appRoot, "distribution/macos/AgentLoopLocalRuntimeTray.swift"),
  "-framework", "AppKit",
  "-o", join(macOS, "AgentLoop Local Runtime"),
]);
const info = (await readFile(join(appRoot, "distribution/macos/Info.plist"), "utf8")).replaceAll("__VERSION__", version);
await writeFile(join(contents, "Info.plist"), info);
const logRoot = join(process.env.HOME ?? "/Users/Shared", "Library/Application Support/AgentLoop Local Runtime/logs");
const plist = await readFile(join(resources, "com.agentloop.local-runtime-agent.plist"), "utf8");
await writeFile(join(resources, "com.agentloop.local-runtime-agent.plist"), plist.replaceAll("__LOG_ROOT__", logRoot));
await signNestedCode(resources, macOS);
run("/usr/bin/codesign", ["--force", "--sign", process.env.APPLE_CODESIGN_IDENTITY ?? "-", "--options", "runtime", application]);
run("/usr/bin/pkgbuild", ["--root", stagingRoot, "--identifier", "com.agentloop.local-runtime", "--version", version, "--install-location", "/", pkg]);
process.stdout.write(`Built ${pkg} (${seaInjected ? "Node SEA" : "bundled Node fallback"})\n`);

function run(command, args, allowFailure = false) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} failed with ${result.status ?? "signal"}`);
}

async function bundleMacRuntimeLibraries(sourceBinary, packagedBinary, destination) {
  await mkdir(destination, { recursive: true });
  const pending = [{ source: sourceBinary, target: packagedBinary, root: true }];
  const copied = new Map();
  const processed = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    if (processed.has(current.source)) continue;
    processed.add(current.source);
    for (const dependency of macDependencies(current.source)) {
      const source = resolveMacDependency(current.source, dependency);
      if (source === undefined) continue;
      let target = copied.get(source);
      if (target === undefined) {
        target = join(destination, basename(source));
        await cp(source, target);
        await chmod(target, 0o755);
        run("/usr/bin/codesign", ["--remove-signature", target], true);
        run("/usr/bin/install_name_tool", ["-id", `@loader_path/${basename(target)}`, target], true);
        copied.set(source, target);
      }
      const relativeLibrary = current.root ? `@loader_path/lib/${basename(target)}` : `@loader_path/${basename(target)}`;
      run("/usr/bin/install_name_tool", ["-change", dependency, relativeLibrary, current.target], true);
      pending.push({ source, target, root: false });
    }
  }
}

function macDependencies(binary) {
  const result = spawnSync("/usr/bin/otool", ["-L", binary], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split("\n").slice(1).map((line) => line.trim().split(" ")[0]).filter(Boolean);
}

function resolveMacDependency(binary, dependency) {
  if (dependency.startsWith("/System/") || dependency.startsWith("/usr/lib/")) return undefined;
  if (dependency.startsWith("/")) {
    if (!exists(dependency)) throw new Error(`Missing macOS runtime dependency ${dependency} referenced by ${binary}`);
    return realpathSync(dependency);
  }
  if (dependency.startsWith("@rpath/") || dependency.startsWith("@loader_path/") || dependency.startsWith("@executable_path/")) {
    const name = dependency.slice("@rpath/".length);
    const result = spawnSync("/usr/bin/otool", ["-l", binary], { encoding: "utf8" });
    const rpaths = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("path ")).map((line) => line.split(" ")[1]).filter(Boolean);
    const candidates = dependency.startsWith("@rpath/")
      ? rpaths.map((rpath) => resolveMacPath(binary, rpath, name))
      : [resolveMacPath(binary, dependency.slice(0, dependency.lastIndexOf("/")), dependency.slice(dependency.lastIndexOf("/") + 1))];
    for (const candidate of candidates) if (exists(candidate)) return realpathSync(candidate);
    throw new Error(`Unable to resolve macOS runtime dependency ${dependency} referenced by ${binary}`);
  }
  return undefined;
}

function resolveMacPath(binary, prefix, name) {
  const base = dirname(binary);
  const relativePrefix = prefix.replace("@loader_path", ".").replace("@executable_path", ".");
  return resolve(base, relativePrefix, name);
}

function exists(path) {
  return existsSync(path);
}

async function signNestedCode(resourceRoot, macOSRoot) {
  const identity = process.env.APPLE_CODESIGN_IDENTITY ?? "-";
  const entries = spawnSync("/usr/bin/find", [resourceRoot, "-type", "f", "-name", "*.dylib"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  for (const entry of entries) run("/usr/bin/codesign", ["--force", "--sign", identity, entry], true);
  run("/usr/bin/codesign", ["--force", "--sign", identity, join(resourceRoot, "agentloop-local-runtime-node")], true);
  run("/usr/bin/codesign", ["--force", "--sign", identity, "--options", "runtime", join(macOSRoot, "AgentLoop Local Runtime")], true);
}
