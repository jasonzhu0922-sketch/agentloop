import JSZip from "jszip";

export const SKILL_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 90 * 1024 * 1024,
  maxFiles: 2000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 100,
});

/** Canonical ZIP audit shared by production, cloud development, and Local Agent uploads. */
export async function validateSkillArchive(content, { originalName, allowPrivateFiles = false, limits = SKILL_ARCHIVE_LIMITS } = {}) {
  if (!Buffer.isBuffer(content) || content.length < 1 || content.length > limits.maxArchiveBytes || typeof originalName !== "string" || !originalName.toLowerCase().endsWith(".zip")) throw invalid("skill_upload_invalid");
  const zip = await JSZip.loadAsync(content, { checkCRC32: true, createFolders: false }).catch(() => { throw invalid("skill_upload_invalid"); });
  const entries = Object.values(zip.files).filter(entry => !entry.dir && !isMacMetadataPath(entry.unsafeOriginalName ?? entry.name));
  if (entries.length < 1 || entries.length > limits.maxFiles) throw invalid("skill_upload_invalid");
  let totalBytes = 0;
  const paths = new Set();
  const audited = [];
  for (const entry of entries) {
    const sourcePath = entry.unsafeOriginalName ?? entry.name;
    const normalizedSourcePath = safeArchivePath(sourcePath);
    if (!allowPrivateFiles && (/(^|\/)\.env(?:\.|$)/i.test(normalizedSourcePath) || /\.(?:pem|key)$/i.test(normalizedSourcePath))) throw invalid("skill_upload_invalid");
    if (paths.has(normalizedSourcePath)) throw invalid("skill_upload_invalid");
    paths.add(normalizedSourcePath);
    assertRegularZipEntry(entry);
    const data = await entry.async("nodebuffer");
    totalBytes += data.length;
    if (data.length > limits.maxFileBytes || totalBytes > limits.maxTotalBytes || totalBytes > Math.max(content.length * limits.maxCompressionRatio, 1024 * 1024)) throw invalid("skill_upload_invalid");
    audited.push({ entry, sourcePath: normalizedSourcePath, data });
  }
  const prefix = [...paths].every(path => path.startsWith("custom-skills/")) ? "custom-skills/" : "";
  const normalized = audited.map(item => ({ ...item, path: prefix ? item.sourcePath.slice(prefix.length) : item.sourcePath }));
  const topLevelRoots = [...new Set(normalized.map(item => item.path.split("/")[0]))];
  if (topLevelRoots.some(root => !normalized.some(item => item.path === `${root}/SKILL.md`))) throw invalid("skill_upload_package_layout_invalid");
  return { entries: normalized, totalBytes };
}

export function isMacMetadataPath(value) {
  return typeof value === "string" && (value === ".DS_Store" || value.endsWith("/.DS_Store") || value.startsWith("__MACOSX/"));
}

export function safeArchivePath(value) {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw invalid("skill_upload_invalid");
  const parts = value.split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) throw invalid("skill_upload_invalid");
  return parts.join("/");
}

function assertRegularZipEntry(entry) {
  const permissions = typeof entry.unixPermissions === "number" ? entry.unixPermissions : 0;
  const fileType = permissions & 0o170000;
  if (fileType !== 0 && fileType !== 0o100000) throw invalid("skill_upload_invalid");
}

function invalid(message) { const error = new Error(message); error.code = message; return error; }
