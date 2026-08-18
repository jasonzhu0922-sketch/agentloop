import { spawn } from "node:child_process";
import { promises as fs, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { AppError, badRequest, forbidden } from "../shared/errors.ts";

const DEFAULT_OUTPUT_LIMIT = 100_000;
const EXECUTABLE_NAME_PATTERN = /^[A-Za-z0-9._+-]+$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SENSITIVE_ENVIRONMENT_NAME_PATTERN = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTH|CREDENTIAL)/;
const SEARCH_BINARY_TIMEOUT_MS = 30_000;
const SEARCH_FILE_CONCURRENCY = 8;
const SEARCH_MAX_FILE_BYTES = 1_000_000;

interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface ComputerExecutorOptions {
  /**
   * Server-owned executable aliases. The model receives only the alias while
   * the executor resolves it to a canonical absolute binary path.
   */
  readonly executableAliases?: Readonly<Record<string, string>>;
  /** Non-secret, server-owned variables made available to spawned tools. */
  readonly commandEnvironment?: Readonly<Record<string, string>>;
  /** Server-managed trees that Computer write operations must never modify. */
  readonly readOnlyRoots?: readonly string[];
}

export class ComputerExecutor {
  readonly workspaceRoot: string;
  private readonly executableAliases: ReadonlyMap<string, string>;
  private readonly commandEnvironment: Readonly<Record<string, string>>;
  private readonly readOnlyRoots: readonly string[];

  constructor(workspaceRoot: string, options: ComputerExecutorOptions = {}) {
    this.workspaceRoot = realpathSync(resolve(workspaceRoot));
    this.executableAliases = new Map(
      Object.entries(options.executableAliases ?? {}).map(([name, target]) => {
        if (!EXECUTABLE_NAME_PATTERN.test(name)) {
          throw new TypeError(`Trusted executable alias has an invalid name: ${name}`);
        }
        if (!isAbsolute(target)) {
          throw new TypeError(`Trusted executable alias ${name} must resolve from an absolute path`);
        }
        const canonical = realpathSync(target);
        if (!statSync(canonical).isFile()) {
          throw new TypeError(`Trusted executable alias ${name} must identify a regular file`);
        }
        return [name, canonical] as const;
      }),
    );
    this.commandEnvironment = Object.freeze(
      Object.fromEntries(Object.entries(options.commandEnvironment ?? {}).map(([name, value]) => {
        if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
          throw new TypeError(`Trusted command environment has an invalid name: ${name}`);
        }
        if (SENSITIVE_ENVIRONMENT_NAME_PATTERN.test(name)) {
          throw new TypeError(`Trusted command environment must not contain sensitive variable ${name}`);
        }
        if (typeof value !== "string" || value.includes("\0")) {
          throw new TypeError(`Trusted command environment ${name} must be a string without NUL bytes`);
        }
        return [name, value];
      })),
    );
    this.readOnlyRoots = Object.freeze((options.readOnlyRoots ?? []).map((root) => realpathSync(resolve(root))));
  }

  async listDirectory(path: string): Promise<Array<{ name: string; type: string }>> {
    const target = await this.resolveExisting(path);
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries.slice(0, 2_000).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
    }));
  }

  async readFile(path: string, maximumBytes = 200_000): Promise<{ content: string; bytes: number; truncated: boolean }> {
    const target = await this.resolveExisting(path);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw badRequest("path must identify a regular file");
    const handle = await fs.open(target, "r");
    try {
      const length = Math.min(stat.size, maximumBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      return { content: buffer.toString("utf8"), bytes: stat.size, truncated: stat.size > maximumBytes };
    } finally {
      await handle.close();
    }
  }

  async searchText(
    path: string,
    query: string,
    options: { maxFiles?: number; maxMatches?: number } = {},
  ): Promise<SearchMatch[]> {
    const root = await this.resolveExisting(path);
    const maxFiles = options.maxFiles ?? 5_000;
    const maxMatches = options.maxMatches ?? 200;
    const rg = this.executableAliases.get("rg");
    const grep = this.executableAliases.get("grep");
    const binary = rg ?? grep;
    if (binary !== undefined) {
      try {
        return sortSearchMatches(await this.searchWithBinary(binary, rg !== undefined, root, query, maxMatches));
      } catch {
        // The trusted search binary could not run (e.g. it vanished after startup);
        // fall through to the portable pure-JS walk below.
      }
    }
    return sortSearchMatches(await this.searchWithWalk(root, query, maxFiles, maxMatches));
  }

  /**
   * Fast path: delegate the scan to a server-trusted `rg`/`grep` binary. The
   * query is passed in fixed-string mode (`-F`) through `-e` so it is never
   * interpreted as a regular expression or as an option.
   */
  private async searchWithBinary(
    binary: string,
    ripgrep: boolean,
    root: string,
    query: string,
    maxMatches: number,
  ): Promise<SearchMatch[]> {
    // ripgrep is parsed through --json so Windows drive letters and ':' in
    // paths/text never collide with field separators; grep strips the known
    // search root prefix for the same reason.
    const args = ripgrep
      ? [
        "--json", "-F", "-e", query, "-m", String(maxMatches),
        "--max-filesize", "1M", "-g", "!node_modules", "-g", "!.git", root,
      ]
      : [
        "-RHIn", "-F", "-e", query, "-m", String(maxMatches),
        "--exclude-dir=node_modules", "--exclude-dir=.git", root,
      ];
    const parseLine = ripgrep
      ? (line: string): SearchMatch | undefined => parseRgJsonLine(line, this.workspaceRoot)
      : (line: string): SearchMatch | undefined => parseGrepLine(line, root, this.workspaceRoot);
    return new Promise<SearchMatch[]>((resolve, reject) => {
      let settled = false;
      let stdoutBuffer = "";
      const results: SearchMatch[] = [];
      const child = spawn(binary, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildCommandEnvironment(this.commandEnvironment),
      });
      const timer = setTimeout(() => child.kill("SIGTERM"), SEARCH_BINARY_TIMEOUT_MS);
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(results);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          const parsed = parseLine(line);
          if (parsed === undefined) continue;
          results.push(parsed);
          if (results.length >= maxMatches) {
            child.kill("SIGTERM");
            finish();
            return;
          }
        }
      });
      child.stderr.on("data", () => {});
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new AppError("TOOL_EXECUTION_ERROR", `Failed to start search binary: ${error.message}`, 500));
      });
      child.once("close", () => finish());
    });
  }

  /** Portable fallback: bounded-parallel traversal + streaming line match. */
  private async searchWithWalk(
    root: string,
    query: string,
    maxFiles: number,
    maxMatches: number,
  ): Promise<SearchMatch[]> {
    const files: string[] = [];
    const rootStat = await fs.stat(root);
    if (rootStat.isFile()) {
      files.push(root);
    } else {
      const dirQueue: string[] = [root];
      while (dirQueue.length > 0 && files.length < maxFiles) {
        const batch = dirQueue.splice(0, SEARCH_FILE_CONCURRENCY);
        const scanned = await Promise.all(batch.map(async (directory) => {
          const entries = await fs.readdir(directory, { withFileTypes: true });
          const subdirs: string[] = [];
          const subfiles: string[] = [];
          for (const entry of entries) {
            if (entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") continue;
            const child = resolve(directory, entry.name);
            if (entry.isDirectory()) subdirs.push(child);
            else if (entry.isFile()) subfiles.push(child);
          }
          return { subdirs, subfiles };
        }));
        for (const { subdirs, subfiles } of scanned) {
          for (const file of subfiles) {
            if (files.length >= maxFiles) break;
            files.push(file);
          }
          for (const directory of subdirs) dirQueue.push(directory);
        }
      }
    }

    const results: SearchMatch[] = [];
    let stopped = false;
    let nextIndex = 0;
    const workers = Array.from({ length: SEARCH_FILE_CONCURRENCY }, async () => {
      for (;;) {
        if (stopped) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= files.length) return;
        const file = files[index];
        const stat = await fs.stat(file).catch(() => undefined);
        if (stat === undefined || stat.size > SEARCH_MAX_FILE_BYTES) continue;
        const content = await fs.readFile(file, "utf8").catch(() => undefined);
        if (content === undefined || content.includes("\0")) continue;
        let offset = 0;
        let lineNumber = 0;
        for (;;) {
          if (stopped) return;
          const newline = content.indexOf("\n", offset);
          let lineText = newline === -1 ? content.slice(offset) : content.slice(offset, newline);
          lineNumber += 1;
          if (lineText.endsWith("\r")) lineText = lineText.slice(0, -1);
          if (lineText.includes(query)) {
            results.push({
              path: relative(this.workspaceRoot, file) || ".",
              line: lineNumber,
              text: lineText.slice(0, 2_000),
            });
            if (results.length >= maxMatches) {
              stopped = true;
              return;
            }
          }
          if (newline === -1) break;
          offset = newline + 1;
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async writeFile(path: string, content: string, overwrite: boolean): Promise<{ path: string; bytes: number }> {
    const target = await this.resolveWritable(path);
    await fs.writeFile(target, content, { encoding: "utf8", flag: overwrite ? "w" : "wx", mode: 0o600 });
    return { path: relative(this.workspaceRoot, target), bytes: Buffer.byteLength(content) };
  }

  async runCommand(input: {
    command: string;
    args: readonly string[];
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    timedOut: boolean;
  }> {
    if (!EXECUTABLE_NAME_PATTERN.test(input.command)) {
      throw badRequest("command must be an executable name without shell syntax or path separators");
    }
    const cwd = await this.resolveExisting(input.cwd);
    if (!(await fs.stat(cwd)).isDirectory()) throw badRequest("cwd must be a directory");
    const limit = DEFAULT_OUTPUT_LIMIT;
    return new Promise((resolvePromise, rejectPromise) => {
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let truncated = false;
      let timedOut = false;
      let settled = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const child = spawn(this.executableAliases.get(input.command) ?? input.command, [...input.args], {
        cwd,
        shell: false,
        env: buildCommandEnvironment(this.commandEnvironment),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (current: Buffer, chunk: Buffer): Buffer => {
        if (current.length >= limit) {
          truncated = true;
          return current;
        }
        const combined = Buffer.concat([current, chunk]);
        if (combined.length <= limit) return combined;
        truncated = true;
        return combined.subarray(0, limit);
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = collect(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = collect(stderr, chunk); });
      const terminate = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        forceTimer ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
      };
      const timeout = setTimeout(() => { timedOut = true; terminate(); }, input.timeoutMs);
      input.signal?.addEventListener("abort", terminate, { once: true });
      const cleanup = (): void => {
        clearTimeout(timeout);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        input.signal?.removeEventListener("abort", terminate);
      };
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(new AppError("TOOL_EXECUTION_ERROR", `Failed to start command: ${error.message}`, 500));
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (input.signal?.aborted) {
          rejectPromise(new AppError("CANCELLED", "Command execution was cancelled", 409));
          return;
        }
        if (timedOut) {
          rejectPromise(new AppError("TOOL_EXECUTION_ERROR", "Command execution timed out", 409));
          return;
        }
        resolvePromise({
          exitCode,
          signal,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          truncated,
          timedOut,
        });
      });
    });
  }

  private lexicalPath(path: string): string {
    if (isAbsolute(path)) throw forbidden("Computer paths must be relative to the configured workspace root");
    const target = resolve(this.workspaceRoot, path || ".");
    this.assertContained(target);
    return target;
  }

  private async resolveExisting(path: string): Promise<string> {
    const target = this.lexicalPath(path);
    const canonical = await fs.realpath(target);
    this.assertContained(canonical);
    return canonical;
  }

  private async resolveWritable(path: string): Promise<string> {
    const target = this.lexicalPath(path);
    this.assertNotReadOnly(target);
    const parentTarget = dirname(target);
    await this.ensureWritableDirectory(parentTarget);
    const parent = await fs.realpath(parentTarget);
    this.assertContained(parent);
    this.assertNotReadOnly(parent);
    const targetStat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (targetStat?.isSymbolicLink()) throw forbidden("Symbolic links are not writable computer targets");
    return target;
  }

  private async ensureWritableDirectory(directory: string): Promise<void> {
    this.assertContained(directory);
    this.assertNotReadOnly(directory);
    const relativeDirectory = relative(this.workspaceRoot, directory);
    if (relativeDirectory === "") return;
    let cursor = this.workspaceRoot;
    for (const segment of relativeDirectory.split(sep)) {
      cursor = resolve(cursor, segment);
      let stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (stat === undefined) {
        await fs.mkdir(cursor, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        stat = await fs.lstat(cursor);
      }
      if (stat.isSymbolicLink()) throw forbidden("Symbolic links are not writable computer targets");
      if (!stat.isDirectory()) throw badRequest("A writable file parent must be a directory");
      this.assertNotReadOnly(cursor);
    }
  }

  private assertNotReadOnly(path: string): void {
    for (const root of this.readOnlyRoots) {
      const offset = relative(root, path);
      if (offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))) {
        throw forbidden("Computer writes cannot modify an installed Skill package");
      }
    }
  }

  private assertContained(path: string): void {
    const offset = relative(this.workspaceRoot, path);
    if (offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))) return;
    throw forbidden("Computer path escapes the configured workspace root");
  }
}

/**
 * Parse one ripgrep `--json` line into a workspace-relative match. JSON output
 * keeps the path, line number and line text in distinct fields, so neither a
 * Windows drive letter nor a `:` inside a path/text can corrupt the parse.
 */
export function parseRgJsonLine(line: string, workspaceRoot: string): SearchMatch | undefined {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  const object = record as Record<string, unknown>;
  if (object.type !== "match") return undefined;
  const data = object.data as Record<string, unknown> | undefined;
  const path = (data?.path as Record<string, unknown> | undefined)?.text;
  const lineNumber = data?.line_number;
  if (typeof path !== "string" || !Number.isSafeInteger(lineNumber) || (lineNumber as number) < 1) return undefined;
  const rawText = (data?.lines as Record<string, unknown> | undefined)?.text;
  const text = typeof rawText === "string" ? rawText.replace(/\r?\n$/, "") : "";
  return {
    path: relative(workspaceRoot, path) || ".",
    line: lineNumber as number,
    text: text.slice(0, 2_000),
  };
}

/**
 * Parse one grep line of the form `<root><sep><relative>:<line>:<text>`. The
 * known search root is stripped first so a Windows drive letter (or any `:` in
 * the root) is not mistaken for a field separator; the remaining relative path
 * cannot contain `:` on Windows.
 */
export function parseGrepLine(line: string, searchRoot: string, workspaceRoot: string): SearchMatch | undefined {
  let remainder = line;
  if (remainder.startsWith(searchRoot)) {
    remainder = remainder.slice(searchRoot.length).replace(/^[\\/]+/, "");
  }
  const firstColon = remainder.indexOf(":");
  if (firstColon === -1) return undefined;
  const secondColon = remainder.indexOf(":", firstColon + 1);
  if (secondColon === -1) return undefined;
  const relativePath = remainder.slice(0, firstColon);
  const lineNumber = Number(remainder.slice(firstColon + 1, secondColon));
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return undefined;
  return {
    path: relative(workspaceRoot, resolve(searchRoot, relativePath)) || ".",
    line: lineNumber,
    text: remainder.slice(secondColon + 1).slice(0, 2_000),
  };
}

/**
 * Build a child-process environment that is correct on both POSIX and Windows:
 * PATH is inherited (never forced to a POSIX default), Windows gets TEMP/TMP/
 * SystemRoot, and POSIX gets a UTF-8 locale and a real temp directory. The
 * server-owned `commandEnvironment` is applied last so it may override any of
 * these on purpose.
 */
export function buildCommandEnvironment(commandEnvironment: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  else if (process.platform !== "win32") env.PATH = "/usr/bin:/bin";
  if (process.platform === "win32") {
    if (process.env.TEMP !== undefined) env.TEMP = process.env.TEMP;
    if (process.env.TMP !== undefined) env.TMP = process.env.TMP;
    if (process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot;
  } else {
    env.LANG = process.env.LANG ?? "C.UTF-8";
    env.LC_ALL = process.env.LC_ALL ?? "C.UTF-8";
    env.TMPDIR = process.env.TMPDIR ?? tmpdir();
  }
  return { ...env, ...commandEnvironment };
}

function sortSearchMatches(matches: SearchMatch[]): SearchMatch[] {
  return matches.sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    return left.line - right.line;
  });
}
