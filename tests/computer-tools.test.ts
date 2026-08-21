import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCommandEnvironment, ComputerExecutor, parseGrepLine, parseRgJsonLine } from "../src/computer/computer-executor.ts";
import { createComputerTools } from "../src/computer/computer-tools.ts";
import { createVisibleDirectoryTools } from "../src/computer/visible-directory-tools.ts";
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

test("computer_read_file reports a missing path as actionable NOT_FOUND", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-missing-path-"));
  try {
    const executor = new ComputerExecutor(root);
    await assert.rejects(
      () => executor.readFile("missing.json"),
      (error: unknown) => hasCode(error, "NOT_FOUND")
        && error instanceof Error
        && error.message === "Path not found: missing.json",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_read_file resolves a missing bare filename from a nested evidence file", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-read-basename-"));
  try {
    await fs.mkdir(join(root, "evidence"), { recursive: true });
    await fs.writeFile(join(root, "evidence", "content_distribution.json"), "{\"total\":61}");
    const executor = new ComputerExecutor(root);
    const result = await executor.readFile("content_distribution.json");
    assert.equal(result.content, "{\"total\":61}");
    assert.equal(result.requestedPath, "content_distribution.json");
    assert.equal(result.resolvedPath, "evidence/content_distribution.json");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_read_file prefers ranked evidence paths over lower-priority duplicate basenames", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-read-basename-priority-"));
  try {
    await fs.mkdir(join(root, "archive"), { recursive: true });
    await fs.mkdir(join(root, "evidence"), { recursive: true });
    await fs.writeFile(join(root, "archive", "progress_stats.json"), "{\"source\":\"archive\"}");
    await fs.writeFile(join(root, "evidence", "progress_stats.json"), "{\"source\":\"evidence\"}");
    const executor = new ComputerExecutor(root);
    const result = await executor.readFile("progress_stats.json");
    assert.equal(result.content, "{\"source\":\"evidence\"}");
    assert.equal(result.resolvedPath, "evidence/progress_stats.json");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_read_file reports same-priority duplicate basenames as an explicit conflict", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-read-basename-conflict-"));
  try {
    await fs.mkdir(join(root, "alpha"), { recursive: true });
    await fs.mkdir(join(root, "beta"), { recursive: true });
    await fs.writeFile(join(root, "alpha", "summary.json"), "{\"source\":\"alpha\"}\n");
    await fs.writeFile(join(root, "beta", "summary.json"), "{\"source\":\"beta\"}\n");
    const executor = new ComputerExecutor(root);
    await assert.rejects(
      () => executor.readFile("summary.json"),
      (error: unknown) => hasCode(error, "CONFLICT")
        && error instanceof Error
        && /Multiple files named summary\.json/.test(error.message)
        && Array.isArray((error as { details?: { candidates?: unknown } }).details?.candidates),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
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

test("computer_write_file reports an existing target as an actionable conflict", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-write-conflict-"));
  try {
    const executor = new ComputerExecutor(root);
    await fs.writeFile(join(root, "measure.py"), "original\n");
    await assert.rejects(
      () => executor.writeFile("measure.py", "replacement\n", false),
      (error: unknown) => hasCode(error, "CONFLICT")
        && error instanceof Error
        && error.message === "File already exists; set overwrite=true to replace it",
    );
    assert.equal(await fs.readFile(join(root, "measure.py"), "utf8"), "original\n");
    await executor.writeFile("measure.py", "replacement\n", true);
    assert.equal(await fs.readFile(join(root, "measure.py"), "utf8"), "replacement\n");
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

test("computer_write_file returns bounded write-after-inspection evidence", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-write-inspection-"));
  try {
    const content = [
      "# Report",
      "opening evidence",
      ...Array.from({ length: 90 }, (_, index) => `body line ${index + 1}`),
      "## Source list",
      "- source A",
      "## Final checks",
      "- tail evidence",
    ].join("\n");
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_write_file"]));
    const definition = allowed.definitions.find((tool) => tool.name === "computer_write_file");
    assert.match(definition?.description ?? "", /write-after-inspection evidence/);
    const prepared = allowed.prepare({
      id: "write-report",
      name: "computer_write_file",
      arguments: { path: "reports/summary.md", content },
    });
    await fs.mkdir(join(root, "reports"), { recursive: true });

    const result = await prepared.tool.execute(grantContext(["computer_write_file"]), prepared.input) as {
      path: string;
      bytes: number;
      sha256: string;
      totalLines: number;
      inspection: {
        sha256: string;
        characters: number;
        totalLines: number;
        outline: Array<{ line: number; text: string }>;
        sampleRanges: Array<{ startLine: number; endLine: number; content: string; truncated: boolean }>;
      };
    };

    assert.equal(result.path, "reports/summary.md");
    assert.equal(result.bytes, Buffer.byteLength(content));
    assert.equal(result.sha256, createHash("sha256").update(content).digest("hex"));
    assert.equal(result.inspection.sha256, result.sha256);
    assert.equal(result.totalLines, 96);
    assert.deepEqual(result.inspection.outline, [
      { line: 1, text: "# Report" },
      { line: 93, text: "## Source list" },
      { line: 95, text: "## Final checks" },
    ]);
    assert.equal(result.inspection.sampleRanges.length, 2);
    assert.match(result.inspection.sampleRanges[0].content, /opening evidence/);
    assert.match(result.inspection.sampleRanges[1].content, /tail evidence/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_run_command treats empty cwd as the workspace root", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-empty-cwd-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    })));
    const allowed = registry.materialize(grant(["computer_run_command"]));
    const prepared = allowed.prepare({
      id: "empty-cwd",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "process.stdout.write(process.cwd())"],
        cwd: "",
        timeoutMs: 2_000,
      },
    });
    const result = await prepared.tool.execute(grantContext(["computer_run_command"]), prepared.input) as {
      exitCode: number | null;
      stdout: string;
    };
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, await fs.realpath(root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_run_command stores large stdout as reusable content-addressed evidence", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-output-ref-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    })));
    const allowed = registry.materialize(grant(["computer_run_command"]));
    const definition = allowed.definitions.find((tool) => tool.name === "computer_run_command");
    assert.match(definition?.description ?? "", /stdoutRef\/stderrRef/);
    const prepared = allowed.prepare({
      id: "large-output",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "process.stdout.write('row-data\\n'.repeat(1200))"],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    const result = await prepared.tool.execute(grantContext(["computer_run_command"]), prepared.input) as {
      exitCode: number | null;
      stdout: string;
      stdoutRef?: { path: string; sha256: string; characters: number; bytes: number; previewCharacters: number };
    };
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdoutRef !== undefined);
    assert.equal(result.stdoutRef.characters, "row-data\n".repeat(1200).length);
    assert.ok(result.stdout.length < result.stdoutRef.characters);
    assert.match(result.stdout, /stored as content-addressed evidence/);
    assert.match(result.stdout, new RegExp(result.stdoutRef.sha256));
    assert.equal(await fs.readFile(join(root, result.stdoutRef.path), "utf8"), "row-data\n".repeat(1200));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_run_command reports bounded workspace file changes as structured evidence", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-file-changes-"));
  try {
    await fs.writeFile(join(root, "existing.txt"), "before\n");
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    })));
    const allowed = registry.materialize(grant(["computer_run_command"]));
    const definition = allowed.definitions.find((tool) => tool.name === "computer_run_command");
    assert.match(definition?.description ?? "", /fileChanges/);
    const prepared = allowed.prepare({
      id: "file-change-command",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "fs.writeFileSync('created.json', '{\"ok\":true}\\n');",
            "fs.writeFileSync('existing.txt', 'after\\n');",
          ].join(" "),
        ],
        cwd: ".",
        timeoutMs: 2_000,
      },
    });
    const result = await prepared.tool.execute(grantContext(["computer_run_command"]), prepared.input) as {
      exitCode: number | null;
      fileChanges: Array<{ path: string; changeType: string; bytes?: number }>;
      fileChangesTruncated: boolean;
    };
    assert.equal(result.exitCode, 0);
    assert.equal(result.fileChangesTruncated, false);
    assert.deepEqual(
      result.fileChanges.map((change) => ({ path: change.path, changeType: change.changeType })),
      [
        { path: "created.json", changeType: "created" },
        { path: "existing.txt", changeType: "modified" },
      ],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_run_command accepts the provider-sized timeout and exposes its bounds", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-timeout-bounds-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_run_command"]));
    const definition = allowed.definitions.find((tool) => tool.name === "computer_run_command");
    assert.deepEqual((definition?.inputSchema as { properties: { timeoutMs: unknown } }).properties.timeoutMs, {
      type: "integer", minimum: 100, maximum: 300_000,
    });
    const prepared = allowed.prepare({
      id: "long-timeout",
      name: "computer_run_command",
      arguments: { command: "node", args: ["--version"], timeoutMs: 180_000 },
    });
    assert.equal((prepared.input as { timeoutMs: number }).timeoutMs, 180_000);
    assert.throws(
      () => allowed.prepare({
        id: "too-long-timeout",
        name: "computer_run_command",
        arguments: { command: "node", args: ["--version"], timeoutMs: 300_001 },
      }),
      /timeoutMs must be an integer between 100 and 300000/,
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

test("computer_run_command can use only Runtime-authorized Skill execution roots as cwd", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-skill-root-"));
  const skillRoot = await fs.mkdtemp(join(tmpdir(), "agentloop-command-skill-package-"));
  try {
    await fs.mkdir(join(skillRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      join(skillRoot, "scripts", "probe.mjs"),
      "import { readFileSync } from 'node:fs'; process.stdout.write(readFileSync('SKILL.md', 'utf8'));\n",
    );
    await fs.writeFile(join(skillRoot, "SKILL.md"), "PACKAGE-SCRIPT-OK\n");
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    })));
    const allowed = registry.materialize(skillRootGrant(["computer_run_command"], skillRoot));
    const prepared = allowed.prepare({
      id: "skill-script",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["scripts/probe.mjs"],
        cwd: "@skills/demo-skill",
        timeoutMs: 2_000,
      },
    });
    const result = await prepared.tool.execute({
      grant: skillRootGrant(["computer_run_command"], skillRoot),
    }, prepared.input) as { exitCode: number | null; stdout: string; fileChanges: unknown[] };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "PACKAGE-SCRIPT-OK\n");
    assert.deepEqual(result.fileChanges, []);

    const unbound = allowed.prepare({
      id: "unbound-skill-script",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["scripts/probe.mjs"],
        cwd: "@skills/other-skill",
        timeoutMs: 2_000,
      },
    });
    await assert.rejects(
      () => unbound.tool.execute({ grant: skillRootGrant(["computer_run_command"], skillRoot) }, unbound.input),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(skillRoot, { recursive: true, force: true });
  }
});

test("computer_run_command rejects commands that mutate an authorized Skill execution root", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-command-skill-root-mutation-"));
  const skillRoot = await fs.mkdtemp(join(tmpdir(), "agentloop-command-skill-package-mutation-"));
  try {
    await fs.writeFile(join(skillRoot, "SKILL.md"), "PACKAGE-SCRIPT-OK\n");
    const executor = new ComputerExecutor(root, {
      executableAliases: { "trusted-node": process.execPath },
    });
    await assert.rejects(
      () => executor.runCommand({
        command: "trusted-node",
        args: ["-e", "require('node:fs').writeFileSync('generated.txt', 'bad\\n')"],
        cwd: "@skills/demo-skill",
        timeoutMs: 2_000,
      }),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );

    const registry = new ToolRegistry(createComputerTools(executor));
    const allowed = registry.materialize(skillRootGrant(["computer_run_command"], skillRoot));
    const prepared = allowed.prepare({
      id: "mutating-skill-script",
      name: "computer_run_command",
      arguments: {
        command: "trusted-node",
        args: ["-e", "require('node:fs').writeFileSync('generated.txt', 'bad\\n')"],
        cwd: "@skills/demo-skill",
        timeoutMs: 2_000,
      },
    });
    await assert.rejects(
      () => prepared.tool.execute({
        grant: skillRootGrant(["computer_run_command"], skillRoot),
      }, prepared.input),
      (error: unknown) => hasCode(error, "SKILL_PACKAGE_MUTATED"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(skillRoot, { recursive: true, force: true });
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

test("computer_read_file supports small line windows", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-read-window-"));
  try {
    await fs.writeFile(join(root, "profile.json"), ["one", "two", "three", "four"].join("\n"));
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_read_file"]));
    const definition = allowed.definitions.find((tool) => tool.name === "computer_read_file");
    assert.deepEqual((definition?.inputSchema as { properties: Record<string, unknown> }).properties.offset, {
      type: "integer", minimum: 1,
    });
    const prepared = allowed.prepare({
      id: "read-window",
      name: "computer_read_file",
      arguments: { path: "profile.json", offset: 2, limit: 2 },
    });
    const result = await prepared.tool.execute(grantContext(["computer_read_file"]), prepared.input) as {
      content: string;
      nextOffset?: number;
      truncated: boolean;
    };
    assert.match(result.content, /^two\nthree/);
    assert.equal(result.nextOffset, 4);
    assert.equal(result.truncated, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("read_file schemas reject mixed single-window and range-window arguments", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-read-schema-"));
  try {
    const computerRegistry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const computerAllowed = computerRegistry.materialize(grant(["computer_read_file"]));
    const computerDefinition = computerAllowed.definitions.find((tool) => tool.name === "computer_read_file");
    assertReadFileSchemaForbidsMixedWindows(computerDefinition?.inputSchema);
    assert.throws(
      () => computerAllowed.prepare({
        id: "mixed-computer-read",
        name: "computer_read_file",
        arguments: { path: "profile.json", offset: 1, ranges: [{ offset: 1, limit: 1 }] },
      }),
      (error: unknown) => hasCode(error, "BAD_REQUEST")
        && error instanceof Error
        && /ranges cannot be combined with offset or limit/.test(error.message),
    );

    const visibleRegistry = new ToolRegistry(createVisibleDirectoryTools());
    const visibleAllowed = visibleRegistry.materialize(visibleGrant(["visible_read_file"], root));
    const visibleDefinition = visibleAllowed.definitions.find((tool) => tool.name === "visible_read_file");
    assertReadFileSchemaForbidsMixedWindows(visibleDefinition?.inputSchema);
    assert.throws(
      () => visibleAllowed.prepare({
        id: "mixed-visible-read",
        name: "visible_read_file",
        arguments: { rootId: "visible_dir_1", path: "profile.json", limit: 1, ranges: [{ offset: 1 }] },
      }),
      (error: unknown) => hasCode(error, "BAD_REQUEST")
        && error instanceof Error
        && /ranges cannot be combined with offset or limit/.test(error.message),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_read_file reads line windows beyond the default byte prefix", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-read-late-window-"));
  try {
    const lines = Array.from({ length: 30_050 }, (_, index) =>
      index === 30_020 ? "target: late evidence" : `filler ${index.toString().padStart(5, "0")} ${"x".repeat(20)}`
    );
    await fs.writeFile(join(root, "large.md"), lines.join("\n"));
    const executor = new ComputerExecutor(root);

    const prefix = await executor.readFile("large.md");
    assert.equal(prefix.truncated, true);
    assert.equal(prefix.content.includes("target: late evidence"), false);

    const window = await executor.readFile("large.md", undefined, { offset: 30_020, limit: 3 });
    assert.match(window.content, /target: late evidence/);
    assert.equal(window.offset, 30_020);
    assert.equal(window.limit, 3);
    assert.equal(window.totalLines, 30_050);
    assert.equal(window.nextOffset, 30_023);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_read_file supports multiple evidence ranges in one call", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-read-ranges-"));
  try {
    await fs.writeFile(join(root, "brief.md"), ["one", "two", "three", "four", "five"].join("\n"));
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_read_file"]));
    const prepared = allowed.prepare({
      id: "read-ranges",
      name: "computer_read_file",
      arguments: {
        path: "brief.md",
        ranges: [
          { offset: 2, limit: 1 },
          { offset: 5, limit: 1 },
        ],
      },
    });
    const result = await prepared.tool.execute(grantContext(["computer_read_file"]), prepared.input) as {
      content: string;
      ranges: Array<{ content: string; startLine: number; endLine: number }>;
    };
    assert.match(result.content, /brief\.md lines 2-2/);
    assert.match(result.content, /brief\.md lines 5-5/);
    assert.deepEqual(result.ranges.map((range) => [range.startLine, range.endLine, range.content]), [
      [2, 2, "two"],
      [5, 5, "five"],
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_find_files finds files by glob without dumping directory trees", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-find-files-"));
  try {
    await fs.mkdir(join(root, "reports"), { recursive: true });
    await fs.mkdir(join(root, "node_modules"), { recursive: true });
    await fs.writeFile(join(root, "reports", "scenario.json"), "{}");
    await fs.writeFile(join(root, "reports", "scenario.md"), "# report\n");
    await fs.writeFile(join(root, "node_modules", "ignored.json"), "{}");
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_find_files"]));
    const prepared = allowed.prepare({
      id: "find-json",
      name: "computer_find_files",
      arguments: { pattern: "**/*.json", limit: 10 },
    });
    const result = await prepared.tool.execute(grantContext(["computer_find_files"]), prepared.input) as {
      matches: string[];
      truncated: boolean;
    };
    assert.deepEqual(result.matches, ["reports/scenario.json"]);
    assert.equal(result.truncated, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("computer_find_files treats an empty path as the workspace root", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-find-files-empty-path-"));
  try {
    await fs.mkdir(join(root, "reports"), { recursive: true });
    await fs.writeFile(join(root, "reports", "scenario.json"), "{}");
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_find_files"]));
    const prepared = allowed.prepare({
      id: "find-json-empty-path",
      name: "computer_find_files",
      arguments: { pattern: "**/*.json", path: "", limit: 10 },
    });
    const result = await prepared.tool.execute(grantContext(["computer_find_files"]), prepared.input) as {
      matches: string[];
      truncated: boolean;
    };
    assert.deepEqual(result.matches, ["reports/scenario.json"]);
    assert.equal(result.truncated, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("visible directory tools read only from explicitly granted local directories", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-root-"));
  const outside = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-outside-"));
  try {
    await fs.mkdir(join(root, "materials"), { recursive: true });
    await fs.writeFile(join(root, "materials", "brief.md"), "# Brief\nlocal evidence\n");
    await fs.writeFile(join(outside, "secret.md"), "not granted\n");
    const registry = new ToolRegistry(createVisibleDirectoryTools());
    const allowed = registry.materialize(visibleGrant(["visible_find_files", "visible_read_file"], root));

    const find = allowed.prepare({
      id: "find-visible",
      name: "visible_find_files",
      arguments: { rootId: "visible_dir_1", pattern: "**/brief.md" },
    });
    const found = await find.tool.execute(
      { grant: visibleGrant(["visible_find_files", "visible_read_file"], root) },
      find.input,
    ) as { rootId: string; matches: string[] };
    assert.deepEqual(found, { rootId: "visible_dir_1", matches: ["materials/brief.md"], limit: 1000, truncated: false });

    const read = allowed.prepare({
      id: "read-visible",
      name: "visible_read_file",
      arguments: { rootId: "visible_dir_1", path: "materials/brief.md" },
    });
    const content = await read.tool.execute(
      { grant: visibleGrant(["visible_find_files", "visible_read_file"], root) },
      read.input,
    ) as { content: string; path: string };
    assert.equal(content.path, "materials/brief.md");
    assert.match(content.content, /local evidence/);

    await assert.rejects(
      () => read.tool.execute(
        { grant: visibleGrant(["visible_find_files", "visible_read_file"], root) },
        { rootId: "missing", path: "materials/brief.md" },
      ),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );
    await assert.rejects(
      () => read.tool.execute(
        { grant: visibleGrant(["visible_find_files", "visible_read_file"], root) },
        { rootId: "visible_dir_1", path: "../" + join(outside, "secret.md") },
      ),
      (error: unknown) => hasCode(error, "FORBIDDEN"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
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

test("computer_search_text returns bounded context windows and read ranges", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-search-context-"));
  try {
    await fs.writeFile(join(root, "plan.md"), [
      "# Plan",
      "before",
      "target decision",
      "after",
      "tail",
    ].join("\n"));
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const allowed = registry.materialize(grant(["computer_search_text"]));
    const prepared = allowed.prepare({
      id: "search-context",
      name: "computer_search_text",
      arguments: { path: ".", query: "target", contextBefore: 1, contextAfter: 1, maxMatches: 5 },
    });
    const result = await prepared.tool.execute(grantContext(["computer_search_text"]), prepared.input) as Array<{
      path: string;
      line: number;
      context?: { startLine: number; endLine: number; content: string };
      readRange?: { offset: number; limit?: number };
    }>;
    assert.deepEqual(result, [{
      path: "plan.md",
      line: 3,
      text: "target decision",
      context: { startLine: 2, endLine: 4, content: "before\ntarget decision\nafter" },
      readRange: { offset: 2, limit: 3 },
    }]);
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
  assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
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
    actorUserId: "user", runId: "run", depth: 0,
    allowedToolNames: toolNames, allowedSkillIds: [],
  });
}

function visibleGrant(toolNames: readonly string[], path: string) {
  return createCapabilityGrant({
    actorUserId: "user",
    runId: "run",
    depth: 0,
    visibleDirectories: [{ id: "visible_dir_1", name: "visible", path }],
    allowedToolNames: toolNames,
    allowedSkillIds: [],
  });
}

function skillRootGrant(toolNames: readonly string[], path: string) {
  return createCapabilityGrant({
    actorUserId: "user",
    runId: "run",
    depth: 0,
    skillExecutionRoots: [{
      id: "skill-root:demo",
      skillId: "demo-skill",
      name: "demo-skill",
      cwd: "@skills/demo-skill",
      path,
    }],
    allowedToolNames: toolNames,
    allowedSkillIds: ["demo-skill"],
  });
}

function grantContext(toolNames: readonly string[]) {
  return { grant: grant(toolNames) };
}

function assertReadFileSchemaForbidsMixedWindows(schema: unknown) {
  assert.equal(schema !== null && typeof schema === "object", true);
  const allOf = (schema as { allOf?: unknown }).allOf;
  assert.deepEqual(allOf, [
    { not: { required: ["ranges", "offset"] } },
    { not: { required: ["ranges", "limit"] } },
  ]);
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code: unknown }).code === code;
}
