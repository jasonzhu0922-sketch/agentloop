import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";
import { badRequest } from "../shared/errors.ts";
import { SourceRepository, sourceSummary, type SourceRow } from "../storage/repositories/source-repository.ts";
import type { UploadedSourceSummary, UploadedSourceStatus } from "./contracts.ts";

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 120_000;
const CHUNK_CHARACTERS = 8_000;
const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".html", ".htm", ".pdf", ".docx", ".xlsx", ".pptx"]);

export class SourceIntakeService {
  private readonly repository: SourceRepository;
  private readonly workspaceRoot: string;

  constructor(repository: SourceRepository, workspaceRoot: string) {
    this.repository = repository;
    this.workspaceRoot = workspaceRoot;
  }

  async upload(input: {
    ownerUserId: string;
    conversationId?: string;
    originalName: string;
    mimeType?: string;
    content: Buffer;
  }): Promise<UploadedSourceSummary> {
    const originalName = safeOriginalName(input.originalName);
    const extension = extname(originalName).toLowerCase();
    const mimeType = input.mimeType?.trim() || "application/octet-stream";
    const byteSize = input.content.byteLength;
    if (byteSize <= 0) throw badRequest("Uploaded file is empty");
    const now = Date.now();
    const id = `src_${randomUUID().replaceAll("-", "")}`;
    const sha256 = createHash("sha256").update(input.content).digest("hex");
    const directory = join(
      this.workspaceRoot,
      input.conversationId === undefined ? "uploads" : "conversations",
      input.conversationId ?? input.ownerUserId,
      "sources",
      id,
    );
    await fs.mkdir(directory, { recursive: true });
    const storagePath = join(directory, "original");
    await fs.writeFile(storagePath, input.content, { flag: "wx" });

    const extraction = extractText({
      originalName,
      extension,
      content: input.content,
      byteSize,
    });
    const row = await this.repository.insertSource({
      id,
      ownerUserId: input.ownerUserId,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      originalName,
      mimeType,
      extension,
      byteSize,
      sha256,
      storagePath,
      status: extraction.status,
      summary: extraction.summary,
      tokenEstimate: estimateTokens(extraction.text),
      characterCount: extraction.text.length,
      truncated: extraction.truncated,
      errorCode: extraction.errorCode,
      errorMessage: extraction.errorMessage,
      createdAt: now,
    });
    if (extraction.status === "ready") {
      await this.repository.replaceChunks(id, buildChunks(extraction.text), now);
    }
    return this.summary(row);
  }

  async summary(row: SourceRow): Promise<UploadedSourceSummary> {
    const chunkCount = (await this.repository.chunks(row.id)).length;
    return {
      ...sourceSummary(row),
      chunkCount,
    };
  }
}

interface ExtractionResult {
  readonly status: UploadedSourceStatus;
  readonly text: string;
  readonly summary?: string;
  readonly truncated: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

function extractText(input: {
  originalName: string;
  extension: string;
  content: Buffer;
  byteSize: number;
}): ExtractionResult {
  if (input.byteSize > MAX_SOURCE_BYTES) {
    return {
      status: "oversized",
      text: "",
      truncated: false,
      errorCode: "source_oversized",
      errorMessage: `Uploaded file exceeds ${MAX_SOURCE_BYTES} bytes`,
    };
  }
  if (!SUPPORTED_EXTENSIONS.has(input.extension)) {
    return {
      status: "unsupported",
      text: "",
      truncated: false,
      errorCode: "unsupported_extension",
      errorMessage: `Unsupported file extension: ${input.extension || "(none)"}`,
    };
  }
  const decoded = decodeSourceText(input);
  if (decoded.ok === false) return decoded.error;
  const text = decoded.text;
  const truncated = text.length > MAX_EXTRACTED_CHARACTERS;
  const extracted = truncated ? text.slice(0, MAX_EXTRACTED_CHARACTERS) : text;
  return {
    status: "ready",
    text: extracted,
    summary: summarizeText(input.originalName, input.extension, extracted, truncated),
    truncated,
  };
}

type DecodeSourceResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: ExtractionResult };

function decodeSourceText(input: {
  originalName: string;
  extension: string;
  content: Buffer;
}): DecodeSourceResult {
  try {
    if (input.extension === ".docx") return { ok: true, text: extractDocxText(input.content) };
    if (input.extension === ".xlsx") return { ok: true, text: extractXlsxText(input.content) };
    if (input.extension === ".pptx") return { ok: true, text: extractPptxText(input.content) };
    if (input.extension === ".pdf") return { ok: true, text: extractPdfText(input.content) };
    if (input.extension === ".html" || input.extension === ".htm") return { ok: true, text: extractHtmlText(input.content) };
    let text = input.content.toString("utf8");
    if (text.includes("\uFFFD")) return extractionError("unreadable", "invalid_utf8", "Uploaded file is not valid UTF-8 text");
    if (input.extension === ".json") text = JSON.stringify(JSON.parse(text), null, 2);
    return { ok: true, text };
  } catch (error) {
    return extractionError(
      "unreadable",
      extractionErrorCode(input.extension),
      error instanceof Error ? error.message : `Could not extract ${input.originalName}`,
    );
  }
}

function extractionError(
  status: UploadedSourceStatus,
  errorCode: string,
  errorMessage: string,
): DecodeSourceResult {
  return {
    ok: false,
    error: { status, text: "", truncated: false, errorCode, errorMessage },
  };
}

function extractionErrorCode(extension: string): string {
  if (extension === ".json") return "invalid_json";
  if (extension === ".pdf") return "pdf_extract_failed";
  if (extension === ".docx") return "docx_extract_failed";
  if (extension === ".xlsx") return "xlsx_extract_failed";
  if (extension === ".pptx") return "pptx_extract_failed";
  if (extension === ".html" || extension === ".htm") return "html_extract_failed";
  return "extract_failed";
}

function extractHtmlText(content: Buffer): string {
  const raw = content.toString("utf8");
  if (raw.includes("\uFFFD")) throw new Error("Uploaded HTML is not valid UTF-8 text");
  const withoutNonContent = raw
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!doctype\b[^>]*>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ");
  const withBreaks = withoutNonContent
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|tr|table|ul|ol|blockquote)\s*>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ");
  const text = decodeHtmlText(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/\r/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text === "") throw new Error("HTML contains no extractable body text");
  return text;
}

function extractDocxText(content: Buffer): string {
  const archive = readZipEntries(content);
  const documentXml = archive.get("word/document.xml")?.toString("utf8");
  if (documentXml === undefined) throw new Error("DOCX document.xml is missing");
  const paragraphs = [...documentXml.matchAll(/<w:p[\s\S]*?<\/w:p>/g)]
    .map((match) => wordParagraphText(match[0]))
    .filter((line) => line.length > 0);
  const text = paragraphs.join("\n");
  if (text.trim() === "") throw new Error("DOCX contains no extractable text");
  return text;
}

function wordParagraphText(xml: string): string {
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXmlText(match[1] ?? ""))
    .join("")
    .trim();
}

function extractXlsxText(content: Buffer): string {
  const archive = readZipEntries(content);
  const workbookXml = archive.get("xl/workbook.xml")?.toString("utf8");
  if (workbookXml === undefined) throw new Error("XLSX workbook.xml is missing");
  const relationships = workbookRelationships(archive.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "");
  const sharedStrings = sharedStringTable(archive.get("xl/sharedStrings.xml")?.toString("utf8") ?? "");
  const sections: string[] = [];
  for (const sheet of workbookSheets(workbookXml, relationships)) {
    const xml = archive.get(sheet.path)?.toString("utf8");
    if (xml === undefined) continue;
    const rows = worksheetRows(xml, sharedStrings);
    if (rows.length === 0) continue;
    sections.push([
      `Sheet: ${sheet.name}`,
      ...rows.map((row) => row.join(",")),
    ].join("\n"));
  }
  const text = sections.join("\n\n");
  if (text.trim() === "") throw new Error("XLSX contains no extractable sheet text");
  return text;
}

function workbookSheets(workbookXml: string, relationships: Map<string, string>): Array<{ name: string; path: string }> {
  return [...workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)]
    .map((match) => {
      const attributes = parseXmlAttributes(match[1] ?? "");
      const relationshipId = attributes.get("r:id");
      const target = relationshipId === undefined ? undefined : relationships.get(relationshipId);
      if (target === undefined) return undefined;
      return {
        name: attributes.get("name") ?? relationshipId,
        path: target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`,
      };
    })
    .filter((sheet): sheet is { name: string; path: string } => sheet !== undefined);
}

function workbookRelationships(xml: string): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attributes = parseXmlAttributes(match[1] ?? "");
    const id = attributes.get("Id");
    const target = attributes.get("Target");
    if (id !== undefined && target !== undefined) relationships.set(id, target);
  }
  return relationships;
}

function sharedStringTable(xml: string): string[] {
  return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((match) =>
    [...match[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((text) => decodeXmlText(text[1] ?? ""))
      .join("")
  );
}

function worksheetRows(xml: string, sharedStrings: readonly string[]): string[][] {
  return [...xml.matchAll(/<row\b[\s\S]*?<\/row>/g)].map((rowMatch) =>
    [...rowMatch[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((cellMatch) => {
      const attributes = parseXmlAttributes(cellMatch[1] ?? "");
      const value = /<v>([\s\S]*?)<\/v>/.exec(cellMatch[2] ?? "")?.[1] ?? "";
      if (attributes.get("t") === "s") return sharedStrings[Number(value)] ?? "";
      if (attributes.get("t") === "inlineStr") {
        return [...(cellMatch[2] ?? "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
          .map((match) => decodeXmlText(match[1] ?? ""))
          .join("");
      }
      return decodeXmlText(value);
    })
  ).filter((row) => row.some((cell) => cell.trim() !== ""));
}

function extractPptxText(content: Buffer): string {
  const archive = readZipEntries(content);
  const sections = slidePaths(archive)
    .map((path, index) => {
      const xml = archive.get(path)?.toString("utf8") ?? "";
      const lines = [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
        .map((match) => decodeXmlText(match[1] ?? "").trim())
        .filter((line) => line.length > 0);
      if (lines.length === 0) return "";
      return [`Slide ${index + 1}`, ...lines].join("\n");
    })
    .filter((section) => section.length > 0);
  const text = sections.join("\n\n");
  if (text.trim() === "") throw new Error("PPTX contains no extractable slide text");
  return text;
}

function slidePaths(archive: Map<string, Buffer>): string[] {
  const presentationXml = archive.get("ppt/presentation.xml")?.toString("utf8");
  const relationships = presentationXml === undefined
    ? new Map<string, string>()
    : workbookRelationships(archive.get("ppt/_rels/presentation.xml.rels")?.toString("utf8") ?? "");
  const fromPresentation = presentationXml === undefined
    ? []
    : [...presentationXml.matchAll(/<p:sldId\b([^>]*)\/?>/g)]
      .map((match) => parseXmlAttributes(match[1] ?? "").get("r:id"))
      .map((id) => id === undefined ? undefined : relationships.get(id))
      .filter((target): target is string => target !== undefined)
      .map((target) => target.startsWith("/") ? target.slice(1) : `ppt/${target.replace(/^\.\//, "")}`);
  if (fromPresentation.length > 0) return fromPresentation;
  return [...archive.keys()]
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
}

function slideNumber(path: string): number {
  return Number(/slide(\d+)\.xml$/.exec(path)?.[1] ?? 0);
}

function extractPdfText(content: Buffer): string {
  if (!content.subarray(0, 8).toString("latin1").startsWith("%PDF-")) throw new Error("PDF header is missing");
  const raw = content.toString("latin1");
  const streams = [...raw.matchAll(/<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)]
    .map((match) => decodePdfStream(match[1] ?? "", Buffer.from(match[2] ?? "", "latin1")))
    .filter((stream) => stream.length > 0);
  const text = [...streams, raw]
    .map(extractPdfTextOperators)
    .filter((part) => part.trim() !== "")
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text === "") throw new Error("PDF contains no extractable text");
  return text;
}

function decodePdfStream(dictionary: string, stream: Buffer): string {
  if (/\/FlateDecode\b/.test(dictionary)) {
    try {
      return inflateSync(stream).toString("latin1");
    } catch {
      try {
        return inflateRawSync(stream).toString("latin1");
      } catch {
        return "";
      }
    }
  }
  return stream.toString("latin1");
}

function extractPdfTextOperators(content: string): string {
  const out: string[] = [];
  const textObjectPattern = /BT\b([\s\S]*?)\bET/g;
  for (const textObject of content.matchAll(textObjectPattern)) {
    const body = textObject[1] ?? "";
    for (const arrayMatch of body.matchAll(/\[((?:\\.|[^\]])*)\]\s*TJ/g)) {
      out.push(extractPdfArrayText(arrayMatch[1] ?? ""));
    }
    for (const literalMatch of body.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
      out.push(decodePdfLiteral(literalMatch[0].replace(/\)\s*Tj$/, "").slice(1)));
    }
    for (const hexMatch of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
      out.push(decodePdfHexString(hexMatch[1] ?? ""));
    }
  }
  return out.map((part) => part.trim()).filter(Boolean).join("\n");
}

function extractPdfArrayText(value: string): string {
  const parts: string[] = [];
  for (const literal of value.matchAll(/\((?:\\.|[^\\)])*\)|<([0-9A-Fa-f\s]+)>/g)) {
    const token = literal[0];
    parts.push(token.startsWith("(")
      ? decodePdfLiteral(token.slice(1, -1))
      : decodePdfHexString(literal[1] ?? ""));
  }
  return parts.join("");
}

function decodePdfLiteral(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      result += char;
      continue;
    }
    const next = value[++index];
    if (next === undefined) break;
    if (next === "n") result += "\n";
    else if (next === "r") result += "\r";
    else if (next === "t") result += "\t";
    else if (next === "b") result += "\b";
    else if (next === "f") result += "\f";
    else if (/[0-7]/.test(next)) {
      let octal = next;
      while (index + 1 < value.length && octal.length < 3 && /[0-7]/.test(value[index + 1]!)) {
        octal += value[++index];
      }
      result += String.fromCharCode(parseInt(octal, 8));
    } else if (next !== "\r" && next !== "\n") {
      result += next;
    }
  }
  return decodePdfByteString(Buffer.from(result, "latin1"));
}

function decodePdfHexString(value: string): string {
  const clean = value.replace(/\s+/g, "");
  const padded = clean.length % 2 === 0 ? clean : `${clean}0`;
  return decodePdfByteString(Buffer.from(padded, "hex"));
}

function decodePdfByteString(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return decodeUtf16Be(buffer.subarray(2));
  return buffer.toString("latin1");
}

function decodeUtf16Be(buffer: Buffer): string {
  const swapped = Buffer.alloc(buffer.length);
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    swapped[index] = buffer[index + 1]!;
    swapped[index + 1] = buffer[index]!;
  }
  return swapped.toString("utf16le");
}

function readZipEntries(content: Buffer): Map<string, Buffer> {
  const end = findEndOfCentralDirectory(content);
  const entryCount = content.readUInt16LE(end + 10);
  const directoryOffset = content.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (content.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central directory");
    const method = content.readUInt16LE(offset + 10);
    const compressedSize = content.readUInt32LE(offset + 20);
    const uncompressedSize = content.readUInt32LE(offset + 24);
    const nameLength = content.readUInt16LE(offset + 28);
    const extraLength = content.readUInt16LE(offset + 30);
    const commentLength = content.readUInt16LE(offset + 32);
    const localOffset = content.readUInt32LE(offset + 42);
    const name = content.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.set(name, readZipLocalEntry(content, localOffset, method, compressedSize, uncompressedSize));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(content: Buffer): number {
  const minimum = Math.max(0, content.length - 65_557);
  for (let offset = content.length - 22; offset >= minimum; offset -= 1) {
    if (content.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end of central directory is missing");
}

function readZipLocalEntry(
  content: Buffer,
  offset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Buffer {
  if (content.readUInt32LE(offset) !== 0x04034b50) throw new Error("Invalid ZIP local file header");
  const nameLength = content.readUInt16LE(offset + 26);
  const extraLength = content.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const compressed = content.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return compressed;
  if (method === 8) {
    const inflated = inflateRawSync(compressed);
    if (inflated.length !== uncompressedSize) throw new Error("ZIP entry size mismatch");
    return inflated;
  }
  throw new Error(`Unsupported ZIP compression method: ${method}`);
}

function parseXmlAttributes(value: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of value.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    attributes.set(match[1] ?? "", decodeXmlText(match[2] ?? ""));
  }
  return attributes;
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function decodeXmlText(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function buildChunks(text: string): Array<{
  chunk_index: number;
  kind: "text";
  locator: string;
  content: string;
  token_estimate: number;
  sha256: string;
}> {
  const chunks: Array<{
    chunk_index: number;
    kind: "text";
    locator: string;
    content: string;
    token_estimate: number;
    sha256: string;
  }> = [];
  for (let offset = 0; offset < text.length; offset += CHUNK_CHARACTERS) {
    const content = text.slice(offset, offset + CHUNK_CHARACTERS);
    chunks.push({
      chunk_index: chunks.length,
      kind: "text",
      locator: `chars=${offset + 1}-${offset + content.length}`,
      content,
      token_estimate: estimateTokens(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  return chunks.length === 0
    ? [{
      chunk_index: 0,
      kind: "text",
      locator: "chars=0-0",
      content: "",
      token_estimate: 0,
      sha256: createHash("sha256").update("").digest("hex"),
    }]
    : chunks;
}

function summarizeText(name: string, extension: string, text: string, truncated: boolean): string {
  const lineCount = text === "" ? 0 : text.split(/\r?\n/).length;
  const prefix = text.replace(/\s+/g, " ").trim().slice(0, 240);
  const format = extension.slice(1).toUpperCase() || "TEXT";
  return [
    `${name} is a ${format} source with ${lineCount} lines and ${text.length} extracted characters.`,
    ...(prefix === "" ? [] : [`Preview: ${prefix}`]),
    ...(truncated ? ["Extraction was truncated; use read_source chunks for bounded inspection."] : []),
  ].join(" ");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function safeOriginalName(value: string): string {
  const name = basename(value).replace(/[\x00-\x1F]/g, "").trim();
  if (name.length === 0) return "upload.txt";
  if (name.length > 240) return name.slice(0, 240);
  return name;
}
