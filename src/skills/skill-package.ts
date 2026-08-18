import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { AppError, badRequest } from "../shared/errors.ts";

const MAX_PACKAGE_FILES = 10_000;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SKILL_INSTRUCTION_BYTES = 200_000;
const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillPackageInspection {
  readonly root: string;
  readonly entrypointPath: "SKILL.md";
  readonly instructions: string;
  readonly name: string;
  readonly description: string;
  readonly packageHash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly string[];
}

export async function inspectSkillPackage(directory: string): Promise<SkillPackageInspection> {
  const root = await fs.realpath(resolve(directory)).catch(() => {
    throw badRequest("Skill package directory does not exist");
  });
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw badRequest("Skill package source must be a directory");

  const files: string[] = [];
  let totalBytes = 0;
  const visit = async (current: string): Promise<void> => {
    const entries = (await fs.readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (entry.name.includes("\0")) throw invalidPackage("Skill package contains a NUL path segment");
      if (entry.isSymbolicLink()) throw invalidPackage("Skill packages must not contain symbolic links");
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
        await visit(resolve(current, entry.name));
        continue;
      }
      if (!entry.isFile()) throw invalidPackage("Skill packages may contain only regular files and directories");
      const absolute = resolve(current, entry.name);
      const stat = await fs.stat(absolute);
      const packagePath = toPackagePath(root, absolute);
      if (packagePath === "SKILL.md" && stat.size > MAX_SKILL_INSTRUCTION_BYTES) {
        throw invalidPackage(`SKILL.md exceeds ${MAX_SKILL_INSTRUCTION_BYTES} bytes`);
      }
      if (stat.size > MAX_FILE_BYTES) {
        throw invalidPackage(`Skill package file exceeds ${MAX_FILE_BYTES} bytes`);
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_PACKAGE_BYTES) {
        throw invalidPackage(`Skill package exceeds ${MAX_PACKAGE_BYTES} bytes`);
      }
      files.push(packagePath);
      if (files.length > MAX_PACKAGE_FILES) {
        throw invalidPackage(`Skill package contains more than ${MAX_PACKAGE_FILES} files`);
      }
    }
  };
  await visit(root);
  files.sort((left, right) => left.localeCompare(right, "en"));
  if (!files.includes("SKILL.md")) throw invalidPackage("Skill package root must contain SKILL.md");

  const hash = createHash("sha256");
  hash.update("agentloop.skillPackage/v1\0");
  for (const packagePath of files) {
    const content = await fs.readFile(resolve(root, ...packagePath.split("/")));
    hash.update("file\0");
    hash.update(packagePath);
    hash.update("\0");
    hash.update(String(content.length));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }

  const instructions = await fs.readFile(resolve(root, "SKILL.md"), "utf8");
  const metadata = parseSkillFrontmatter(instructions);
  return {
    root,
    entrypointPath: "SKILL.md",
    instructions,
    name: metadata.name,
    description: metadata.description,
    packageHash: hash.digest("hex"),
    fileCount: files.length,
    totalBytes,
    files,
  };
}

export async function copySkillPackage(
  inspection: SkillPackageInspection,
  destination: string,
): Promise<SkillPackageInspection> {
  const target = resolve(destination);
  await fs.mkdir(target, { recursive: false, mode: 0o700 });
  for (const packagePath of inspection.files) {
    const source = resolve(inspection.root, ...packagePath.split("/"));
    const output = resolve(target, ...packagePath.split("/"));
    await fs.mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, output);
  }
  const copied = await inspectSkillPackage(target);
  if (copied.packageHash !== inspection.packageHash) {
    throw invalidPackage("Copied Skill package does not match its source hash");
  }
  await makePackageReadOnly(copied);
  return copied;
}

export function assertPathInside(candidate: string, allowedRoot: string, label: string): void {
  const offset = relative(allowedRoot, candidate);
  if (offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))) return;
  throw new AppError("SKILL_PACKAGE_INVALID", `${label} is outside an allowed Skill import root`, 403);
}

export async function removeSkillPackage(directory: string): Promise<void> {
  const root = resolve(directory);
  const makeWritable = async (current: string): Promise<void> => {
    await fs.chmod(current, 0o700).catch(() => undefined);
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      await makeWritable(resolve(current, entry.name));
    }
  };
  await makeWritable(root);
  await fs.rm(root, { recursive: true, force: true });
}

async function makePackageReadOnly(inspection: SkillPackageInspection): Promise<void> {
  const directories = new Set<string>([inspection.root]);
  for (const packagePath of inspection.files) {
    const absolute = resolve(inspection.root, ...packagePath.split("/"));
    await fs.chmod(absolute, 0o444);
    let cursor = dirname(absolute);
    while (cursor !== inspection.root) {
      directories.add(cursor);
      cursor = dirname(cursor);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await fs.chmod(directory, 0o555);
  }
}

function parseSkillFrontmatter(source: string): { name: string; description: string } {
  const normalized = source.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") throw invalidPackage("SKILL.md must begin with YAML frontmatter");
  const closing = lines.indexOf("---", 1);
  if (closing < 0) throw invalidPackage("SKILL.md frontmatter is not closed");
  const values = new Map<string, string>();
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u);
    if (match === null) continue;
    const block = match[2].match(/^([|>])([+-])?$/u);
    if (block === null) {
      values.set(match[1], parseScalar(match[2]));
      continue;
    }
    const blockLines: string[] = [];
    let cursor = index + 1;
    while (cursor < closing) {
      const candidate = lines[cursor];
      if (candidate.length > 0 && !/^[ ]/u.test(candidate)) break;
      if (/^\t/u.test(candidate)) {
        throw invalidPackage("SKILL.md frontmatter block scalars must use spaces for indentation");
      }
      blockLines.push(candidate);
      cursor += 1;
    }
    if (blockLines.every((item) => item.trim().length === 0)) {
      throw invalidPackage(`SKILL.md frontmatter ${match[1]} block scalar is empty`);
    }
    values.set(match[1], parseBlockScalar(blockLines, block[1] as "|" | ">", block[2]));
    index = cursor - 1;
  }
  const name = values.get("name")?.trim() ?? "";
  const description = values.get("description")?.trim() ?? "";
  if (!SKILL_NAME_PATTERN.test(name) || name.length > 80) {
    throw invalidPackage("SKILL.md frontmatter name must use lowercase kebab-case and be at most 80 characters");
  }
  if (description.length === 0 || description.length > 2_000) {
    throw invalidPackage("SKILL.md frontmatter description must contain between 1 and 2000 characters");
  }
  return { name, description };
}

function parseBlockScalar(lines: readonly string[], style: "|" | ">", chomping: string | undefined): string {
  const nonEmptyIndents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^ */u)?.[0].length ?? 0);
  const indentation = Math.min(...nonEmptyIndents);
  if (indentation === 0) {
    throw invalidPackage("SKILL.md frontmatter block scalar content must be indented");
  }
  const contentLines = lines.map((line) => line.trim().length === 0 ? "" : line.slice(indentation));
  const body = style === "|" ? contentLines.join("\n") : foldBlockLines(contentLines);
  if (chomping === "-") return body.replace(/\n+$/u, "");
  if (chomping === "+") return `${body}\n`;
  return `${body.replace(/\n+$/u, "")}\n`;
}

function foldBlockLines(lines: readonly string[]): string {
  let value = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    value += line;
    if (index === lines.length - 1) continue;
    value += line.length === 0 || lines[index + 1].length === 0 ? "\n" : " ";
  }
  return value;
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      throw invalidPackage("SKILL.md contains invalid quoted frontmatter");
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function toPackagePath(root: string, absolute: string): string {
  const value = relative(root, absolute);
  if (value === "" || value.startsWith(`..${sep}`) || value === "..") {
    throw invalidPackage("Skill package traversal escaped its root");
  }
  return value.split(sep).join("/");
}

function invalidPackage(message: string): AppError {
  return new AppError("SKILL_PACKAGE_INVALID", message, 422);
}
