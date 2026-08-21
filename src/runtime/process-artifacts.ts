import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { StoredRunEvent } from "./run-service.ts";

const MAX_PROCESS_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_PREVIEW_TEXT_CHARS = 80_000;
const MAX_PREVIEW_ROWS = 80;
const MAX_PREVIEW_COLUMNS = 24;
const COMMAND_ARTIFACT_EXTENSION_PATTERN = /(?:^|[\s'"(])([^\s'"),:;]+?\.(?:pdf|png|jpe?g|webp|gif|svg|html?|md|txt|csv|json|docx|pptx|xlsx))(?=$|[\s'"),:;])/giu;

export interface ProcessArtifact {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly sourceTool: "computer_write_file" | "computer_run_command";
  readonly previewable: boolean;
}

export type ProcessArtifactPreview =
  | {
    readonly kind: "text";
    readonly name: string;
    readonly mimeType: string;
    readonly text: string;
    readonly truncated: boolean;
  }
  | {
    readonly kind: "docx";
    readonly name: string;
    readonly paragraphs: readonly string[];
    readonly truncated: boolean;
  }
  | {
    readonly kind: "xlsx";
    readonly name: string;
    readonly sheets: readonly {
      readonly name: string;
      readonly rows: readonly (readonly string[])[];
      readonly truncated: boolean;
    }[];
  }
  | {
    readonly kind: "binary";
    readonly name: string;
    readonly mimeType: string;
  };

export async function collectProcessArtifacts(input: {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly runCreatedAt: number;
  readonly events: readonly StoredRunEvent[];
}): Promise<ProcessArtifact[]> {
  const candidates = collectCandidatePaths(input.events);
  const artifacts: ProcessArtifact[] = [];
  for (const candidate of candidates) {
    const file = await inspectCandidate(input.workspaceRoot, input.runCreatedAt, candidate.path);
    if (file === undefined) continue;
    const path = file.path;
    artifacts.push({
      id: artifactId(input.runId, path),
      path,
      name: basename(path),
      bytes: file.bytes,
      mimeType: mimeTypeFor(path),
      sourceTool: candidate.sourceTool,
      previewable: isPreviewable(path),
    });
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

export async function readProcessArtifact(input: {
  readonly artifact: ProcessArtifact;
  readonly workspaceRoot: string;
}): Promise<Buffer> {
  const target = await resolveWorkspaceFile(input.workspaceRoot, input.artifact.path);
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > MAX_PROCESS_ARTIFACT_BYTES) {
    throw new Error("Process artifact is unavailable");
  }
  return fs.readFile(target);
}

export async function previewProcessArtifact(input: {
  readonly artifact: ProcessArtifact;
  readonly workspaceRoot: string;
}): Promise<ProcessArtifactPreview> {
  const content = await readProcessArtifact(input);
  const extension = extensionFor(input.artifact.path);
  if (extension === "docx") {
    return {
      kind: "docx",
      name: input.artifact.name,
      ...previewDocx(content),
    };
  }
  if (extension === "xlsx") {
    return {
      kind: "xlsx",
      name: input.artifact.name,
      sheets: previewXlsx(content),
    };
  }
  if (isTextPreview(input.artifact.mimeType, extension)) {
    const text = content.toString("utf8");
    return {
      kind: "text",
      name: input.artifact.name,
      mimeType: input.artifact.mimeType,
      text: text.length > MAX_PREVIEW_TEXT_CHARS ? text.slice(0, MAX_PREVIEW_TEXT_CHARS) : text,
      truncated: text.length > MAX_PREVIEW_TEXT_CHARS,
    };
  }
  return {
    kind: "binary",
    name: input.artifact.name,
    mimeType: input.artifact.mimeType,
  };
}

export function artifactId(runId: string, path: string): string {
  return createHash("sha256").update(`${runId}\0${path}`).digest("hex");
}

function collectCandidatePaths(events: readonly StoredRunEvent[]): Array<{
  path: string;
  sourceTool: "computer_write_file" | "computer_run_command";
}> {
  const candidates = new Map<string, "computer_write_file" | "computer_run_command">();
  for (const event of events) {
    if (event.type !== "tool.completed") continue;
    const toolName = typeof event.data.toolName === "string" ? event.data.toolName : "";
    const result = parseResult(event.data.result);
    if (toolName === "computer_write_file") {
      const path = result !== undefined && typeof result.path === "string" ? result.path : undefined;
      if (path !== undefined && isSafeRelativePath(path)) candidates.set(path, "computer_write_file");
      continue;
    }
    if (toolName !== "computer_run_command" || result?.exitCode !== 0 || typeof result.stdout !== "string") continue;
    for (const path of pathsMentionedInCommandOutput(result.stdout)) {
      if (!candidates.has(path)) candidates.set(path, "computer_run_command");
    }
  }
  return [...candidates.entries()].map(([path, sourceTool]) => ({ path, sourceTool }));
}

function parseResult(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function pathsMentionedInCommandOutput(stdout: string): string[] {
  const paths = new Set<string>();
  for (const match of stdout.matchAll(COMMAND_ARTIFACT_EXTENSION_PATTERN)) {
    const path = match[1];
    if (path !== undefined && path.length > 0 && !path.includes("\0")) paths.add(path);
  }
  return [...paths];
}

async function inspectCandidate(
  workspaceRoot: string,
  runCreatedAt: number,
  path: string,
): Promise<{ path: string; bytes: number } | undefined> {
  try {
    const resolved = await resolveWorkspacePath(workspaceRoot, path);
    const target = resolved.absolutePath;
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_PROCESS_ARTIFACT_BYTES || stat.mtimeMs + 1_000 < runCreatedAt) return undefined;
    return { path: resolved.relativePath, bytes: stat.size };
  } catch {
    return undefined;
  }
}

async function resolveWorkspaceFile(workspaceRoot: string, path: string): Promise<string> {
  return (await resolveWorkspacePath(workspaceRoot, path)).absolutePath;
}

async function resolveWorkspacePath(workspaceRoot: string, path: string): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  if (path.length === 0 || path.includes("\0")) throw new Error("Invalid artifact path");
  if (!isAbsolute(path) && !isSafeRelativePath(path)) throw new Error("Invalid artifact path");
  const root = await fs.realpath(workspaceRoot);
  const target = await fs.realpath(isAbsolute(path) ? path : resolve(root, path));
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Artifact escapes workspace");
  }
  const normalized = fromRoot.split(sep).join("/");
  if (!isSafeRelativePath(normalized)) throw new Error("Invalid artifact path");
  return { absolutePath: target, relativePath: normalized };
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.includes("\0")) return false;
  const normalized = path.replaceAll("\\", "/");
  return !normalized.split("/").some((part) => part === "" || part === "." || part === "..");
}

function mimeTypeFor(path: string): string {
  const extension = extensionFor(path);
  const types: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
    html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
    csv: "text/csv; charset=utf-8", json: "application/json; charset=utf-8",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return types[extension] ?? "application/octet-stream";
}

function isPreviewable(path: string): boolean {
  return /\.(?:pdf|png|jpe?g|webp|gif|svg|html?|md|txt|csv|json|docx|xlsx)$/i.test(path);
}

function extensionFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
}

function isTextPreview(mimeType: string, extension: string): boolean {
  if (/text\/(?:markdown|plain|csv|html)/.test(mimeType) || /application\/json/.test(mimeType)) return true;
  return extension === "md" || extension === "txt" || extension === "csv" || extension === "json" || extension === "html" || extension === "htm";
}

function previewDocx(content: Buffer): { paragraphs: readonly string[]; truncated: boolean } {
  const files = readZipEntries(content);
  const documentXml = files.get("word/document.xml");
  if (documentXml === undefined) return { paragraphs: [], truncated: false };
  const paragraphs = [...documentXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
    .map((match) => xmlTextFromWordParagraph(match[0]))
    .filter((text) => text.length > 0);
  const truncated = paragraphs.join("\n").length > MAX_PREVIEW_TEXT_CHARS;
  const selected: string[] = [];
  let chars = 0;
  for (const paragraph of paragraphs) {
    if (chars + paragraph.length > MAX_PREVIEW_TEXT_CHARS) break;
    selected.push(paragraph);
    chars += paragraph.length + 1;
  }
  return { paragraphs: selected, truncated };
}

function previewXlsx(content: Buffer): readonly {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
  readonly truncated: boolean;
}[] {
  const files = readZipEntries(content);
  const sharedStrings = parseSharedStrings(files.get("xl/sharedStrings.xml") ?? "");
  const sheetNames = parseWorkbookSheetNames(files.get("xl/workbook.xml") ?? "");
  const sheets: Array<{ name: string; rows: readonly (readonly string[])[]; truncated: boolean }> = [];
  const worksheetEntries = [...files.entries()]
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort(([left], [right]) => left.localeCompare(right, "en", { numeric: true }));
  for (let index = 0; index < worksheetEntries.length && sheets.length < 5; index++) {
    const [, xml] = worksheetEntries[index]!;
    const rows = parseWorksheetRows(xml, sharedStrings);
    sheets.push({
      name: sheetNames[index] ?? `Sheet ${index + 1}`,
      rows: rows.slice(0, MAX_PREVIEW_ROWS),
      truncated: rows.length > MAX_PREVIEW_ROWS,
    });
  }
  return sheets;
}

function readZipEntries(content: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  const eocd = findEndOfCentralDirectory(content);
  if (eocd < 0) return entries;
  const centralDirectorySize = content.readUInt32LE(eocd + 12);
  const centralDirectoryOffset = content.readUInt32LE(eocd + 16);
  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;
  while (offset + 46 <= end && content.readUInt32LE(offset) === 0x02014b50) {
    const compression = content.readUInt16LE(offset + 10);
    const compressedSize = content.readUInt32LE(offset + 20);
    const uncompressedSize = content.readUInt32LE(offset + 24);
    const fileNameLength = content.readUInt16LE(offset + 28);
    const extraLength = content.readUInt16LE(offset + 30);
    const commentLength = content.readUInt16LE(offset + 32);
    const localHeaderOffset = content.readUInt32LE(offset + 42);
    const name = content.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    const data = readZipFileData(content, localHeaderOffset, compression, compressedSize, uncompressedSize);
    if (data !== undefined) entries.set(name, data.toString("utf8"));
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(content: Buffer): number {
  const minimum = Math.max(0, content.length - 65_557);
  for (let offset = content.length - 22; offset >= minimum; offset--) {
    if (content.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function readZipFileData(
  content: Buffer,
  localHeaderOffset: number,
  compression: number,
  compressedSize: number,
  uncompressedSize: number,
): Buffer | undefined {
  if (localHeaderOffset + 30 > content.length || content.readUInt32LE(localHeaderOffset) !== 0x04034b50) return undefined;
  const fileNameLength = content.readUInt16LE(localHeaderOffset + 26);
  const extraLength = content.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressed = content.subarray(dataStart, dataStart + compressedSize);
  if (compression === 0) return compressed.subarray(0, uncompressedSize);
  if (compression === 8) return inflateRawSync(compressed);
  return undefined;
}

function xmlTextFromWordParagraph(xml: string): string {
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)]
    .map((match) => {
      if (match[0].startsWith("<w:tab")) return "\t";
      if (match[0].startsWith("<w:br")) return "\n";
      return decodeXml(match[1] ?? "");
    })
    .join("")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function parseSharedStrings(xml: string): string[] {
  if (xml === "") return [];
  return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((match) => xmlText(match[0]));
}

function parseWorkbookSheetNames(xml: string): string[] {
  if (xml === "") return [];
  return [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((match) => decodeXml(match[1] ?? ""));
}

function parseWorksheetRows(xml: string, sharedStrings: readonly string[]): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cellMatch of rowMatch[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1] ?? "";
      const cellXml = cellMatch[2] ?? "";
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const index = ref === undefined ? row.length : columnIndex(ref);
      row[index] = cellValue(attrs, cellXml, sharedStrings);
    }
    while (row.length > 0 && (row[row.length - 1] ?? "") === "") row.pop();
    rows.push(row.slice(0, MAX_PREVIEW_COLUMNS).map((value) => value ?? ""));
  }
  return rows;
}

function cellValue(attrs: string, cellXml: string, sharedStrings: readonly string[]): string {
  if (/\bt="s"/.test(attrs)) {
    const raw = /<v>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] ?? "";
    const index = Number(raw);
    return Number.isInteger(index) ? (sharedStrings[index] ?? "") : "";
  }
  if (/\bt="inlineStr"/.test(attrs)) return xmlText(cellXml);
  return decodeXml(/<v>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] ?? "");
}

function columnIndex(value: string): number {
  let index = 0;
  for (const char of value) index = index * 26 + char.charCodeAt(0) - 64;
  return Math.max(0, index - 1);
}

function xmlText(xml: string): string {
  return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1] ?? "")).join("");
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
