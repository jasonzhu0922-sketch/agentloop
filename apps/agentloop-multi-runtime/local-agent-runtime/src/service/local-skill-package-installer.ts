import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  copySkillPackage,
  detectSkillDeclaration,
  declarationFromLegacyMetadata,
  inspectSkillPackage,
  serializeSkillDeclaration,
  type SkillDeclarationSource,
  type SkillPackageInspection,
} from "@zhujun/agentloop";
import { validateSkillArchive } from "../../../web/skill-archive-validator.mjs";

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;

export interface InstalledLocalSkillPackage {
  readonly storageKey: string;
  readonly root: string;
  readonly inspection: SkillPackageInspection;
  readonly metadataSource: SkillDeclarationSource;
}

export interface LocalSkillUploadFile {
  readonly path: string;
  readonly content: Buffer;
}

/** Installs user-owned Skill archives or selected directories on this device, including private configuration. */
export class LocalSkillPackageInstaller {
  private readonly packageRoot: string;

  constructor(packageRoot: string) { this.packageRoot = packageRoot; }

  async installZip(content: Buffer, originalName: string): Promise<readonly InstalledLocalSkillPackage[]> {
    let audited: Awaited<ReturnType<typeof validateSkillArchive>>;
    try {
      audited = await validateSkillArchive(content, { originalName, allowPrivateFiles: true, limits: { maxArchiveBytes: MAX_ARCHIVE_BYTES, maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, maxCompressionRatio: MAX_COMPRESSION_RATIO } });
    } catch (error) {
      throw new LocalSkillPackageInstallError(400, error instanceof Error ? error.message : "skill_upload_invalid");
    }
    return await this.installFiles(audited.entries.map((entry) => ({ path: entry.path, content: entry.data })), content.length);
  }

  async installDirectory(files: readonly LocalSkillUploadFile[]): Promise<readonly InstalledLocalSkillPackage[]> {
    if (files.length < 1 || files.length > MAX_FILES) throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
    return await this.installFiles(files.map((file) => ({ path: file.path, content: file.content })));
  }

  private async installFiles(files: readonly { readonly path: string; readonly content: Buffer | Promise<Buffer> }[], compressedSize?: number): Promise<readonly InstalledLocalSkillPackage[]> {
    await mkdir(this.packageRoot, { recursive: true, mode: 0o700 });
    const stagingParent = join(this.packageRoot, ".staging");
    await mkdir(stagingParent, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(stagingParent, "upload-"));
    try {
      let totalBytes = 0;
      const stagedPaths = new Set<string>();
      for (const entry of files) {
        const packagePath = safePackagePath(entry.path);
        if (!stagedPaths.add(packagePath)) throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
        const data = await entry.content;
        if (data.length > MAX_FILE_BYTES) throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
        totalBytes += data.length;
        if (totalBytes > MAX_TOTAL_BYTES || (compressedSize !== undefined && totalBytes > Math.max(compressedSize * MAX_COMPRESSION_RATIO, 1024 * 1024))) {
          throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
        }
        const target = resolve(staging, ...packagePath.split("/"));
        assertInside(staging, target);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, data, { mode: 0o600, flag: "wx" });
      }
      const sourceRoots = await packageSourceRoots(staging);
      const metadataSources = await Promise.all(sourceRoots.map((sourceRoot) => materializeSkillDeclaration(sourceRoot)));
      const inspections = await Promise.all(sourceRoots.map(async (sourceRoot) => await inspectSkillPackage(sourceRoot).catch(() => {
        throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
      })));
      const storageKeys = new Set<string>();
      for (const inspection of inspections) {
        const storageKey = `uploaded-${inspection.packageHash}`;
        if (!storageKeys.add(storageKey)) throw new LocalSkillPackageInstallError(409, "skill_package_storage_conflict");
        const target = join(this.packageRoot, storageKey);
        const installed = await inspectSkillPackage(target).catch(() => undefined);
        if (installed !== undefined && installed.packageHash !== inspection.packageHash) {
          throw new LocalSkillPackageInstallError(409, "skill_package_storage_conflict");
        }
      }
      const installedPackages: InstalledLocalSkillPackage[] = [];
      for (const inspection of inspections) {
        const storageKey = `uploaded-${inspection.packageHash}`;
        const target = join(this.packageRoot, storageKey);
        const installed = await inspectSkillPackage(target).catch(() => undefined);
        if (installed !== undefined) {
          installedPackages.push({ storageKey, root: installed.root, inspection: installed, metadataSource: metadataSources[installedPackages.length] ?? "package" });
          continue;
        }
        const copied = await copySkillPackage(inspection, target);
        installedPackages.push({ storageKey, root: copied.root, inspection: copied, metadataSource: metadataSources[installedPackages.length] ?? "package" });
      }
      return installedPackages;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

/**
 * Uploads are the migration boundary. A package with no sidecar receives a
 * deterministic declaration proposal before it is copied into the immutable
 * package store. Legacy frontmatter is read once and removed from SKILL.md;
 * the sidecar becomes the package-owned metadata authority.
 */
async function materializeSkillDeclaration(root: string): Promise<SkillDeclarationSource> {
  const before = await inspectSkillPackage(root);
  if (before.declarationSource === "package") return "package";
  const declaration = before.agentLoop === undefined
    ? detectSkillDeclaration(before.name, before.description, before.instructions, before.files, before.files.includes("agentloop.executors.json"))
    : declarationFromLegacyMetadata(before.name, before.description, before.agentLoop, before.files.includes("agentloop.executors.json"));
  await writeFile(join(root, "agentloop.skill.json"), serializeSkillDeclaration(declaration), { mode: 0o600 });
  if (before.declarationSource === "legacy-frontmatter") {
    await writeFile(join(root, "SKILL.md"), removeLegacyAgentLoopBlock(before.instructions), { mode: 0o600 });
  }
  return before.declarationSource === "legacy-frontmatter" ? "legacy-frontmatter" : "detected";
}

function removeLegacyAgentLoopBlock(source: string): string {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => /^agentloop:\s*$/u.test(line));
  if (start < 0) return source;
  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim().length === 0 || /^[ ]{2,}/u.test(lines[end]!))) end += 1;
  const output = [...lines.slice(0, start), ...lines.slice(end)];
  return output.join("\n");
}

export class LocalSkillPackageInstallError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function safePackagePath(value: string): string {
  if (value.includes("\0") || value.includes("\\") || isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
  }
  const normalized = normalize(value).replaceAll(sep, "/");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
  }
  return normalized;
}

function assertInside(root: string, target: string): void {
  if (target === root || target.startsWith(`${root}${sep}`)) return;
  throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
}

async function packageSourceRoots(staging: string): Promise<readonly string[]> {
  const skillFiles = await findSkillEntrypoints(staging);
  if (skillFiles.length === 0) throw new LocalSkillPackageInstallError(400, "skill_upload_package_layout_invalid");
  const roots = [...new Set(skillFiles.map((path) => dirname(path)))];
  // A Skill may contain a nested SKILL.md as part of its own workflow/assets
  // (for example yue2-music/instrumental/SKILL.md). Only the shallowest
  // entrypoint roots are package roots; nested entrypoints remain package files.
  const sourceRoots = roots.filter((root) => !roots.some((other) => other !== root && isPathInside(other, root)));
  if (sourceRoots.length > 1) {
    const files = await listStagedFiles(staging);
    if (files.some((file) => !sourceRoots.some((root) => isPathInside(root, file)))) {
      throw new LocalSkillPackageInstallError(400, "skill_upload_package_layout_invalid");
    }
  }
  return sourceRoots;
}

async function findSkillEntrypoints(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "__MACOSX") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "SKILL.md") found.push(path);
    }
  }
  await visit(root);
  return found;
}

async function listStagedFiles(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "__MACOSX") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) found.push(path);
    }
  }
  await visit(root);
  return found;
}

function isPathInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}
