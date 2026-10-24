import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import { copySkillPackage, inspectSkillPackage, type SkillPackageInspection } from "@zhujun/agentloop";

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;

export interface InstalledLocalSkillPackage {
  readonly storageKey: string;
  readonly root: string;
  readonly inspection: SkillPackageInspection;
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
    if (content.length < 1 || content.length > MAX_ARCHIVE_BYTES || !originalName.toLowerCase().endsWith(".zip")) {
      throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
    }
    const zip = await JSZip.loadAsync(content, { checkCRC32: true, createFolders: false }).catch(() => {
      throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
    });
    const files = Object.values(zip.files).filter((entry) => !entry.dir);
    if (files.length < 1 || files.length > MAX_FILES) throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
    return await this.installFiles(files.map((entry) => ({
      path: entry.unsafeOriginalName ?? entry.name,
      content: entry.async("nodebuffer"),
      zipEntry: entry,
    })), content.length);
  }

  async installDirectory(files: readonly LocalSkillUploadFile[]): Promise<readonly InstalledLocalSkillPackage[]> {
    if (files.length < 1 || files.length > MAX_FILES) throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
    return await this.installFiles(files.map((file) => ({ path: file.path, content: file.content })));
  }

  private async installFiles(files: readonly { readonly path: string; readonly content: Buffer | Promise<Buffer>; readonly zipEntry?: JSZip.JSZipObject }[], compressedSize?: number): Promise<readonly InstalledLocalSkillPackage[]> {
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
        if (entry.zipEntry !== undefined) assertRegularZipEntry(entry.zipEntry);
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
          installedPackages.push({ storageKey, root: installed.root, inspection: installed });
          continue;
        }
        const copied = await copySkillPackage(inspection, target);
        installedPackages.push({ storageKey, root: copied.root, inspection: copied });
      }
      return installedPackages;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
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

function assertRegularZipEntry(entry: JSZip.JSZipObject): void {
  const permissions = typeof entry.unixPermissions === "number" ? entry.unixPermissions : 0;
  const fileType = permissions & 0o170000;
  if (fileType !== 0 && fileType !== 0o100000) throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
}

function assertInside(root: string, target: string): void {
  if (target === root || target.startsWith(`${root}${sep}`)) return;
  throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
}

async function packageSourceRoots(staging: string): Promise<readonly string[]> {
  const skillFiles = await findSkillEntrypoints(staging);
  if (skillFiles.length === 0) throw new LocalSkillPackageInstallError(400, "skill_upload_package_layout_invalid");
  const roots = skillFiles.map((path) => dirname(path));
  if (roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex && isPathInside(root, other)))) {
    throw new LocalSkillPackageInstallError(400, "skill_upload_package_layout_invalid");
  }
  if (roots.length > 1) {
    const files = await listStagedFiles(staging);
    if (files.some((file) => !roots.some((root) => isPathInside(root, file)))) {
      throw new LocalSkillPackageInstallError(400, "skill_upload_package_layout_invalid");
    }
  }
  return roots;
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
