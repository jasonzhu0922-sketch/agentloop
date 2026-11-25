import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerExecutor } from "../src/computer/computer-executor.ts";

test("host commands retain Run scope, preflight, file changes and complete output evidence", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "host-command-"));
  try {
    await fs.mkdir(join(root, "run")); const scoped = await fs.realpath(join(root, "run"));
    let calls = 0;
    const executor = new ComputerExecutor(root, { commandRunner: async request => {
      calls++;
      assert.equal(request.environment.AGENTLOOP_RUN_ID, "run-1");
      assert.equal(request.environment.AGENTLOOP_WORKSPACE_ROOT, scoped);
      assert.equal(request.args[0], join(scoped, "output.txt"));
      await fs.writeFile(request.args[0]!, "created");
      return { stdout: "x".repeat(6000), stderr: "", exitCode: 0, signal: null };
    } }).withWorkspaceRoot(scoped, { fileRevisionScope: "run-1" });
    const result = await executor.runCommand({ command: "host", args: ["@workspace/output.txt"], cwd: ".", timeoutMs: 1000 });
    assert.equal(calls, 1);
    assert.equal(result.stdout.length, 6000);
    assert.equal(result.fileChanges.length, 1);
    assert.ok(result.stdoutRef);
    assert.equal(result.executionReceipt.startState, "started");
    await assert.rejects(executor.runCommand({ command: "host", args: ["../escape.txt"], cwd: ".", timeoutMs: 1000 }));
    assert.equal(calls, 1, "Preflight rejects the escape before the host callback");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("host refusal selects native spawn; an accepted failure is never replayed", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "host-no-replay-"));
  try {
    let calls = 0;
    const executor = new ComputerExecutor(root, { executableAliases: { node: process.execPath }, commandRunner: request => {
      calls++;
      return request.command === "node" ? undefined : Promise.reject(new Error("transport stopped after dispatch"));
    } });
    const result = await executor.runCommand({ command: "node", args: ["-e", "process.stdout.write('native')"], cwd: ".", timeoutMs: 5000 });
    assert.equal(result.stdout, "native");
    await assert.rejects(executor.runCommand({ command: "accepted-host", args: [], cwd: ".", timeoutMs: 1000 }), /transport stopped/);
    assert.equal(calls, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
