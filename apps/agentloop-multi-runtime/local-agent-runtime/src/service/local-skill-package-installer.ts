import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
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

/** Installs a user-owned ZIP on this device, including its private configuration. */
export class LocalSkillPackageInstaller {
  private readonly packageRoot: string;

  constructor(packageRoot: string) { this.packageRoot = packageRoot; }

  async installZip(content: Buffer, originalName: string): Promise<InstalledLocalSkillPackage> {
    if (content.length < 1 || content.length > MAX_ARCHIVE_BYTES || !originalName.toLowerCase().endsWith(".zip")) {
      throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
    }
    const zip = await JSZip.loadAsync(content, { checkCRC32: true, createFolders: false }).catch(() => {
      throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
    });
    const files = Object.values(zip.files).filter((entry) => !entry.dir);
    if (files.length < 1 || files.length > MAX_FILES) throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
    await mkdir(this.packageRoot, { recursive: true, mode: 0o700 });
    const stagingParent = join(this.packageRoot, ".staging");
    await mkdir(stagingParent, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(stagingParent, "upload-"));
    try {
      let totalBytes = 0;
      for (const entry of files) {
        const packagePath = safePackagePath(entry.unsafeOriginalName ?? entry.name);
        assertRegularZipEntry(entry);
        const data = await entry.async("nodebuffer");
        if (data.length > MAX_FILE_BYTES) throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
        totalBytes += data.length;
        if (totalBytes > MAX_TOTAL_BYTES || totalBytes > Math.max(content.length * MAX_COMPRESSION_RATIO, 1024 * 1024)) {
          throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
        }
        const target = resolve(staging, ...packagePath.split("/"));
        assertInside(staging, target);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, data, { mode: 0o600, flag: "wx" });
      }
      const sourceRoot = await packageSourceRoot(staging);
      const inspection = await inspectSkillPackage(sourceRoot).catch(() => {
        throw new LocalSkillPackageInstallError(400, "skill_upload_invalid");
      });
      const storageKey = `uploaded-${inspection.packageHash}`;
      const target = join(this.packageRoot, storageKey);
      const installed = await inspectSkillPackage(target).catch(() => undefined);
      if (installed !== undefined) {
        if (installed.packageHash !== inspection.packageHash) throw new LocalSkillPackageInstallError(409, "skill_package_storage_conflict");
        return { storageKey, root: installed.root, inspection: installed };
      }
      const copied = await copySkillPackage(inspection, target);
      return { storageKey, root: copied.root, inspection: copied };
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

async function packageSourceRoot(staging: string): Promise<string> {
  const entries = (await readdir(staging, { withFileTypes: true })).filter((entry) => entry.name !== "__MACOSX");
  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) return staging;
  if (entries.length === 1 && entries[0]!.isDirectory()) return join(staging, entries[0]!.name);
  throw new LocalSkillPackageInstallError(400, "skill_upload_package_layout_invalid");
}
