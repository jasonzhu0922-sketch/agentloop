import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("macOS launcher preserves release Web origin and installs LaunchAgent for the current user", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-macos-installation-"));
  try {
    const harness = join(root, "main.swift");
    await writeFile(harness, `import Foundation
let root = URL(fileURLWithPath: CommandLine.arguments[1])
let resources = URL(fileURLWithPath: CommandLine.arguments[2])
let manifest = root.appendingPathComponent("agentloop-local-runtime.manifest.json")
try FileManager.default.copyItem(at: resources.appendingPathComponent("com.agentloop.local-runtime-agent.plist"), to: root.appendingPathComponent("com.agentloop.local-runtime-agent.plist"))
for origin in ["http://203.0.113.7:3001", "https://web.example.test"] {
  try JSONSerialization.data(withJSONObject: ["webOrigin": origin]).write(to: manifest)
  let actual = try LocalRuntimeInstallation.webURL(resources: root).absoluteString
  precondition(actual == origin)
}
for invalid in ["file:///tmp/wrong", "not-a-url"] {
  try JSONSerialization.data(withJSONObject: ["webOrigin": invalid]).write(to: manifest)
  do { _ = try LocalRuntimeInstallation.webURL(resources: root); fatalError("invalid origin accepted") } catch {}
}
for name in ["First Installer", "Other User & Device"] {
  let home = root.appendingPathComponent(name)
  let target = try LocalRuntimeInstallation.launchAgentPath(resources: root, home: home, label: "com.agentloop.local-runtime-agent")
  let plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: target), format: nil) as! [String: Any]
  let logs = home.appendingPathComponent("Library/Application Support/AgentLoop Local Runtime/logs")
  precondition(plist["StandardOutPath"] as? String == logs.appendingPathComponent("agent.out.log").path)
  precondition(plist["StandardErrorPath"] as? String == logs.appendingPathComponent("agent.err.log").path)
  precondition(FileManager.default.fileExists(atPath: logs.path))
  precondition((plist["ProgramArguments"] as! [String])[0] == root.appendingPathComponent("agentloop-local-runtime-launcher").path)
  try Data("stale previous installation".utf8).write(to: target)
  _ = try LocalRuntimeInstallation.launchAgentPath(resources: root, home: home, label: "com.agentloop.local-runtime-agent")
  _ = try PropertyListSerialization.propertyList(from: Data(contentsOf: target), format: nil)
}
print("release origin and per-user LaunchAgent verified")
`);
    const source = fileURLToPath(new URL("../distribution/macos/LocalRuntimeInstallation.swift", import.meta.url));
    const resources = fileURLToPath(new URL("../distribution/macos", import.meta.url));
    const executable = join(root, "verify");
    execFileSync("/usr/bin/swiftc", ["-module-cache-path", join(root, "modules"), source, harness, "-o", executable], { stdio: "pipe" });
    assert.match(execFileSync(executable, [root, resources], { encoding: "utf8" }), /release origin and per-user LaunchAgent verified/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS service shutdown unloads the KeepAlive LaunchAgent before quitting", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-macos-shutdown-"));
  try {
    const statePath = join(root, "state.json");
    await writeFile(statePath, JSON.stringify({ loaded: true, calls: [] }));
    const launchctl = join(root, "launchctl");
    await writeFile(launchctl, `#!${process.execPath}
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath));
const command = process.argv[2];
state.calls.push([command, ...process.argv.slice(3)]);
let status = 0;
if (command === "print") status = state.loaded ? 0 : 1;
if (command === "bootout") state.loaded = false;
fs.writeFileSync(statePath, JSON.stringify(state));
process.exit(status);
`);
    await chmod(launchctl, 0o755);
    const harness = join(root, "main.swift");
    await writeFile(harness, `import Foundation
let launchctl = URL(fileURLWithPath: CommandLine.arguments[1])
try LocalRuntimeInstallation.stopAgent(label: "com.agentloop.local-runtime-agent", uid: 501, launchctl: launchctl)
print("LaunchAgent unloaded before tray quit")
`);
    const source = fileURLToPath(new URL("../distribution/macos/LocalRuntimeInstallation.swift", import.meta.url));
    const executable = join(root, "verify");
    execFileSync("/usr/bin/swiftc", ["-module-cache-path", join(root, "modules"), source, harness, "-o", executable], { stdio: "pipe" });
    assert.match(execFileSync(executable, [launchctl], { encoding: "utf8" }), /LaunchAgent unloaded before tray quit/);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.loaded, false);
    assert.deepEqual(state.calls.map((call: string[]) => call[0]), ["print", "bootout", "print"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS Agent restart reuses a loaded LaunchAgent instead of bootstrapping it again", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-macos-restart-"));
  try {
    const statePath = join(root, "state.json");
    await writeFile(statePath, JSON.stringify({ loaded: true, calls: [] }));
    const launchctl = join(root, "launchctl");
    await writeFile(launchctl, `#!${process.execPath}
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath));
const command = process.argv[2];
state.calls.push([command, ...process.argv.slice(3)]);
let status = 0;
if (command === "print") status = state.loaded ? 0 : 1;
if (command === "bootstrap") state.loaded = true;
fs.writeFileSync(statePath, JSON.stringify(state));
process.exit(status);
`);
    await chmod(launchctl, 0o755);
    const harness = join(root, "main.swift");
    await writeFile(harness, `import Foundation
let launchctl = URL(fileURLWithPath: CommandLine.arguments[1])
try LocalRuntimeInstallation.restartAgent(plist: URL(fileURLWithPath: "/tmp/agent.plist"), label: "com.agentloop.local-runtime-agent", uid: 501, launchctl: launchctl)
print("LaunchAgent restarted")
`);
    const source = fileURLToPath(new URL("../distribution/macos/LocalRuntimeInstallation.swift", import.meta.url));
    const executable = join(root, "verify");
    execFileSync("/usr/bin/swiftc", ["-module-cache-path", join(root, "modules"), source, harness, "-o", executable], { stdio: "pipe" });
    assert.match(execFileSync(executable, [launchctl], { encoding: "utf8" }), /LaunchAgent restarted/);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(state.calls.map((call: string[]) => call[0]), ["print", "kickstart"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS PKG includes an upgrade cleanup script without deleting runtime state", async () => {
  const [preinstall, postinstall, launcher] = await Promise.all([
    readFile(new URL("../distribution/macos/scripts/preinstall", import.meta.url), "utf8"),
    readFile(new URL("../distribution/macos/scripts/postinstall", import.meta.url), "utf8"),
    readFile(new URL("../distribution/macos/AgentLoopLocalRuntimeTray.swift", import.meta.url), "utf8"),
  ]);
  assert.match(preinstall, /launchctl bootout/);
  assert.match(preinstall, /\$\{3:-\/\}/);
  assert.match(preinstall, /launchctl print/);
  assert.match(preinstall, /for signal in TERM KILL/);
  assert.match(preinstall, /pgrep -f/);
  assert.match(preinstall, /Unable to terminate the old AgentLoop Local Runtime/);
  assert.match(preinstall, /exit 1/);
  const agentPattern = new RegExp(preinstall.match(/readonly AGENT_PATTERN='([^']+)'/)![1]!);
  for (const command of [
    "/Applications/AgentLoop Local Runtime.app/Contents/Resources/agentloop-local-runtime-agent",
    "/Applications/AgentLoop Local Runtime.app/Contents/Resources/agentloop-local-runtime-node /Applications/AgentLoop Local Runtime.app/Contents/Resources/agentloop-local-runtime-agent.mjs",
  ]) assert.ok(agentPattern.test(command), command);
  assert.equal(agentPattern.test("/tmp/other/agentloop-local-runtime-agent"), false);
  assert.equal(agentPattern.test("/Applications/AgentLoop Local Runtime.app/Contents/Resources/agentloop-local-runtime-agent-other"), false);
  assert.match(preinstall, /\\\.mjs/);
  assert.match(preinstall, /Contents\/MacOS\/AgentLoop Local Runtime/);
  assert.match(postinstall, /LaunchAgents/);
  assert.match(postinstall, /\$\{3:-\/\}/);
  assert.match(postinstall, /rm -f/);
  assert.match(postinstall, /launchctl asuser/);
  assert.match(postinstall, /sudo -u/);
  assert.match(postinstall, /set -eu/);
  assert.match(postinstall, /open -a/);
  assert.doesNotMatch(postinstall, /Application Support\/AgentLoop Local Runtime.*rm|rm .*Application Support\/AgentLoop Local Runtime/);
  const packager = await readFile(new URL("../scripts/package-local-agent-macos.mjs", import.meta.url), "utf8");
  const plist = await readFile(new URL("../distribution/macos/com.agentloop.local-runtime-agent.plist", import.meta.url), "utf8");
  assert.match(packager, /["']--scripts["']/);
  assert.match(packager, /distribution\/macos\/scripts/);
  assert.match(packager, /AGENTLOOP_PACKAGED_PYTHON_ROOT/);
  assert.match(packager, /runtime-python/);
  assert.match(packager, /preparePackagedPythonRuntime/);
  assert.match(packager, /copyPackagedNodeModules/);
  assert.match(packager, /agentloop-local-runtime-node/);
  assert.match(packager, /use-system-ca/);
  assert.match(packager, /NODE_EXTRA_CA_CERTS/);
  assert.match(packager, /-r \/etc\/ssl\/cert\.pem/);
  assert.match(packager, /export NODE_EXTRA_CA_CERTS=\/etc\/ssl\/cert\.pem/);
  assert.match(packager, /\\\$\{NODE_OPTIONS:-\}/);
  assert.match(packager, /\\\$\{NODE_OPTIONS:\+\$NODE_OPTIONS \}/);
  assert.match(packager, /rotating-log-launcher/);
  assert.match(packager, /nodeModules/);
  assert.match(plist, /NODE_OPTIONS/);
  assert.match(plist, /--use-system-ca/);
  assert.match(launcher, /setActivationPolicy\(\.accessory\)/);
  assert.match(launcher, /NSStatusItem/);
  assert.match(launcher, /启动或重连/);
  assert.match(launcher, /打开 AgentLoop Web/);
  assert.match(launcher, /查看本地日志/);
  assert.match(launcher, /退出/);
  for (const name of ["preinstall", "postinstall"]) {
    assert.equal(execFileSync("/bin/sh", [new URL(`../distribution/macos/scripts/${name}`, import.meta.url).pathname, "/tmp/AgentLoop.pkg", "/Applications", "/Volumes/Other"], { encoding: "utf8" }), "");
  }
});

test("macOS installer stops legacy processes across sessions, escalates to KILL, and preserves device data", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-pkg-upgrade-"));
  try {
    const home = join(root, "user");
    const plist = join(home, "Library/LaunchAgents/com.agentloop.local-runtime-agent.plist");
    const data = join(home, "Library/Application Support/AgentLoop Local Runtime");
    await mkdir(data, { recursive: true });
    await mkdir(join(home, "Library/LaunchAgents"), { recursive: true });
    await writeFile(plist, "obsolete service");
    const sentinels = ["agentloop.db", "supervisor.db", "models.json", "mcp.json", "device-identity.json", "runtime-secrets"];
    for (const name of sentinels) await writeFile(join(data, name), `preserved ${name}`);
    const statePath = join(root, "state.json");
    const initial = { loaded: { "501": true, "502": true }, agent: true, tray: true, stubborn: true, home, calls: [] };
    const shim = join(root, "command");
    await writeFile(shim, `#!${process.execPath}
const fs = require('node:fs');
const command = process.argv[2], args = process.argv.slice(3);
const file = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(file));
state.calls.push([command, ...args]);
let status = 0;
if (command === 'ps') console.log('501\\n502');
if (command === 'stat') console.log('fixture-user');
if (command === 'id') console.log('501');
if (command === 'dscl') console.log('NFSHomeDirectory: ' + state.home);
if (command === 'launchctl') {
  const uid = args[1]?.split('/')[1];
  if (args[0] === 'print') status = state.loaded[uid] ? 0 : 1;
  if (args[0] === 'bootout' && !state.failBootout) state.loaded[uid] = false;
  if (args[0] === 'asuser') {
    status = state.failOpen ? 1 : 0;
    if (!status && !state.failRegister) state.loaded['501'] = true;
  }
}
if (command === 'pkill' || command === 'pgrep') {
  const target = args.at(-1).includes('Contents/MacOS') ? 'tray' : 'agent';
  if (command === 'pgrep') status = state[target] ? 0 : 1;
  else if (!state.unstoppable && (!state.stubborn || args[0] === '-KILL')) state[target] = false;
}
fs.writeFileSync(file, JSON.stringify(state));
process.exit(status);
`);
    await chmod(shim, 0o755);
    const scripts: Record<string, string> = {};
    for (const name of ["preinstall", "postinstall"]) {
      const source = await readFile(new URL(`../distribution/macos/scripts/${name}`, import.meta.url), "utf8");
      scripts[name] = join(root, name);
      await writeFile(scripts[name]!, source.replace(/\/(?:usr\/bin|bin)\/(ps|stat|id|dscl|launchctl|pkill|pgrep|sleep)\b/g, (_, command) => `"${shim}" ${command}`));
    }
    const run = (name: string) => spawnSync("/bin/sh", [scripts[name]!, "/tmp/AgentLoop.pkg", "/Applications", "/"], { encoding: "utf8" });
    const state = async () => JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(statePath, JSON.stringify(initial));
    assert.equal(run("preinstall").status, 0);
    let actual = await state();
    assert.deepEqual(actual.loaded, { "501": false, "502": false });
    assert.equal(actual.agent, false);
    assert.equal(actual.tray, false);
    assert.ok(actual.calls.some((call: string[]) => call[0] === "pkill" && call[1] === "-KILL"));
    assert.equal(run("postinstall").status, 0);
    actual = await state();
    assert.equal(actual.loaded["501"], true);
    await assert.rejects(readFile(plist), { code: "ENOENT" });
    for (const name of sentinels) assert.equal(await readFile(join(data, name), "utf8"), `preserved ${name}`);

    for (const failure of ["failBootout", "unstoppable"]) {
      await writeFile(statePath, JSON.stringify({ ...initial, [failure]: true }));
      assert.equal(run("preinstall").status, 1, failure);
    }
    for (const failure of ["failOpen", "failRegister"]) {
      await writeFile(statePath, JSON.stringify({ ...initial, loaded: {}, [failure]: true }));
      assert.equal(run("postinstall").status, 1, failure);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
