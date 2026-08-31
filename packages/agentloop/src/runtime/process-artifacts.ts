import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { StoredRunEvent } from "./run-service.ts";

const MAX_PROCESS_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_PREVIEW_TEXT_CHARS = 80_000;
const MAX_PREVIEW_ROWS = 80;
const MAX_PREVIEW_COLUMNS = 24;
const MAX_PREVIEW_SLIDES = 60;
const DEFAULT_PPTX_WIDTH = 12_192_000;
const DEFAULT_PPTX_HEIGHT = 6_858_000;
const COMMAND_ARTIFACT_EXTENSION_PATTERN = /(?:^|[\s'"(])([^\s'"),:;]+?\.(?:pdf|png|jpe?g|webp|gif|svg|html?|md|txt|csv|json|docx|pptx|xlsx))(?=$|[\s'"),:;])/giu;

export interface ProcessArtifact {
  readonly runId: string;
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly sourceTool: ArtifactSourceTool;
  readonly previewable: boolean;
}

type ArtifactSourceTool = "computer_write_file" | "computer_run_command" | "materialize_paginated_html";

function sourceToolPriority(sourceTool: ArtifactSourceTool): number {
  if (sourceTool === "materialize_paginated_html") return 0;
  if (sourceTool === "computer_write_file") return 1;
  return 2;
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
    readonly kind: "pptx";
    readonly name: string;
    readonly slideCount: number;
    readonly width: number;
    readonly height: number;
    readonly slides: readonly {
      readonly index: number;
      readonly background?: string;
      readonly title?: string;
      readonly paragraphs: readonly string[];
      readonly elements: readonly PptxPreviewElement[];
    }[];
    readonly truncated: boolean;
  }
  | {
    readonly kind: "binary";
    readonly name: string;
    readonly mimeType: string;
  };

export type PptxPreviewElement =
  | {
    readonly kind: "shape";
    readonly preset?: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly fill: string;
    readonly opacity?: number;
    readonly stroke?: string;
    readonly strokeWidth?: number;
  }
  | {
    readonly kind: "text";
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly text: string;
    readonly fontSize?: number;
    readonly color?: string;
    readonly fill?: string;
    readonly lines?: readonly (readonly PptxPreviewTextRun[])[];
  };

export interface PptxPreviewTextRun {
  readonly text: string;
  readonly fontSize?: number;
  readonly color?: string;
}

export async function collectProcessArtifacts(input: {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly runCreatedAt: number;
  readonly events: readonly StoredRunEvent[];
}): Promise<ProcessArtifact[]> {
  const candidates = collectCandidatePaths(input.events);
  const artifacts = new Map<string, ProcessArtifact>();
  for (const candidate of candidates) {
    const file = await inspectCandidate(input.workspaceRoot, input.runCreatedAt, candidate.path);
    if (file === undefined) continue;
    const path = file.path;
    const artifact = {
      runId: input.runId,
      id: artifactId(input.runId, path),
      path,
      name: basename(path),
      bytes: file.bytes,
      mimeType: mimeTypeFor(path),
      sourceTool: candidate.sourceTool,
      previewable: isPreviewable(path),
    };
    const existing = artifacts.get(path);
    if (existing === undefined || sourceToolPriority(artifact.sourceTool) < sourceToolPriority(existing.sourceTool)) {
      artifacts.set(path, artifact);
    }
  }
  return [...artifacts.values()].sort((left, right) => left.path.localeCompare(right.path, "en"));
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
  if (extension === "pptx") {
    return {
      kind: "pptx",
      name: input.artifact.name,
      ...previewPptx(content),
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
  sourceTool: ArtifactSourceTool;
}> {
  const candidates = new Map<string, ArtifactSourceTool>();
  for (const event of events) {
    if (event.type !== "tool.completed") continue;
    const toolName = typeof event.data.toolName === "string" ? event.data.toolName : "";
    const result = parseResult(event.data.result);
    if (toolName === "computer_write_file" || toolName === "materialize_paginated_html") {
      const path = result !== undefined && typeof result.path === "string" ? result.path : undefined;
      if (path !== undefined && isSafeRelativePath(path)) candidates.set(path, toolName);
      continue;
    }
    if (toolName !== "computer_run_command" || result?.exitCode !== 0 || typeof result.stdout !== "string") continue;
    for (const path of artifactPathsFromCommandFileChanges(result)) {
      if (!candidates.has(path)) candidates.set(path, "computer_run_command");
    }
    for (const path of artifactPathsMentionedInCommandOutput(result.stdout)) {
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

export function artifactPathsMentionedInCommandOutput(stdout: string): string[] {
  const paths = new Set<string>();
  for (const match of stdout.matchAll(COMMAND_ARTIFACT_EXTENSION_PATTERN)) {
    const path = match[1];
    if (path !== undefined && path.length > 0 && !path.includes("\0")) paths.add(path);
  }
  return [...paths];
}

export function artifactPathsFromCommandFileChanges(result: Readonly<Record<string, unknown>>): string[] {
  const paths = new Set<string>();
  const changes = Array.isArray(result.fileChanges) ? result.fileChanges : [];
  for (const change of changes) {
    if (change === null || typeof change !== "object" || Array.isArray(change)) continue;
    const record = change as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : undefined;
    const changeType = typeof record.changeType === "string" ? record.changeType : undefined;
    if (path === undefined || path.length === 0 || path.includes("\0") || changeType === "deleted") continue;
    paths.add(path);
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
  return /\.(?:pdf|png|jpe?g|webp|gif|svg|html?|md|txt|csv|json|docx|pptx|xlsx)$/i.test(path);
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

function previewPptx(content: Buffer): {
  readonly slideCount: number;
  readonly width: number;
  readonly height: number;
  readonly slides: readonly {
    readonly index: number;
    readonly background?: string;
    readonly title?: string;
    readonly paragraphs: readonly string[];
    readonly elements: readonly PptxPreviewElement[];
  }[];
  readonly truncated: boolean;
} {
  const files = readZipEntries(content);
  const size = presentationSlideSize(files.get("ppt/presentation.xml") ?? "");
  const slidePaths = presentationSlidePaths(files);
  const slides: Array<{
    index: number;
    background?: string;
    title?: string;
    paragraphs: readonly string[];
    elements: readonly PptxPreviewElement[];
  }> = [];
  let chars = 0;
  let truncated = slidePaths.length > MAX_PREVIEW_SLIDES;
  for (let index = 0; index < slidePaths.length && slides.length < MAX_PREVIEW_SLIDES; index++) {
    const xml = files.get(slidePaths[index]!);
    if (xml === undefined) continue;
    const paragraphs = pptxSlideParagraphs(xml);
    const elements = pptxSlideElements(xml);
    const background = pptxBackgroundColor(xml);
    const slideChars = paragraphs.join("\n").length;
    if (chars + slideChars > MAX_PREVIEW_TEXT_CHARS) {
      truncated = true;
      break;
    }
    slides.push({
      index: index + 1,
      ...(background === undefined ? {} : { background }),
      ...(paragraphs[0] === undefined ? {} : { title: paragraphs[0] }),
      paragraphs,
      elements,
    });
    chars += slideChars + 1;
  }
  return { slideCount: slidePaths.length, width: size.width, height: size.height, slides, truncated };
}

function presentationSlideSize(xml: string): { width: number; height: number } {
  const match = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(xml);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  return {
    width: Number.isFinite(width) && width > 0 ? width : DEFAULT_PPTX_WIDTH,
    height: Number.isFinite(height) && height > 0 ? height : DEFAULT_PPTX_HEIGHT,
  };
}

function presentationSlidePaths(files: ReadonlyMap<string, string>): string[] {
  const presentationXml = files.get("ppt/presentation.xml") ?? "";
  const relsXml = files.get("ppt/_rels/presentation.xml.rels") ?? "";
  const rels = new Map(
    [...relsXml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)]
      .map((match) => [match[1] ?? "", normalizePresentationTarget(match[2] ?? "")] as const)
      .filter(([id, target]) => id.length > 0 && target.length > 0),
  );
  const ordered = [...presentationXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
    .map((match) => rels.get(match[1] ?? ""))
    .filter((path): path is string => path !== undefined && files.has(path));
  if (ordered.length > 0) return ordered;
  return [...files.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

function normalizePresentationTarget(target: string): string {
  const normalized = target.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.startsWith("ppt/")) return normalized;
  if (normalized.startsWith("slides/")) return `ppt/${normalized}`;
  return "";
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

function pptxSlideParagraphs(xml: string): string[] {
  return [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
    .map((match) => xmlText(match[0]).trim())
    .filter((text) => text.length > 0);
}

function pptxSlideElements(xml: string): PptxPreviewElement[] {
  const elements: PptxPreviewElement[] = [];
  for (const match of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
    const shapeXml = match[0];
    const lines = pptxSlideTextLines(shapeXml);
    const text = lines.map((line) => line.map((run) => run.text).join("")).join("\n").trim();
    const geometry = pptxShapeGeometry(shapeXml);
    const fill = pptxFillColor(shapeXml);
    const preset = pptxShapePreset(shapeXml);
    const opacity = pptxFillOpacity(shapeXml);
    const stroke = pptxStrokeColor(shapeXml);
    const strokeWidth = pptxStrokeWidth(shapeXml);
    if (fill !== undefined) {
      elements.push({
        kind: "shape",
        ...geometry,
        ...(preset === undefined ? {} : { preset }),
        fill,
        ...(opacity === undefined ? {} : { opacity }),
        ...(stroke === undefined ? {} : { stroke }),
        ...(strokeWidth === undefined ? {} : { strokeWidth }),
      });
    }
    if (text.length === 0) continue;
    const firstRun = lines.flat().find((run) => run.text.trim().length > 0);
    const fontSize = firstRun?.fontSize ?? pptxFontSize(shapeXml);
    const color = firstRun?.color ?? pptxTextColor(shapeXml);
    elements.push({
      kind: "text",
      ...geometry,
      text,
      ...(fontSize === undefined ? {} : { fontSize }),
      ...(color === undefined ? {} : { color }),
      ...(fill === undefined ? {} : { fill }),
      ...(lines.length === 0 ? {} : { lines }),
    });
  }
  return elements;
}

function pptxBackgroundColor(xml: string): string | undefined {
  const background = /<p:bg\b[\s\S]*?<\/p:bg>/.exec(xml)?.[0] ?? "";
  return pptxColor(background);
}

function pptxShapeGeometry(xml: string): { x: number; y: number; width: number; height: number } {
  const xfrm = /<a:xfrm\b[\s\S]*?<\/a:xfrm>/.exec(xml)?.[0] ?? "";
  return {
    x: finiteNumber(/<a:off\b[^>]*\bx="(-?\d+)"/.exec(xfrm)?.[1], 0),
    y: finiteNumber(/<a:off\b[^>]*\by="(-?\d+)"/.exec(xfrm)?.[1], 0),
    width: positiveNumber(/<a:ext\b[^>]*\bcx="(\d+)"/.exec(xfrm)?.[1], DEFAULT_PPTX_WIDTH * 0.35),
    height: positiveNumber(/<a:ext\b[^>]*\bcy="(\d+)"/.exec(xfrm)?.[1], DEFAULT_PPTX_HEIGHT * 0.12),
  };
}

function pptxSlideTextLines(xml: string): PptxPreviewTextRun[][] {
  return [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
    .map((paragraph) => [...paragraph[0].matchAll(/<a:r\b[\s\S]*?<\/a:r>/g)]
      .map((run) => {
        const runXml = run[0];
        const text = xmlText(runXml);
        const fontSize = pptxFontSize(runXml);
        const color = pptxTextColor(runXml);
        return {
          text,
          ...(fontSize === undefined ? {} : { fontSize }),
          ...(color === undefined ? {} : { color }),
        };
      })
      .filter((run) => run.text.length > 0))
    .filter((line) => line.length > 0);
}

function pptxShapePreset(xml: string): string | undefined {
  return /<a:prstGeom\b[^>]*\bprst="([^"]+)"/.exec(xml)?.[1];
}

function pptxFontSize(xml: string): number | undefined {
  const value = Number(/<a:rPr\b[^>]*\bsz="(\d+)"/.exec(xml)?.[1]);
  return Number.isFinite(value) && value > 0 ? value / 100 : undefined;
}

function pptxTextColor(xml: string): string | undefined {
  const textProperties = /<a:rPr\b[\s\S]*?<\/a:rPr>/.exec(xml)?.[0] ?? "";
  return pptxColor(textProperties);
}

function pptxFillColor(xml: string): string | undefined {
  const shapeProperties = /<p:spPr\b[\s\S]*?<\/p:spPr>/.exec(xml)?.[0] ?? "";
  const solidFill = /<a:solidFill\b[\s\S]*?<\/a:solidFill>/.exec(shapeProperties)?.[0] ?? "";
  return pptxColor(solidFill);
}

function pptxColor(xml: string): string | undefined {
  const color = /<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/.exec(xml)?.[1];
  return color === undefined ? undefined : `#${color}`;
}

function pptxFillOpacity(xml: string): number | undefined {
  const shapeProperties = /<p:spPr\b[\s\S]*?<\/p:spPr>/.exec(xml)?.[0] ?? "";
  const solidFill = /<a:solidFill\b[\s\S]*?<\/a:solidFill>/.exec(shapeProperties)?.[0] ?? "";
  const alpha = Number(/<a:alpha\b[^>]*\bval="(\d+)"/.exec(solidFill)?.[1]);
  return Number.isFinite(alpha) && alpha >= 0 && alpha < 100_000 ? alpha / 100_000 : undefined;
}

function pptxStrokeColor(xml: string): string | undefined {
  const shapeProperties = /<p:spPr\b[\s\S]*?<\/p:spPr>/.exec(xml)?.[0] ?? "";
  const line = /<a:ln\b[\s\S]*?<\/a:ln>/.exec(shapeProperties)?.[0] ?? "";
  return pptxColor(line);
}

function pptxStrokeWidth(xml: string): number | undefined {
  const shapeProperties = /<p:spPr\b[\s\S]*?<\/p:spPr>/.exec(xml)?.[0] ?? "";
  const raw = Number(/<a:ln\b[^>]*\bw="(\d+)"/.exec(shapeProperties)?.[1]);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  return [...xml.matchAll(/<(?:[A-Za-z0-9_]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?t>/g)]
    .map((match) => decodeXml(match[1] ?? ""))
    .join("");
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/&#([0-9]+);/gu, (_, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}
