import { mkdtemp, mkdir, writeFile, rename, rm, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { inspectSkillPackage } from "@zhujun/agentloop";

export class LocalManagementError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export interface SkillImportFile { readonly path: string; readonly content: Buffer }
const fail = (): never => { throw new LocalManagementError(400, "skill_import_invalid"); };
const MAX_TOTAL = 32 * 1024 * 1024, MAX_FILE = 8 * 1024 * 1024, MAX_FILES = 1000;
function safePath(value: string): string {
  if (typeof value !== "string" || value.length > 500 || /[\\\x00-\x1f:]/.test(value)) return fail();
  const parts = value.normalize("NFC").split("/");
  if (parts.some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) || [".git", "node_modules"].includes(p))) return fail();
  return parts.join("/");
}
// Finder ZIPs contain an additional top-level tree of AppleDouble sidecars.
// Validate every input first, then exclude only well-known packaging metadata.
function isMacMetadataPath(path: string): boolean {
  const parts = path.split("/");
  return parts[0] === "__MACOSX" || parts.at(-1) === ".DS_Store";
}
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
/** Bounded ordinary ZIP reader. No shell extraction, links, ZIP64, encryption or path rewriting. */
export function readSkillZip(bytes: Buffer): SkillImportFile[] {
  try {
    if (bytes.length > 16 * 1024 * 1024 || bytes.length < 22) return fail();
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) return fail();
    if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)) return fail();
    const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
    if (!count || count > MAX_FILES || offset + size !== end) return fail();
    let cursor = offset, total = 0; const files: SkillImportFile[] = [], names = new Set<string>(), ranges: [number, number][] = [];
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) return fail();
      const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
      const compressed = bytes.readUInt32LE(cursor + 20), length = bytes.readUInt32LE(cursor + 24);
      const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
      const mode = bytes.readUInt32LE(cursor + 38) >>> 16, local = bytes.readUInt32LE(cursor + 42);
      if (flags & ~0x0808 || ![0, 8].includes(method) || length > MAX_FILE || bytes.readUInt16LE(cursor + 34) || cursor + 46 + nameLength + extra + comment > end) return fail();
      const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
      if (!(flags & 0x800) && rawName.some(b => b > 127)) return fail();
      const directory = name.endsWith("/"); const path = safePath(directory ? name.slice(0, -1) : name);
      if (names.has(path.toLowerCase()) || ((mode & 0xf000) && (mode & 0xf000) !== (directory ? 0x4000 : 0x8000))) return fail();
      names.add(path.toLowerCase());
      if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) return fail();
      const localNameLength = bytes.readUInt16LE(local + 26), start = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
      if (!bytes.subarray(local + 30, local + 30 + localNameLength).equals(rawName) || start + compressed > offset || ranges.some(([a, b]) => local < b && start + compressed > a)) return fail();
      ranges.push([local, start + compressed]); total += length;
      if (total > MAX_TOTAL || length > Math.max(1_048_576, compressed * 100)) return fail();
      const source = bytes.subarray(start, start + compressed);
      const content = method === 0 ? Buffer.from(source) : inflateRawSync(source, { maxOutputLength: Math.max(1, Math.min(MAX_FILE, length + 1)) });
      if (content.length !== length || crc32(content) !== crc || (directory && length)) return fail();
      if (!directory) files.push({ path, content });
      cursor += 46 + nameLength + extra + comment;
    }
    if (cursor !== end) return fail();
    return files;
  } catch { return fail(); }
}

/** Each installed package is content-addressed. Only staging paths are removed on failure. */
export async function importSkillFiles(library: string, files: readonly SkillImportFile[]) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) return fail();
  let total = 0; const folded = new Set<string>();
  const normalized = files.map(file => {
    const path = safePath(file.path); total += file.content.length;
    if (!Buffer.isBuffer(file.content) || file.content.length > MAX_FILE || total > MAX_TOTAL || folded.has(path.toLowerCase())) return fail();
    folded.add(path.toLowerCase()); return { path, content: file.content };
  }).filter(file => !isMacMetadataPath(file.path));
  const roots = normalized.map(file => file.path).filter(p => p === "SKILL.md" || p.endsWith("/SKILL.md")).map(p => p.slice(0, -8));
  if (!roots.length || normalized.some(f => roots.filter(root => f.path.startsWith(root)).length !== 1)) return fail();
  await mkdir(library, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(library, ".import-"));
  try {
    for (const file of normalized) {
      const path = join(staging, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.content, { flag: "wx", mode: 0o600 });
    }
    const inspections = await Promise.all(roots.map(root => inspectSkillPackage(join(staging, root))));
    if (new Set(inspections.map(item => item.name)).size !== inspections.length) return fail();
    const installed = [];
    for (const inspection of inspections) {
      const storageKey = `uploaded-${inspection.packageHash}`, target = join(library, storageKey);
      if (await lstat(target).catch(() => undefined)) {
        const current = await inspectSkillPackage(target);
        if (current.packageHash !== inspection.packageHash) throw new LocalManagementError(409, "skill_package_changed");
      } else await rename(inspection.root, target);
      installed.push({ storageKey, root: target, inspection });
    }
    return installed;
  } catch (error) { if (error instanceof LocalManagementError) throw error; return fail(); }
  finally { await rm(staging, { recursive: true, force: true }); }
}
