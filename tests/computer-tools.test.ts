import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCommandEnvironment, ComputerExecutor, parseGrepLine, parseRgJsonLine } from "../src/computer/computer-executor.ts";
import { createComputerTools } from "../src/computer/computer-tools.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ToolRegistry } from "../src/runtime/tool-registry.ts";

test("computer paths cannot escape the workspace lexically or through a symbolic link", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-computer-"));
  const outside = await fs.mkdtemp(join(tmpdir(), "agentloop-outside-"));
  try {
    await fs.writeFile(join(outside, "secret.txt"), "outside");
    await fs.symlink(outside, join(root, "escape"));
    const executor = new ComputerExecutor(root);
    await assert.rejects(() => executor.readFile("../secret.txt"), (error: unknown) => hasCode(error, "FORBIDDEN"));
    await assert.rejects(() => executor.readFile("escape/secret.txt"), (error: unknown) => hasCode(error, "FORBIDDEN"));
    await assert.rejects(() => executor.writeFile("escape/new.txt", "bad", false), (error: unknown) => hasCode(error, "FORBIDDEN"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("dangerous computer tools remain unavailable until the Run grant explicitly includes them", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-grant-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const denied = registry.materialize(grant([]));
    assert.equal(denied.definitions.some((tool) => tool.name === "computer_write_file"), false);
    assert.throws(
      () => denied.prepare({ id: "write-1", name: "computer_write_file", arguments: { path: "x", content: "x" } }),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );
    const allowed = registry.materialize(grant(["computer_write_file"]));
    const prepared = allowed.prepare({
      id: "write-2", name: "computer_write_file", arguments: { path: "created.txt", content: "kept\n" },
    });
    await prepared.tool.execute({ grant: grant(["computer_write_file"]) }, prepared.input);
    assert.equal(await fs.readFile(join(root, "created.txt"), "utf8"), "kept\n");

    const nested = allowed.prepare({
      id: "write-3", name: "computer_write_file", arguments: { path: "deliveries/issue-42/proof.txt", content: "nested\n" },
    });
    await nested.tool.execute({ grant: grant(["computer_write_file"]) }, nested.input);
    assert.equal(await fs.readFile(join(root, "deliveries/issue-42/proof.txt"), "utf8"), "nested\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer command execution uses an enforced timeout instead of an unbounded child process", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-timeout-"));
  try {
    const executor = new ComputerExecutor(root);
    await assert.rejects(
      () => executor.runCommand({
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: ".",
        timeoutMs: 100,
      }),
      (error: unknown) => hasCode(error, "TOOL_EXECUTION_ERROR"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("server-owned executable aliases expose a safe name instead of an arbitrary binary path", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-alias-"));
  try {
    const executor = new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
      commandEnvironment: { DEMO_FLAG: "server-owned" },
    });
    const result = await executor.runCommand({
      command: "trusted-node",
      args: ["-e", "process.stdout.write('alias-ok:' + process.env.DEMO_FLAG)"],
      cwd: ".",
      timeoutMs: 2_000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "alias-ok:server-owned");
    assert.throws(
      () => new ComputerExecutor(root, { executableAliases: { node: "relative/node" } }),
      /absolute path/,
    );
    assert.throws(
      () => new ComputerExecutor(root, { commandEnvironment: { API_KEY: "must-not-leak" } }),
      /must not contain sensitive variable/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer command arguments preserve long absolute paths while remaining bounded", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-long-command-argument-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    })));
    const allowed = registry.materialize(grant(["computer_run_command"]));
    const longAbsolutePath = `/${"nested-directory/".repeat(20)}render_slides.py`;
    assert.ok(longAbsolutePath.length > 128);
    const prepared = allowed.prepare({
      id: "long-argument",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "process.stdout.write(process.argv.slice(1).join('\\n'))", longAbsolutePath, longAbsolutePath],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    const result = await prepared.tool.execute(grantContext(["computer_run_command"]), prepared.input) as {
      exitCode: number | null;
      stdout: string;
    };
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `${longAbsolutePath}\n${longAbsolutePath}`);

    assert.throws(
      () => allowed.prepare({
        id: "oversized-argument",
        name: "computer_run_command",
        arguments: { command: "trusted-node", args: ["x".repeat(4_097)] },
      }),
      (error: unknown) => hasCode(error, "BAD_REQUEST"),
    );
    assert.throws(
      () => allowed.prepare({
        id: "oversized-total",
        name: "computer_run_command",
        arguments: { command: "trusted-node", args: Array.from({ length: 17 }, () => "x".repeat(4_000)) },
      }),
      (error: unknown) => hasCode(error, "BAD_REQUEST"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer command names remain bare executable names", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-name-"));
  try {
    const executor = new ComputerExecutor(root);
    await assert.rejects(
      () => executor.runCommand({ command: process.execPath, args: [], cwd: ".", timeoutMs: 2_000 }),
      (error: unknown) => hasCode(error, "BAD_REQUEST"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_search_text walks recursively and skips .git/node_modules", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-search-"));
  try {
    await fs.writeFile(join(root, "a.txt"), "hello world\nfoo\n");
    await fs.mkdir(join(root, "sub"));
    await fs.writeFile(join(root, "sub", "b.txt"), "hello again\n");
    await fs.mkdir(join(root, "node_modules"));
    await fs.writeFile(join(root, "node_modules", "c.txt"), "hello node\n");
    await fs.mkdir(join(root, ".git"));
    await fs.writeFile(join(root, ".git", "d.txt"), "hello git\n");
    const executor = new ComputerExecutor(root);
    const matches = await executor.searchText(".", "hello");
    assert.deepEqual(matches, [
      { path: "a.txt", line: 1, text: "hello world" },
      { path: "sub/b.txt", line: 1, text: "hello again" },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_search_text searches a single file path", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-search-file-"));
  try {
    await fs.writeFile(join(root, "only.txt"), "line one\nhello there\nline three\n");
    const executor = new ComputerExecutor(root);
    assert.deepEqual(await executor.searchText("only.txt", "hello"), [
      { path: "only.txt", line: 2, text: "hello there" },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_search_text delegates to a trusted grep and matches the JS walk", async () => {
  const grep = await findGrep();
  if (grep === undefined) return;
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-search-grep-"));
  try {
    await fs.writeFile(join(root, "a.txt"), "hello world\nfoo bar\n");
    await fs.mkdir(join(root, "sub"));
    await fs.writeFile(join(root, "sub", "b.txt"), "say hello\n");
    await fs.mkdir(join(root, "node_modules"));
    await fs.writeFile(join(root, "node_modules", "c.txt"), "hello node\n");
    const plain = new ComputerExecutor(root);
    const fast = new ComputerExecutor(root, { executableAliases: { grep } });
    const expected = await plain.searchText(".", "hello");
    const actual = await fast.searchText(".", "hello");
    assert.deepEqual(actual, expected);
    assert.ok(actual.length > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("parseRgJsonLine extracts fields without colon ambiguity", () => {
  const workspaceRoot = "/tmp/ws:root";
  const match = parseRgJsonLine(JSON.stringify({
    type: "match",
    data: {
      path: { text: "/tmp/ws:root/a.txt" },
      lines: { text: "hello: world\n" },
      line_number: 2,
      absolute_offset: 0,
      submatches: [],
    },
  }), workspaceRoot);
  assert.deepEqual(match, { path: "a.txt", line: 2, text: "hello: world" });
});

test("parseGrepLine strips a search root containing ':' before splitting fields", () => {
  const workspaceRoot = "/tmp";
  const searchRoot = "/tmp/ws:root";
  const match = parseGrepLine("/tmp/ws:root/a.txt:3:hello", searchRoot, workspaceRoot);
  assert.deepEqual(match, { path: "ws:root/a.txt", line: 3, text: "hello" });
});

test("buildCommandEnvironment is platform-aware and lets server env override", () => {
  const env = buildCommandEnvironment({});
  assert.equal(typeof env.PATH, "string");
  assert.equal(env.LANG, process.env.LANG ?? "C.UTF-8");
  assert.equal(env.LC_ALL, process.env.LC_ALL ?? "C.UTF-8");
  assert.ok(env.TMPDIR);
  assert.equal("TEMP" in env, false);
  assert.equal("SystemRoot" in env, false);
  const overridden = buildCommandEnvironment({ DEMO_FLAG: "x", PATH: "/custom" });
  assert.equal(overridden.DEMO_FLAG, "x");
  assert.equal(overridden.PATH, "/custom");
});

async function findGrep(): Promise<string | undefined> {
  for (const candidate of ["/usr/bin/grep", "/bin/grep", "/usr/local/bin/grep"]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return undefined;
}

function grant(toolNames: readonly string[]) {
  return createCapabilityGrant({
    actorUserId: "user", runId: "run", agentId: "agent", depth: 0,
    allowedToolNames: toolNames, allowedSkillIds: [], allowedChildAgentIds: [],
  });
}

function grantContext(toolNames: readonly string[]) {
  return { grant: grant(toolNames) };
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code: unknown }).code === code;
}
