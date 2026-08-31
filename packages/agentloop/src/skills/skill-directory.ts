import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { AppError } from "../shared/errors.ts";
import { inspectSkillPackage } from "./skill-package.ts";
import type { SkillPackageInspection } from "./skill-package.ts";

const SOURCE_LOCK_SCHEMA = "agentloop.upstreamSkillSource/v1";
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface SkillDirectoryEntry {
  readonly sourceDirectory: string;
  /**
   * Optional upstream provenance from a sibling `.source.json` file.
   *
   * Provenance is useful when available, but a package's eligibility is
   * determined by its standard Skill-package structure and package integrity.
   */
  readonly sourceLockPath?: string;
  readonly sourceUrl?: string;
  readonly sourceRevision?: string;
  readonly inspection: SkillPackageInspection;
}

interface SkillSourceLock {
  readonly schema: string;
  readonly repository: string;
  readonly revision: string;
  readonly packageHashAlgorithm: string;
  readonly packageSha256: string;
  readonly packageFileCount: number;
  readonly packageTotalBytes: number;
  readonly skillMdSha256: string;
}

/**
 * Discover Skill packages from one explicit directory.
 *
 * Each immediate child directory must be a standard Skill package. A sibling
 * `<directory>.source.json` may optionally provide verified provenance without
 * changing the package bytes or acting as an admission requirement.
 */
export async function discoverSkillDirectory(directory: string): Promise<SkillDirectoryEntry[]> {
  const root = await fs.realpath(resolve(directory)).catch(() => {
    throw invalidDirectory("Configured Skill directory does not exist");
  });
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw invalidDirectory("Configured Skill directory must be a directory");

  const children = (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const discovered: SkillDirectoryEntry[] = [];
  for (const child of children) {
    if (child.isSymbolicLink()) throw invalidDirectory("Skill directory entries must not be symbolic links");
    if (!child.isDirectory()) continue;
    if (await isExplicitlyDisabled(root, child.name)) continue;
    const sourceDirectory = resolve(root, child.name);
    const inspection = await inspectSkillPackage(sourceDirectory).catch((error) => {
      if (error instanceof AppError) {
        throw invalidDirectory(`Invalid Skill package at ${sourceDirectory}: ${error.message}`);
      }
      throw error;
    });
    if (inspection.name !== child.name) {
      throw invalidDirectory(
        `Skill directory ${child.name} does not match SKILL.md name ${inspection.name}`,
      );
    }
    const source = await readVerifiedSourceLock(
      resolve(root, `${child.name}.source.json`),
      inspection,
      child.name,
    );
    discovered.push({
      sourceDirectory: inspection.root,
      inspection,
      ...(source === undefined ? {} : source),
    });
  }

  const names = discovered.map((entry) => entry.inspection.name);
  if (new Set(names).size !== names.length) {
    throw invalidDirectory("Configured Skill directory contains duplicate Skill names");
  }
  return discovered;
}

async function isExplicitlyDisabled(root: string, directoryName: string): Promise<boolean> {
  const disabledPath = resolve(root, `${directoryName}.disabled.json`);
  const source = await fs.readFile(disabledPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (source === undefined) return false;
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw invalidDirectory(`Disabled Skill declaration is not valid JSON: ${disabledPath}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidDirectory(`Disabled Skill declaration must be an object: ${disabledPath}`);
  }
  const declaration = value as Record<string, unknown>;
  if (
    declaration.schema !== "agentloop.disabledSkillSource/v1"
    || declaration.name !== directoryName
    || typeof declaration.reason !== "string"
    || declaration.reason.trim().length === 0
  ) {
    throw invalidDirectory(`Disabled Skill declaration is invalid: ${disabledPath}`);
  }
  return true;
}

async function readVerifiedSourceLock(
  path: string,
  inspection: SkillPackageInspection,
  directoryName: string,
): Promise<Pick<SkillDirectoryEntry, "sourceLockPath" | "sourceUrl" | "sourceRevision"> | undefined> {
  const source = await fs.readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (source === undefined || Buffer.byteLength(source) > 64 * 1024) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const lock = value as SkillSourceLock;
  const sourceUrl = normalizeHttpsUrl(lock.repository);
  if (!isMatchingSourceLock(lock, inspection) || sourceUrl === undefined) return undefined;
  return { sourceLockPath: path, sourceUrl, sourceRevision: lock.revision };
}

function isMatchingSourceLock(
  lock: SkillSourceLock,
  inspection: SkillPackageInspection,
): boolean {
  const skillMdSha256 = createHash("sha256").update(inspection.instructions).digest("hex");
  return lock.schema === SOURCE_LOCK_SCHEMA
    && SOURCE_REVISION_PATTERN.test(lock.revision)
    && lock.packageHashAlgorithm === "agentloop.skillPackage/v1"
    && SHA256_PATTERN.test(lock.packageSha256)
    && lock.packageSha256 === inspection.packageHash
    && lock.packageFileCount === inspection.fileCount
    && lock.packageTotalBytes === inspection.totalBytes
    && SHA256_PATTERN.test(lock.skillMdSha256)
    && lock.skillMdSha256 === skillMdSha256;
}

function normalizeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  url.hash = "";
  return url.toString();
}

function invalidDirectory(message: string): AppError {
  return new AppError("SKILL_PACKAGE_INVALID", message, 422);
}
