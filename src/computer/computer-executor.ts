import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, promises as fs, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { AppError, badRequest, conflict, forbidden } from "../shared/errors.ts";

const DEFAULT_OUTPUT_LIMIT = 100_000;
const COMMAND_OUTPUT_REFERENCE_THRESHOLD = 8_000;
const COMMAND_OUTPUT_REFERENCE_PREVIEW = 2_000;
const EXECUTABLE_NAME_PATTERN = /^[A-Za-z0-9._+-]+$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SENSITIVE_ENVIRONMENT_NAME_PATTERN = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTH|CREDENTIAL)/;
const SEARCH_BINARY_TIMEOUT_MS = 30_000;
const SEARCH_FILE_CONCURRENCY = 8;
const SEARCH_MAX_FILE_BYTES = 1_000_000;
const FIND_FILE_CONCURRENCY = 8;
const FIND_DEFAULT_LIMIT = 1_000;
const FIND_MAX_LIMIT = 10_000;
const READ_RANGE_DEFAULT_LIMIT = 200;
const READ_RANGE_MAX_LIMIT = 2_000;
const READ_RANGE_MAX_RANGES = 20;
const SEARCH_CONTEXT_MAX_LINES = 20;
const COMMAND_FILE_CHANGE_SCAN_LIMIT = 5_000;
const COMMAND_FILE_CHANGE_RESULT_LIMIT = 200;
const COMMAND_FILE_CHANGE_IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".agentloop"]);
const READ_ONLY_ROOT_CHANGE_SCAN_LIMIT = 10_000;
const MISSING_BASENAME_LOOKUP_SCAN_LIMIT = 5_000;
const MISSING_BASENAME_LOOKUP_CANDIDATE_LIMIT = 25;
const WRITTEN_FILE_OUTLINE_LIMIT = 120;
const WRITTEN_FILE_SAMPLE_EDGE_LINES = 40;
const WRITTEN_FILE_SAMPLE_RANGE_CHAR_LIMIT = 6_000;
const BASENAME_LOOKUP_DIRECTORY_PRIORITY = [
  "evidence",
  "artifacts",
  "artifact",
  "reports",
  "report",
  "outputs",
  "output",
  "data",
] as const;
const COMMAND_ROOT_ID_PATTERN = /^@skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly context?: SearchMatchContext;
  readonly readRange?: ReadLineRange;
}

interface SearchMatchContext {
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
}

export interface ReadLineRange {
  readonly offset: number;
  readonly limit?: number;
}

interface NormalizedReadLineRange {
  readonly offset: number;
  readonly limit: number;
}

interface ReadFileRangeResult {
  readonly offset: number;
  readonly limit: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly truncated: boolean;
  readonly nextOffset?: number;
}

interface CommandOutputReference {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly characters: number;
  readonly previewCharacters: number;
}

interface CommandFileSnapshotEntry {
  readonly size: number;
  readonly mtimeMs: number;
}

interface CommandFileChange {
  readonly path: string;
  readonly changeType: "created" | "modified" | "deleted";
  readonly bytes?: number;
}

interface CommandRootResolution {
  readonly path: string;
  readonly readOnlyRoot?: CommandRootMount;
}

interface WrittenFileInspection {
  readonly sha256: string;
  readonly characters: number;
  readonly totalLines: number;
  readonly outline: readonly WrittenFileOutlineEntry[];
  readonly outlineTruncated: boolean;
  readonly sampleRanges: readonly WrittenFileSampleRange[];
}

interface WrittenFileOutlineEntry {
  readonly line: number;
  readonly text: string;
}

interface WrittenFileSampleRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly truncated: boolean;
}

interface ResolvedReadableFile {
  readonly absolutePath: string;
  readonly workspacePath: string;
  readonly requestedPath?: string;
}

interface LocatedReadableFile extends ResolvedReadableFile {
  readonly directoryPriority: number;
  readonly depth: number;
}

export interface CommandRootMount {
  readonly id: string;
  readonly path: string;
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
  /** Server-managed, read-only roots that may be used as command cwd aliases. */
  readonly commandRoots?: readonly CommandRootMount[];
}

export class ComputerExecutor {
  readonly workspaceRoot: string;
  private readonly executableAliases: ReadonlyMap<string, string>;
  private readonly commandEnvironment: Readonly<Record<string, string>>;
  private readonly readOnlyRoots: readonly string[];
  private readonly commandRoots: readonly CommandRootMount[];

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
    this.commandRoots = Object.freeze((options.commandRoots ?? []).map((root) => {
      if (!COMMAND_ROOT_ID_PATTERN.test(root.id)) {
        throw new TypeError(`Command root id must use the @skills/<skill-name> form: ${root.id}`);
      }
      const canonical = realpathSync(resolve(root.path));
      if (!statSync(canonical).isDirectory()) {
        throw new TypeError(`Command root ${root.id} must identify a directory`);
      }
      return { id: root.id, path: canonical };
    }));
  }

  withWorkspaceRoot(
    workspaceRoot: string,
    options: { commandRoots?: readonly CommandRootMount[] } = {},
  ): ComputerExecutor {
    return new ComputerExecutor(workspaceRoot, {
      executableAliases: Object.fromEntries(this.executableAliases),
      commandEnvironment: this.commandEnvironment,
      readOnlyRoots: this.readOnlyRoots,
      commandRoots: options.commandRoots ?? this.commandRoots,
    });
  }

  async listDirectory(path: string): Promise<Array<{ name: string; type: string }>> {
    const target = await this.resolveExisting(path);
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries.slice(0, 2_000).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
    }));
  }

  async readFile(
    path: string,
    maximumBytes = 200_000,
    options: { offset?: number; limit?: number; ranges?: readonly ReadLineRange[] } = {},
  ): Promise<{
    content: string;
    bytes: number;
    truncated: boolean;
    resolvedPath?: string;
    requestedPath?: string;
    offset?: number;
    limit?: number;
    totalLines?: number;
    nextOffset?: number;
    ranges?: ReadFileRangeResult[];
  }> {
    const resolvedFile = await this.resolveReadableFile(path);
    const target = resolvedFile.absolutePath;
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw badRequest("path must identify a regular file");
    if (options.ranges !== undefined || options.offset !== undefined || options.limit !== undefined) {
      const requestedRanges = normalizeReadLineRanges(
        options.ranges ?? [{ offset: options.offset ?? 1, limit: options.limit }],
      );
      const { ranges, totalLines } = await readLineRanges(target, requestedRanges);
      const nextOffset = ranges.length === 1 ? ranges[0].nextOffset : undefined;
      return {
        content: formatReadRangeContent(resolvedFile.workspacePath, ranges),
        bytes: stat.size,
        truncated: stat.size > maximumBytes || ranges.some((range) => range.truncated),
        ...readFileResolutionMetadata(resolvedFile),
        ...(options.ranges === undefined ? { offset: requestedRanges[0].offset, limit: requestedRanges[0].limit } : {}),
        totalLines,
        ...(nextOffset === undefined ? {} : { nextOffset }),
        ranges,
      };
    }
    const handle = await fs.open(target, "r");
    try {
      const length = Math.min(stat.size, maximumBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      const content = buffer.toString("utf8");
      return {
        content,
        bytes: stat.size,
        truncated: stat.size > maximumBytes,
        ...readFileResolutionMetadata(resolvedFile),
      };
    } finally {
      await handle.close();
    }
  }

  async findFiles(
    path: string,
    pattern: string,
    options: { limit?: number } = {},
  ): Promise<{
    matches: string[];
    limit: number;
    truncated: boolean;
  }> {
    if (pattern.trim().length === 0) throw badRequest("pattern must be non-empty");
    const root = await this.resolveExisting(path);
    const rootStat = await fs.stat(root);
    const limit = Math.min(Math.max(1, options.limit ?? FIND_DEFAULT_LIMIT), FIND_MAX_LIMIT);
    const matcher = globMatcher(pattern);
    const matches: string[] = [];
    let truncated = false;
    const addMatch = (absolutePath: string): void => {
      const rel = relative(root, absolutePath).split(sep).join("/") || ".";
      const workspaceRel = relative(this.workspaceRoot, absolutePath).split(sep).join("/") || ".";
      if (matcher(rel) || matcher(workspaceRel)) {
        if (matches.length >= limit) {
          truncated = true;
          return;
        }
        matches.push(workspaceRel);
      }
    };
    if (rootStat.isFile()) {
      addMatch(root);
      return { matches: matches.sort(), limit, truncated };
    }
    if (!rootStat.isDirectory()) throw badRequest("path must identify a file or directory");
    const queue: string[] = [root];
    while (queue.length > 0 && !truncated) {
      const batch = queue.splice(0, FIND_FILE_CONCURRENCY);
      const scanned = await Promise.all(batch.map(async (directory) => {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const directories: string[] = [];
        const files: string[] = [];
        for (const entry of entries) {
          if (entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") continue;
          const child = resolve(directory, entry.name);
          if (entry.isDirectory()) directories.push(child);
          else if (entry.isFile()) files.push(child);
        }
        return { directories, files };
      }));
      for (const { directories, files } of scanned) {
        for (const file of files) {
          addMatch(file);
          if (truncated) break;
        }
        if (truncated) break;
        for (const directory of directories) queue.push(directory);
      }
    }
    return { matches: matches.sort(), limit, truncated };
  }

  async searchText(
    path: string,
    query: string,
    options: { maxFiles?: number; maxMatches?: number; contextBefore?: number; contextAfter?: number } = {},
  ): Promise<SearchMatch[]> {
    const root = await this.resolveExisting(path);
    const maxFiles = options.maxFiles ?? 5_000;
    const maxMatches = options.maxMatches ?? 200;
    const contextBefore = Math.min(options.contextBefore ?? 0, SEARCH_CONTEXT_MAX_LINES);
    const contextAfter = Math.min(options.contextAfter ?? 0, SEARCH_CONTEXT_MAX_LINES);
    const rg = this.executableAliases.get("rg");
    const grep = this.executableAliases.get("grep");
    const binary = rg ?? grep;
    let matches: SearchMatch[];
    if (binary !== undefined) {
      try {
        matches = sortSearchMatches(await this.searchWithBinary(binary, rg !== undefined, root, query, maxMatches));
        return await this.attachSearchContext(matches, contextBefore, contextAfter);
      } catch {
        // The trusted search binary could not run (e.g. it vanished after startup);
        // fall through to the portable pure-JS walk below.
      }
    }
    matches = sortSearchMatches(await this.searchWithWalk(root, query, maxFiles, maxMatches));
    return await this.attachSearchContext(matches, contextBefore, contextAfter);
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

  private async attachSearchContext(
    matches: readonly SearchMatch[],
    contextBefore: number,
    contextAfter: number,
  ): Promise<SearchMatch[]> {
    if (contextBefore === 0 && contextAfter === 0) return [...matches];
    const output: SearchMatch[] = [...matches];
    const byPath = new Map<string, Array<{ index: number; range: NormalizedReadLineRange }>>();
    matches.forEach((match, index) => {
      const startLine = Math.max(1, match.line - contextBefore);
      const limit = contextBefore + 1 + contextAfter;
      const entries = byPath.get(match.path) ?? [];
      entries.push({ index, range: { offset: startLine, limit } });
      byPath.set(match.path, entries);
    });
    await Promise.all([...byPath.entries()].map(async ([path, entries]) => {
      try {
        const file = await this.resolveReadableFile(path);
        const { ranges } = await readLineRanges(file.absolutePath, entries.map((entry) => entry.range));
        ranges.forEach((range, rangeIndex) => {
          const match = matches[entries[rangeIndex].index];
          output[entries[rangeIndex].index] = {
            ...match,
            context: {
              startLine: range.startLine,
              endLine: range.endLine,
              content: range.content,
            },
            readRange: { offset: range.startLine, limit: range.limit },
          };
        });
      } catch {
        for (const entry of entries) {
          const match = matches[entry.index];
          output[entry.index] = { ...match, readRange: entry.range };
        }
      }
    }));
    return output;
  }

  async writeFile(path: string, content: string, overwrite: boolean): Promise<{
    path: string;
    bytes: number;
    sha256: string;
    characters: number;
    totalLines: number;
    inspection: WrittenFileInspection;
  }> {
    const target = await this.resolveWritable(path);
    try {
      await fs.writeFile(target, content, { encoding: "utf8", flag: overwrite ? "w" : "wx", mode: 0o600 });
    } catch (error) {
      if (!overwrite && isFileAlreadyExistsError(error)) {
        throw conflict("File already exists; set overwrite=true to replace it");
      }
      throw error;
    }
    const inspection = inspectWrittenText(content);
    return {
      path: relative(this.workspaceRoot, target).split(sep).join("/"),
      bytes: Buffer.byteLength(content),
      sha256: inspection.sha256,
      characters: inspection.characters,
      totalLines: inspection.totalLines,
      inspection,
    };
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
    stdoutRef?: CommandOutputReference;
    stderrRef?: CommandOutputReference;
    fileChanges: CommandFileChange[];
    fileChangesTruncated: boolean;
    truncated: boolean;
    timedOut: boolean;
  }> {
    if (!EXECUTABLE_NAME_PATTERN.test(input.command)) {
      throw badRequest("command must be an executable name without shell syntax or path separators");
    }
    const cwdResolution = await this.resolveCommandCwd(input.cwd);
    const cwd = cwdResolution.path;
    if (!(await fs.stat(cwd)).isDirectory()) throw badRequest("cwd must be a directory");
    const limit = DEFAULT_OUTPUT_LIMIT;
    const beforeFiles = await this.snapshotWorkspaceFiles();
    const beforeReadOnlyRoot = cwdResolution.readOnlyRoot === undefined
      ? undefined
      : await snapshotReadOnlyRoot(cwdResolution.readOnlyRoot);
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
        void (async () => {
          try {
            const afterFiles = await this.snapshotWorkspaceFiles();
            const fileChangeSummary = summarizeFileChanges(beforeFiles, afterFiles);
            if (beforeReadOnlyRoot !== undefined && cwdResolution.readOnlyRoot !== undefined) {
              const afterReadOnlyRoot = await snapshotReadOnlyRoot(cwdResolution.readOnlyRoot);
              const rootChangeSummary = summarizeFileChanges(beforeReadOnlyRoot, afterReadOnlyRoot);
              if (rootChangeSummary.changes.length > 0 || rootChangeSummary.truncated) {
                throw new AppError(
                  "SKILL_PACKAGE_MUTATED",
                  `Command modified read-only Skill execution root ${cwdResolution.readOnlyRoot.id}`,
                  409,
                  {
                    skillExecutionRoot: cwdResolution.readOnlyRoot.id,
                    changes: rootChangeSummary.changes,
                    changesTruncated: rootChangeSummary.truncated,
                  },
                );
              }
            }
            const stdoutProjection = await this.projectCommandOutput("stdout", stdout.toString("utf8"));
            const stderrProjection = await this.projectCommandOutput("stderr", stderr.toString("utf8"));
            resolvePromise({
              exitCode,
              signal,
              stdout: stdoutProjection.content,
              stderr: stderrProjection.content,
              ...(stdoutProjection.reference === undefined ? {} : { stdoutRef: stdoutProjection.reference }),
              ...(stderrProjection.reference === undefined ? {} : { stderrRef: stderrProjection.reference }),
              fileChanges: fileChangeSummary.changes,
              fileChangesTruncated: fileChangeSummary.truncated,
              truncated,
              timedOut,
            });
          } catch (error) {
            rejectPromise(error);
          }
        })();
      });
    });
  }

  private async projectCommandOutput(kind: "stdout" | "stderr", content: string): Promise<{
    content: string;
    reference?: CommandOutputReference;
  }> {
    if (content.length <= COMMAND_OUTPUT_REFERENCE_THRESHOLD) return { content };
    const sha256 = createHash("sha256").update(content).digest("hex");
    const directory = resolve(this.workspaceRoot, ".agentloop", "tool-results", sha256.slice(0, 2));
    this.assertContained(directory);
    this.assertNotReadOnly(directory);
    await this.ensureWritableDirectory(directory);
    const target = resolve(directory, `${sha256}.${kind}.txt`);
    this.assertContained(target);
    this.assertNotReadOnly(target);
    await fs.writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const path = relative(this.workspaceRoot, target);
    const bytes = Buffer.byteLength(content);
    return {
      content: [
        content.slice(0, COMMAND_OUTPUT_REFERENCE_PREVIEW),
        "",
        `[${kind} stored as content-addressed evidence; path=${path}; sha256=${sha256}; originalCharacters=${content.length}; bytes=${bytes}. Reuse this path/hash instead of rerunning the command solely to recover this output.]`,
      ].join("\n"),
      reference: {
        path,
        sha256,
        bytes,
        characters: content.length,
        previewCharacters: COMMAND_OUTPUT_REFERENCE_PREVIEW,
      },
    };
  }

  private async snapshotWorkspaceFiles(): Promise<{
    readonly files: ReadonlyMap<string, CommandFileSnapshotEntry>;
    readonly truncated: boolean;
  }> {
    const files = new Map<string, CommandFileSnapshotEntry>();
    let truncated = false;
    const queue: string[] = [this.workspaceRoot];
    while (queue.length > 0 && !truncated) {
      const directory = queue.shift()!;
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (COMMAND_FILE_CHANGE_IGNORED_DIRECTORIES.has(entry.name)) continue;
          queue.push(resolve(directory, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        const target = resolve(directory, entry.name);
        const stat = await fs.stat(target).catch(() => undefined);
        if (stat === undefined || !stat.isFile()) continue;
        files.set(relative(this.workspaceRoot, target).split(sep).join("/"), {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
        if (files.size >= COMMAND_FILE_CHANGE_SCAN_LIMIT) {
          truncated = true;
          break;
        }
      }
    }
    return { files, truncated };
  }

  private lexicalPath(path: string): string {
    if (isAbsolute(path)) throw forbidden("Computer paths must be relative to the configured workspace root");
    const target = resolve(this.workspaceRoot, path || ".");
    this.assertContained(target);
    return target;
  }

  private async resolveReadableFile(path: string): Promise<ResolvedReadableFile> {
    try {
      const absolutePath = await this.resolveExisting(path);
      return {
        absolutePath,
        workspacePath: relative(this.workspaceRoot, absolutePath).split(sep).join("/") || ".",
      };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "NOT_FOUND" || !isBareFilename(path)) throw error;
      const candidates = await this.locateReadableFilesByBasename(path);
      if (candidates.length === 0) throw error;
      const best = candidates[0];
      const competingBest = candidates.filter((candidate) =>
        candidate.directoryPriority === best.directoryPriority && candidate.depth === best.depth
      );
      if (competingBest.length > 1) {
        throw new AppError(
          "CONFLICT",
          `Multiple files named ${path}; read_file needs a more specific relative path`,
          409,
          {
            requestedPath: path,
            candidates: candidates.map((candidate) => candidate.workspacePath),
          },
        );
      }
      return { absolutePath: best.absolutePath, workspacePath: best.workspacePath, requestedPath: path };
    }
  }

  private async locateReadableFilesByBasename(name: string): Promise<LocatedReadableFile[]> {
    const matches: LocatedReadableFile[] = [];
    const queue: string[] = [this.workspaceRoot];
    let scanned = 0;
    while (
      queue.length > 0
      && scanned < MISSING_BASENAME_LOOKUP_SCAN_LIMIT
      && matches.length < MISSING_BASENAME_LOOKUP_CANDIDATE_LIMIT
    ) {
      const directory = queue.shift()!;
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const child = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          if (!COMMAND_FILE_CHANGE_IGNORED_DIRECTORIES.has(entry.name)) queue.push(child);
          continue;
        }
        if (!entry.isFile()) continue;
        scanned += 1;
        if (entry.name !== name) continue;
        const canonical = await fs.realpath(child).catch(() => undefined);
        if (canonical === undefined) continue;
        this.assertContained(canonical);
        const workspacePath = relative(this.workspaceRoot, canonical).split(sep).join("/");
        matches.push({
          absolutePath: canonical,
          workspacePath,
          directoryPriority: directoryPriority(workspacePath),
          depth: pathDepth(workspacePath),
        });
        if (matches.length >= MISSING_BASENAME_LOOKUP_CANDIDATE_LIMIT) break;
      }
    }
    return matches.sort(compareLocatedReadableFiles);
  }

  private async resolveExisting(path: string): Promise<string> {
    const target = this.lexicalPath(path);
    const canonical = await fs.realpath(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new AppError("NOT_FOUND", `Path not found: ${path}`, 404);
      }
      throw error;
    });
    this.assertContained(canonical);
    return canonical;
  }

  private async resolveCommandCwd(path: string): Promise<CommandRootResolution> {
    const mounted = await this.resolveCommandRootPath(path);
    if (mounted !== undefined) return mounted;
    return { path: await this.resolveExisting(path) };
  }

  private async resolveCommandRootPath(path: string): Promise<CommandRootResolution | undefined> {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/u, "") || ".";
    if (normalized.startsWith("@skills/") && !this.commandRoots.some((root) =>
      normalized === root.id || normalized.startsWith(`${root.id}/`)
    )) {
      throw forbidden(`Skill execution root is not authorized for this run: ${normalized.split("/").slice(0, 2).join("/")}`);
    }
    for (const root of this.commandRoots) {
      if (normalized !== root.id && !normalized.startsWith(`${root.id}/`)) continue;
      const suffix = normalized === root.id ? "." : normalized.slice(root.id.length + 1);
      const target = resolve(root.path, suffix);
      const canonical = await fs.realpath(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          throw new AppError("NOT_FOUND", `Path not found: ${path}`, 404);
        }
        throw error;
      });
      assertInsideRoot(canonical, root.path, `Skill execution root ${root.id}`);
      return { path: canonical, readOnlyRoot: root };
    }
    return undefined;
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

function isFileAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function inspectWrittenText(content: string): WrittenFileInspection {
  const lines = splitTextLines(content);
  const outline = lines
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter((entry) => /^#{1,6}\s+\S/.test(entry.text))
    .slice(0, WRITTEN_FILE_OUTLINE_LIMIT);
  const outlineCount = lines.reduce((count, line) => count + (/^#{1,6}\s+\S/.test(line.trim()) ? 1 : 0), 0);
  return {
    sha256: createHash("sha256").update(content).digest("hex"),
    characters: content.length,
    totalLines: lines.length,
    outline,
    outlineTruncated: outlineCount > outline.length,
    sampleRanges: writtenFileSampleRanges(lines),
  };
}

function splitTextLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function writtenFileSampleRanges(lines: readonly string[]): WrittenFileSampleRange[] {
  if (lines.length === 0) return [];
  const ranges = [
    { start: 1, end: Math.min(lines.length, WRITTEN_FILE_SAMPLE_EDGE_LINES) },
    { start: Math.max(1, lines.length - WRITTEN_FILE_SAMPLE_EDGE_LINES + 1), end: lines.length },
  ];
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return merged.map((range) => {
    const raw = lines.slice(range.start - 1, range.end).join("\n");
    const truncated = raw.length > WRITTEN_FILE_SAMPLE_RANGE_CHAR_LIMIT;
    return {
      startLine: range.start,
      endLine: range.end,
      content: truncated ? raw.slice(0, WRITTEN_FILE_SAMPLE_RANGE_CHAR_LIMIT) : raw,
      truncated,
    };
  });
}

function readFileResolutionMetadata(
  resolvedFile: ResolvedReadableFile,
): { readonly resolvedPath?: string; readonly requestedPath?: string } {
  return resolvedFile.requestedPath === undefined
    ? {}
    : { requestedPath: resolvedFile.requestedPath, resolvedPath: resolvedFile.workspacePath };
}

function normalizeReadLineRanges(ranges: readonly ReadLineRange[]): NormalizedReadLineRange[] {
  if (ranges.length === 0 || ranges.length > READ_RANGE_MAX_RANGES) {
    throw badRequest(`ranges must contain between 1 and ${READ_RANGE_MAX_RANGES} entries`);
  }
  return ranges.map((range, index) => {
    if (!Number.isSafeInteger(range.offset) || range.offset < 1) {
      throw badRequest(`ranges[${index}].offset must be a positive integer`);
    }
    const limit = range.limit ?? READ_RANGE_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > READ_RANGE_MAX_LIMIT) {
      throw badRequest(`ranges[${index}].limit must be an integer between 1 and ${READ_RANGE_MAX_LIMIT}`);
    }
    return { offset: range.offset, limit };
  });
}

async function readLineRanges(
  path: string,
  ranges: readonly NormalizedReadLineRange[],
): Promise<{ ranges: ReadFileRangeResult[]; totalLines: number }> {
  const collected = ranges.map((range) => ({
    range,
    lines: [] as string[],
  }));
  let lineNumber = 0;
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      lineNumber += 1;
      for (const item of collected) {
        const start = item.range.offset;
        const end = item.range.offset + item.range.limit - 1;
        if (lineNumber >= start && lineNumber <= end) item.lines.push(line);
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  if (lineNumber === 0) throw badRequest("file has no readable lines");
  const result = collected.map(({ range, lines }, index) => {
    if (range.offset > lineNumber) {
      throw badRequest(`ranges[${index}].offset ${range.offset} is beyond the file line count (${lineNumber})`);
    }
    const endLine = Math.min(lineNumber, range.offset + range.limit - 1);
    const nextOffset = endLine < lineNumber ? endLine + 1 : undefined;
    return {
      offset: range.offset,
      limit: range.limit,
      startLine: range.offset,
      endLine,
      content: lines.join("\n"),
      truncated: nextOffset !== undefined,
      ...(nextOffset === undefined ? {} : { nextOffset }),
    };
  });
  return { ranges: result, totalLines: lineNumber };
}

function formatReadRangeContent(path: string, ranges: readonly ReadFileRangeResult[]): string {
  if (ranges.length === 1) {
    const range = ranges[0];
    return [
      range.content,
      range.nextOffset === undefined ? "" : `\n[More readable content available. Use offset=${range.nextOffset} to continue.]`,
    ].join("").trimEnd();
  }
  return ranges.map((range) => [
    `--- ${path} lines ${range.startLine}-${range.endLine} ---`,
    range.content,
    range.nextOffset === undefined ? "" : `[More readable content available after this range. Use offset=${range.nextOffset} to continue.]`,
  ].filter((part) => part !== "").join("\n")).join("\n\n").trimEnd();
}

function isBareFilename(path: string): boolean {
  return path.length > 0
    && path === path.trim()
    && path !== "."
    && path !== ".."
    && !path.includes("/")
    && !path.includes("\\")
    && basename(path) === path;
}

function directoryPriority(workspacePath: string): number {
  const directories = workspacePath.split("/").slice(0, -1).map((segment) => segment.toLowerCase());
  let best = BASENAME_LOOKUP_DIRECTORY_PRIORITY.length;
  for (const directory of directories) {
    const index = BASENAME_LOOKUP_DIRECTORY_PRIORITY.indexOf(
      directory as (typeof BASENAME_LOOKUP_DIRECTORY_PRIORITY)[number],
    );
    if (index !== -1) best = Math.min(best, index);
  }
  return best;
}

function pathDepth(workspacePath: string): number {
  return Math.max(0, workspacePath.split("/").length - 1);
}

function compareLocatedReadableFiles(left: LocatedReadableFile, right: LocatedReadableFile): number {
  return left.directoryPriority - right.directoryPriority
    || left.depth - right.depth
    || left.workspacePath.localeCompare(right.workspacePath);
}

function summarizeFileChanges(
  before: { readonly files: ReadonlyMap<string, CommandFileSnapshotEntry>; readonly truncated: boolean },
  after: { readonly files: ReadonlyMap<string, CommandFileSnapshotEntry>; readonly truncated: boolean },
): { readonly changes: CommandFileChange[]; readonly truncated: boolean } {
  const changes: CommandFileChange[] = [];
  let truncated = before.truncated || after.truncated;
  const push = (change: CommandFileChange): void => {
    if (changes.length >= COMMAND_FILE_CHANGE_RESULT_LIMIT) {
      truncated = true;
      return;
    }
    changes.push(change);
  };
  for (const [path, next] of after.files) {
    const prior = before.files.get(path);
    if (prior === undefined) {
      push({ path, changeType: "created", bytes: next.size });
    } else if (prior.size !== next.size || prior.mtimeMs !== next.mtimeMs) {
      push({ path, changeType: "modified", bytes: next.size });
    }
  }
  for (const path of before.files.keys()) {
    if (!after.files.has(path)) push({ path, changeType: "deleted" });
  }
  return {
    changes: changes.sort((left, right) => left.path.localeCompare(right.path)),
    truncated,
  };
}

async function snapshotReadOnlyRoot(root: CommandRootMount): Promise<{
  readonly files: ReadonlyMap<string, CommandFileSnapshotEntry>;
  readonly truncated: boolean;
}> {
  const files = new Map<string, CommandFileSnapshotEntry>();
  let truncated = false;
  const queue: string[] = [root.path];
  while (queue.length > 0 && !truncated) {
    const directory = queue.shift()!;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(target).catch(() => undefined);
      if (stat === undefined || !stat.isFile()) continue;
      files.set(relative(root.path, target).split(sep).join("/"), {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      if (files.size >= READ_ONLY_ROOT_CHANGE_SCAN_LIMIT) {
        truncated = true;
        break;
      }
    }
  }
  return { files, truncated };
}

function assertInsideRoot(candidate: string, root: string, label: string): void {
  const offset = relative(root, candidate);
  if (offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))) return;
  throw forbidden(`${label} path escapes its authorized root`);
}

function globMatcher(pattern: string): (path: string) => boolean {
  const normalized = pattern.replace(/\\/g, "/");
  const expression = globToRegExp(normalized);
  return (path) => expression.test(path.replace(/\\/g, "/"));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(character);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  env.PYTHONDONTWRITEBYTECODE = "1";
  return { ...env, ...commandEnvironment };
}

function sortSearchMatches(matches: SearchMatch[]): SearchMatch[] {
  return matches.sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    return left.line - right.line;
  });
}
