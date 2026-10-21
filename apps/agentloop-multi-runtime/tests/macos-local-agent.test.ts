import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("macOS tray preserves release Web origin and installs LaunchAgent for the current user", { skip: process.platform !== "darwin" }, async () => {
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
  precondition((plist["ProgramArguments"] as! [String])[0] == root.appendingPathComponent("agentloop-local-runtime-agent").path)
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

test("macOS PKG includes an upgrade cleanup script without deleting runtime state", async () => {
  const [preinstall, postinstall] = await Promise.all([
    readFile(new URL("../distribution/macos/scripts/preinstall", import.meta.url), "utf8"),
    readFile(new URL("../distribution/macos/scripts/postinstall", import.meta.url), "utf8"),
  ]);
  assert.match(preinstall, /launchctl bootout/);
  assert.match(preinstall, /\$\{1:-\/\}/);
  assert.match(preinstall, /launchctl print/);
  assert.match(preinstall, /pkill -TERM -u .* -f/);
  assert.match(preinstall, /pgrep -u .* -f/);
  assert.match(preinstall, /AgentLoop Local Runtime is still running/);
  assert.match(preinstall, /exit 1/);
  assert.match(preinstall, /agentloop-local-runtime-agent/);
  assert.match(preinstall, /\\\.mjs/);
  assert.match(preinstall, /Contents\/MacOS\/AgentLoop Local Runtime/);
  assert.match(postinstall, /LaunchAgents/);
  assert.match(postinstall, /\$\{1:-\/\}/);
  assert.match(postinstall, /rm -f/);
  assert.match(postinstall, /launchctl asuser/);
  assert.match(postinstall, /sudo -u/);
  assert.match(postinstall, /set -eu/);
  assert.match(postinstall, /open -a/);
  assert.doesNotMatch(postinstall, /Application Support\/AgentLoop Local Runtime.*rm|rm .*Application Support\/AgentLoop Local Runtime/);
  const packager = await readFile(new URL("../scripts/package-local-agent-macos.mjs", import.meta.url), "utf8");
  assert.match(packager, /["']--scripts["']/);
  assert.match(packager, /distribution\/macos\/scripts/);
  assert.equal(execFileSync("/bin/sh", [new URL("../distribution/macos/scripts/preinstall", import.meta.url).pathname, "/Volumes/Other", "unused", "unused"], { encoding: "utf8" }), "");
  assert.equal(execFileSync("/bin/sh", [new URL("../distribution/macos/scripts/postinstall", import.meta.url).pathname, "/Volumes/Other", "unused", "unused"], { encoding: "utf8" }), "");
});
