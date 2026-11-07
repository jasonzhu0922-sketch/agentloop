import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import test from "node:test";
import { ComputerExecutor } from "../src/computer/computer-executor.ts";
import { sandboxCommand } from "../src/computer/command-sandbox.ts";

test("required command sandbox blocks sibling reads/writes and children while retaining workspace output", { skip: process.platform !== "darwin" }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentloop-os-sandbox-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alice = join(root, "alice"), bob = join(root, "bob"), skill = join(root, "skill");
  await mkdir(alice); await mkdir(bob); await mkdir(skill);
  await writeFile(join(bob, "private.txt"), "bob-private");
  await writeFile(join(skill, "reference.txt"), "trusted-reference");
  let accepted = false;
  const server = createServer(socket => { accepted = true; socket.end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await symlink(join(bob, "private.txt"), join(alice, "outside-link"));
  const script = `const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const sibling = path.join(process.cwd(), '..', 'bob', 'private.txt');
const denied = fn => { try { fn(); return false; } catch { return true; } };
const child = cp.spawnSync(process.execPath, ['-e', 'require("node:fs").readFileSync(process.argv[1])', sibling], { encoding: 'utf8' });
const result = { readDenied: denied(() => fs.readFileSync(sibling)), writeDenied: denied(() => fs.writeFileSync(sibling, 'changed')),
  linkDenied: denied(() => fs.readFileSync('outside-link')), childDenied: child.status !== 0,
  reference: fs.readFileSync(${JSON.stringify(join(skill, "reference.txt"))}, 'utf8'),
  referenceWriteDenied: denied(() => fs.writeFileSync(${JSON.stringify(join(skill, "reference.txt"))}, 'changed')) };
fs.writeFileSync('report.html', '<html><body>isolated</body></html>');
const socket = require('node:net').connect(${address.port}, '127.0.0.1');
socket.on('connect', () => { result.networkConnected = true; socket.end(); });
socket.on('error', error => { result.networkError = error.code; });
socket.on('close', () => console.log(JSON.stringify(result)));`;
  await writeFile(join(alice, "build.cjs"), script);
  const executor = new ComputerExecutor(alice, { commandSandbox: { mode: "required" },
    executableAliases: { sandboxnode: process.execPath }, commandRoots: [{ id: "@skills/reference", path: skill }] });
  const result = await executor.withWorkspaceRoot(alice).runCommand({ command: "sandboxnode", args: ["build.cjs"], cwd: ".", timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { readDenied: true, writeDenied: true, linkDenied: true, childDenied: true,
    reference: "trusted-reference", referenceWriteDenied: true, networkConnected: true });
  assert.equal(accepted, true);
  assert.equal(await readFile(join(bob, "private.txt"), "utf8"), "bob-private");
  assert.match(await readFile(join(alice, "report.html"), "utf8"), /isolated/);
  assert.equal(result.executionReceipt.effectScope, "unbounded");
  const search = new ComputerExecutor(alice, { commandSandbox: { mode: "required" }, executableAliases: { grep: "/usr/bin/grep" } });
  assert.deepEqual(await search.searchText(".", "bob-private"), [], "trusted search cannot follow a sibling symlink either");
});

test("sandboxed Python resolves a configured DNS name", { skip: process.platform !== "darwin" || !process.env.AGENTLOOP_TEST_DNS_NAME }, async t => {
  const python = await realpath(process.env.RUNTIME_PYTHON ?? "/opt/homebrew/bin/python3");
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentloop-dns-sandbox-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executor = new ComputerExecutor(root, { commandSandbox: { mode: "required", readOnlyRoots: [join(python, "..", "..")] },
    executableAliases: { sandboxpython: python } });
  const result = await executor.runCommand({ command: "sandboxpython", args: ["-c", "import socket,sys; print(socket.getaddrinfo(sys.argv[1], 443, type=socket.SOCK_STREAM)[0][4][0])", process.env.AGENTLOOP_TEST_DNS_NAME!], cwd: ".", timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(result.stdout.trim());
});

test("sandboxed Python verifies HTTPS using its normal CA bundle", { skip: process.platform !== "darwin" || !process.env.AGENTLOOP_TEST_HTTPS_URL }, async t => {
  const python = await realpath(process.env.RUNTIME_PYTHON ?? "/opt/homebrew/bin/python3");
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentloop-tls-sandbox-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executor = new ComputerExecutor(root, { commandSandbox: { mode: "required", readOnlyRoots: [join(python, "..", "..")] },
    executableAliases: { sandboxpython: python } });
  const script = "import sys,urllib.request,urllib.error\ntry:\n print(urllib.request.urlopen(sys.argv[1], timeout=8).status)\nexcept urllib.error.HTTPError as e:\n print(e.code)";
  const result = await executor.runCommand({ command: "sandboxpython", args: ["-c", script, process.env.AGENTLOOP_TEST_HTTPS_URL!], cwd: ".", timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d{3}$/);
});

test("sandboxed Python can run from a read-only Skill and generate files in its workspace", { skip: process.platform !== "darwin" }, async t => {
  const python = process.env.RUNTIME_PYTHON ?? "/opt/homebrew/bin/python3";
  let executable: string;
  try { executable = await realpath(python); } catch { t.skip("Python is not installed on this host"); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentloop python sandbox-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), skill = join(root, "skill");
  await mkdir(workspace); await mkdir(skill);
  await writeFile(join(workspace, "request.json"), '{"query":"test"}');
  await writeFile(join(skill, "build.py"), `import json, os, pathlib, sys, tempfile, zipfile\nassert sys.argv[1] == '--request'\nassert json.loads(pathlib.Path(sys.argv[2]).read_text())['query'] == 'test'\nroot = pathlib.Path(os.environ['AGENTLOOP_WORKSPACE_ROOT'])\n(root / 'python.html').write_text('<html>Python output</html>')\nwith tempfile.TemporaryDirectory() as temporary:\n    pathlib.Path(temporary, 'working.txt').write_text('temporary')\nwith zipfile.ZipFile(root / 'output.zip', 'w') as archive:\n    archive.writestr('output.txt', 'generated')\nprint('generated')\n`);
  const executor = new ComputerExecutor(workspace, { commandSandbox: { mode: "required", readOnlyRoots: [join(executable, "..", "..")] },
    commandEnvironment: { PYTHONNOUSERSITE: "1" }, executableAliases: { sandboxpython: executable },
    commandRoots: [{ id: "@skills/reference", path: skill }] });
  const result = await executor.runCommand({ command: "sandboxpython", args: ["build.py", "--request", "@workspace/request.json"], cwd: "@skills/reference", timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(await readFile(join(workspace, "python.html"), "utf8"), /Python output/);
  assert.ok((await readFile(join(workspace, "output.zip"))).byteLength > 0);
});

test("unsupported command sandbox fails before spawning instead of running unconfined", async () => {
  await assert.rejects(sandboxCommand({ command: "node", args: [], workspaceRoot: "/", readOnlyRoots: [],
    policy: { mode: "required" }, platform: "win32" }), /command_sandbox_unavailable/);
});
