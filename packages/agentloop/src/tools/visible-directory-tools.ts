import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { badRequest, forbidden } from "../shared/errors.ts";
import { requireRecord, requireString } from "../shared/validation.ts";
import type { VisibleDirectoryGrant } from "../runtime/contracts.ts";
import type { RuntimeTool, ToolExecutionContext } from "./tool-registry.ts";
import { ComputerExecutor } from "../computer/computer-executor.ts";

const VISIBLE_SEARCH_AUTO_COMPACT_MATCHES = 50;
const VISIBLE_SEARCH_AUTO_COMPACT_CHARACTERS = 8_000;
const VISIBLE_SEARCH_SUMMARY_SAMPLE_LIMIT = 12;
const VISIBLE_SEARCH_SUMMARY_TEXT_GROUP_LIMIT = 30;
const VISIBLE_SEARCH_SUMMARY_PATH_GROUP_LIMIT = 30;
const TABLE_EXTRACTION_MANIFEST_TABLE_LIMIT = 200;
const TABLE_EXTRACTION_MANIFEST_FIELD_LIMIT = 80;
const TABLE_EXTRACTION_MANIFEST_SAMPLE_RECORD_LIMIT = 3;

type VisibleSearchResultMode = "auto" | "matches" | "compact";

interface VisibleSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly context?: unknown;
  readonly readRange?: unknown;
}

interface VisibleToolEvidenceReceipt {
  readonly schema: "agentloop.toolEvidenceReceipt/v1";
  readonly sourceType: string;
  readonly receiptId: string;
  readonly sourceRefs: readonly unknown[];
  readonly facts: readonly unknown[];
  readonly caveats: readonly string[];
  readonly evidenceKinds: {
    readonly satisfied: readonly string[];
    readonly caveated: readonly string[];
    readonly failed: readonly string[];
  };
}

interface VisibleSourceRef {
  readonly sourceRefId?: string;
  readonly rootId?: string;
  readonly path?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly lines?: readonly number[];
}

export const VISIBLE_DIRECTORY_TOOL_NAMES = new Set([
  "visible_list_directory",
  "visible_find_files",
  "visible_index_directory",
  "visible_extract_tables",
  "visible_search_text",
  "visible_read_file",
  "visible_read_files",
]);

export function createVisibleDirectoryTools(): RuntimeTool<unknown>[] {
  return [
    {
      name: "visible_list_directory",
      description: [
        "List entries under a user-authorized local visible directory.",
        "Use rootId from visibleDirectories in runtime context.",
        "path is relative to that visible directory; absolute paths are rejected.",
      ].join(" "),
      inputSchema: objectSchema(["rootId"], {
        rootId: { type: "string" },
        path: { type: "string" },
      }),
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => {
        const record = requireRecord(value, "visible_list_directory arguments");
        return {
          rootId: requireString(record.rootId, "rootId", { max: 80 }),
          path: optionalDirectoryPath(record.path, "path"),
        };
      },
      execute: async (context, value) => {
        const input = value as { rootId: string; path: string };
        const executor = await executorForVisibleRoot(context, input.rootId);
        return {
          rootId: input.rootId,
          entries: await executor.listDirectory(input.path),
        };
      },
    },
    {
      name: "visible_find_files",
      description: [
        "Find files by glob under a user-authorized local visible directory.",
        "Use this when the user names a file, partial filename, extension, or asks to find local material.",
        "Use rootId from visibleDirectories in runtime context. path is relative to that root.",
        "Pass returned sourceRefs directly to visible_read_file(s) instead of reconstructing filenames.",
      ].join(" "),
      inputSchema: objectSchema(["rootId", "pattern"], {
        rootId: { type: "string" },
        pattern: { type: "string" },
        path: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 10_000 },
      }),
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => {
        const record = requireRecord(value, "visible_find_files arguments");
        return {
          rootId: requireString(record.rootId, "rootId", { max: 80 }),
          path: optionalDirectoryPath(record.path, "path"),
          pattern: requireString(record.pattern, "pattern", { max: 1_000 }),
          limit: optionalPositiveInteger(record.limit, "limit"),
        };
      },
      execute: async (context, value) => {
        const input = value as { rootId: string; path: string; pattern: string; limit?: number };
        const executor = await executorForVisibleRoot(context, input.rootId);
        const result = await executor.findFiles(input.path, input.pattern, { limit: input.limit });
        return {
          schema: "agentloop.visibleFindFiles/v1",
          rootId: input.rootId,
          ...result,
          evidenceReceipt: visibleFindFilesReceipt(input.rootId, input.path, input.pattern, result),
        };
      },
    },
    {
      name: "visible_index_directory",
      description: [
        "Build a bounded metadata index for a user-authorized local visible directory.",
        "Use this before summarizing, analyzing, or reporting over many files in a directory.",
        "Returns a structured source_summary receipt with counts, extension distribution, samples, groups, compact text field distributions, spreadsheet schema summaries, hash, and explicit caveats; it does not read every file body.",
        "For spreadsheet directories, use spreadsheetProfile to identify workbooks, sheets, dimensions, candidate headers, merged cells, value-kind distributions, and signature groups before extracting tables.",
        "For metadata/category counts, use fieldProfiles or spreadsheetProfile from this result before issuing broad visible_search_text calls.",
      ].join(" "),
      inputSchema: objectSchema(["rootId"], {
        rootId: { type: "string" },
        path: { type: "string" },
        sampleLimit: { type: "integer", minimum: 1, maximum: 500 },
        groupPrefixLength: { type: "integer", minimum: 1, maximum: 80 },
        maxFiles: { type: "integer", minimum: 1, maximum: 50_000 },
        fieldProfile: { type: "boolean" },
        spreadsheetProfile: { type: "boolean" },
      }),
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => {
        const record = requireRecord(value, "visible_index_directory arguments");
        return {
          rootId: requireString(record.rootId, "rootId", { max: 80 }),
          path: optionalDirectoryPath(record.path, "path"),
          sampleLimit: optionalBoundedInteger(record.sampleLimit, "sampleLimit", 1, 500),
          groupPrefixLength: optionalBoundedInteger(record.groupPrefixLength, "groupPrefixLength", 1, 80),
          maxFiles: optionalBoundedInteger(record.maxFiles, "maxFiles", 1, 50_000),
          fieldProfile: optionalBoolean(record.fieldProfile, "fieldProfile"),
          spreadsheetProfile: optionalBoolean(record.spreadsheetProfile, "spreadsheetProfile"),
        };
      },
      execute: async (context, value) => {
        const input = value as {
          rootId: string;
          path: string;
          sampleLimit?: number;
          groupPrefixLength?: number;
          maxFiles?: number;
          fieldProfile?: boolean;
          spreadsheetProfile?: boolean;
        };
        const executor = await executorForVisibleRoot(context, input.rootId);
        const result = await executor.profileDirectory(input.path, {
          sampleLimit: input.sampleLimit,
          groupPrefixLength: input.groupPrefixLength,
          maxFiles: input.maxFiles,
          fieldProfile: input.fieldProfile,
          spreadsheetProfile: input.spreadsheetProfile,
        });
        return {
          rootId: input.rootId,
          ...result,
          evidenceReceipt: visibleDirectoryIndexReceipt(input.rootId, result),
        };
      },
    },
    {
      name: "visible_extract_tables",
      description: [
        "Extract bounded generic table records from spreadsheet-like files in a user-authorized visible directory.",
        "Use this after visible_index_directory has identified spreadsheet paths or sourceRefs.",
        "Inputs are paths or sourceRefs returned by visible_index_directory/visible_find_files.",
        "Writes a durable JSON extraction artifact in the Runtime workspace with schema, rows, cells, source ranges, counts, hashes, and caveats.",
        "The tool reports structure and raw values only; domain interpretation belongs to the next analysis or writing step.",
      ].join(" "),
      inputSchema: objectSchema(["rootId", "files"], {
        rootId: { type: "string" },
        files: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: sourceReadableBatchEntrySchema({
            path: { type: "string" },
            sourceRef: sourceRefSchema(),
          }),
        },
        maxRowsPerSheet: { type: "integer", minimum: 1, maximum: 2_000 },
        maxTotalCells: { type: "integer", minimum: 1, maximum: 100_000 },
      }),
      executionMode: "parallel",
      replaySafe: true,
      maxResultCharacters: 250_000,
      parse: (value) => {
        const record = requireRecord(value, "visible_extract_tables arguments");
        return {
          rootId: requireString(record.rootId, "rootId", { max: 80 }),
          files: parseTableExtractionFiles(record.files),
          maxRowsPerSheet: optionalBoundedInteger(record.maxRowsPerSheet, "maxRowsPerSheet", 1, 2_000),
          maxTotalCells: optionalBoundedInteger(record.maxTotalCells, "maxTotalCells", 1, 100_000),
        };
      },
      execute: async (context, value) => {
        const input = value as {
          rootId: string;
          files: Array<{ path: string; sourceRef?: VisibleSourceRef }>;
          maxRowsPerSheet?: number;
          maxTotalCells?: number;
        };
        const executor = await executorForVisibleRoot(context, input.rootId);
        const extraction = await executor.extractVisibleTables(input.files, {
          maxRowsPerSheet: input.maxRowsPerSheet,
          maxTotalCells: input.maxTotalCells,
        });
        const artifact = await writeVisibleTableExtractionArtifact(context.grant.workspaceRoot, extraction);
        const caveats = uniqueStrings(extraction.caveats);
        const result = {
          rootId: input.rootId,
          ...extraction,
          caveats,
          artifact,
        };
        return {
          ...result,
          evidenceReceipt: visibleTableExtractionReceipt(input.rootId, result),
        };
      },
    },
    {
      name: "visible_search_text",
      description: [
        "Search literal text recursively under a user-authorized local visible directory.",
        "Use this when the user references local material by content rather than filename.",
        "Use rootId from visibleDirectories in runtime context. path is relative to that root.",
        "Use resultMode=compact for broad/category queries; default auto returns compact summaries when matches would be large.",
        "Pass returned sourceRefs directly to visible_read_file(s) instead of reconstructing filenames.",
      ].join(" "),
      inputSchema: objectSchema(["rootId", "query"], {
        rootId: { type: "string" },
        query: { type: "string" },
        path: { type: "string" },
        maxMatches: { type: "integer", minimum: 1, maximum: 200 },
        contextBefore: { type: "integer", minimum: 0, maximum: 20 },
        contextAfter: { type: "integer", minimum: 0, maximum: 20 },
        resultMode: { type: "string", enum: ["auto", "matches", "compact"] },
      }),
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => {
        const record = requireRecord(value, "visible_search_text arguments");
        return {
          rootId: requireString(record.rootId, "rootId", { max: 80 }),
          path: optionalDirectoryPath(record.path, "path"),
          query: requireString(record.query, "query", { max: 2_000 }),
          maxMatches: optionalCappedInteger(record.maxMatches, "maxMatches", 1, 200),
          contextBefore: optionalBoundedInteger(record.contextBefore, "contextBefore", 0, 20),
          contextAfter: optionalBoundedInteger(record.contextAfter, "contextAfter", 0, 20),
          resultMode: optionalSearchResultMode(record.resultMode),
        };
      },
      execute: async (context, value) => {
        const input = value as {
          rootId: string;
          path: string;
          query: string;
          maxMatches?: number;
          contextBefore?: number;
          contextAfter?: number;
          resultMode?: VisibleSearchResultMode;
        };
        const executor = await executorForVisibleRoot(context, input.rootId);
        const maxMatches = input.maxMatches ?? 200;
        const matches = await executor.searchText(input.path, input.query, {
          maxMatches: input.maxMatches,
          contextBefore: input.contextBefore,
          contextAfter: input.contextAfter,
        });
        const mode = input.resultMode ?? "auto";
        if (mode === "compact" || (mode === "auto" && shouldCompactVisibleSearch(matches, maxMatches))) {
          return compactVisibleSearchResult(input.rootId, input.path, input.query, maxMatches, matches);
        }
        return {
          schema: "agentloop.visibleSearchText/v1",
          rootId: input.rootId,
          path: input.path,
          query: input.query,
          maxMatches,
          returnedMatches: matches.length,
          truncated: matches.length >= maxMatches,
          matches,
          evidenceReceipt: visibleSearchTextReceipt(input.rootId, input.path, input.query, maxMatches, matches, false),
        };
      },
    },
    {
      name: "visible_read_file",
      description: [
        "Read a UTF-8 file under a user-authorized local visible directory.",
        "Use rootId from visibleDirectories in runtime context and a path returned by visible_find_files or visible_search_text, or pass a returned sourceRef object directly.",
        "If a bare filename is missing at the visible root, the tool searches authorized subdirectories by basename; unique ranked matches are read and ambiguous matches return candidate paths.",
        "Use optional 1-indexed offset and limit for one line window, or ranges for multiple line windows; do not combine ranges with offset or limit.",
      ].join(" "),
      inputSchema: sourceReadableFileInputSchema({
        rootId: { type: "string" },
        path: { type: "string" },
        sourceRef: sourceRefSchema(),
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1 },
        ranges: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["offset"],
            properties: {
              offset: { type: "integer", minimum: 1 },
              limit: { type: "integer", minimum: 1, maximum: 2_000 },
            },
          },
        },
      }),
      executionMode: "parallel",
      replaySafe: true,
      maxResultCharacters: 250_000,
      parse: (value) => {
        const record = requireRecord(value, "visible_read_file arguments");
        if (record.ranges !== undefined && (record.offset !== undefined || record.limit !== undefined)) {
          throw badRequest("ranges cannot be combined with offset or limit");
        }
        const sourceRef = parseSourceRef(record.sourceRef, "sourceRef");
        const rootId = record.rootId === undefined
          ? sourceRef?.rootId
          : requireString(record.rootId, "rootId", { max: 80 });
        const path = record.path === undefined
          ? sourceRef?.path
          : requireString(record.path, "path", { max: 4_000 });
        if (rootId === undefined) throw badRequest("rootId is required when sourceRef.rootId is absent");
        if (path === undefined) throw badRequest("path or sourceRef.path is required");
        return {
          rootId,
          path,
          sourceRef,
          offset: optionalPositiveInteger(record.offset, "offset"),
          limit: optionalPositiveInteger(record.limit, "limit"),
          ranges: parseReadRanges(record.ranges),
        };
      },
      execute: async (context, value) => {
        const input = value as { rootId: string; path: string; sourceRef?: VisibleSourceRef; offset?: number; limit?: number; ranges?: Array<{ offset: number; limit?: number }> };
        const executor = await executorForVisibleRoot(context, input.rootId);
        const result = await executor.readFile(input.path, undefined, {
          offset: input.offset,
          limit: input.limit,
          ranges: input.ranges,
        });
        const path = result.resolvedPath ?? input.path;
        return {
          schema: "agentloop.visibleReadFile/v1",
          rootId: input.rootId,
          path,
          ...result,
          evidenceReceipt: visibleReadFileReceipt(input.rootId, path, input.path, result, input.sourceRef),
        };
      },
    },
    {
      name: "visible_read_files",
      description: [
        "Read bounded windows from multiple UTF-8 files under a user-authorized local visible directory.",
        "Use this after visible_index_directory, visible_find_files, or visible_search_text has identified real paths or sourceRefs.",
        "Do not use it for directory discovery. Keep batches representative and bounded.",
      ].join(" "),
      inputSchema: objectSchema(["rootId", "files"], {
        rootId: { type: "string" },
        files: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: sourceReadableBatchEntrySchema({
            path: { type: "string" },
            sourceRef: sourceRefSchema(),
            offset: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1 },
            ranges: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["offset"],
                properties: {
                  offset: { type: "integer", minimum: 1 },
                  limit: { type: "integer", minimum: 1, maximum: 2_000 },
                },
              },
            },
          }),
        },
        maxTotalCharacters: { type: "integer", minimum: 1, maximum: 200_000 },
      }),
      executionMode: "parallel",
      replaySafe: true,
      maxResultCharacters: 250_000,
      parse: (value) => {
        const record = requireRecord(value, "visible_read_files arguments");
        const files = parseReadFileBatch(record.files);
        return {
          rootId: requireString(record.rootId, "rootId", { max: 80 }),
          files,
          maxTotalCharacters: optionalBoundedInteger(record.maxTotalCharacters, "maxTotalCharacters", 1, 200_000),
        };
      },
      execute: async (context, value) => {
        const input = value as {
          rootId: string;
          files: Array<{ path: string; offset?: number; limit?: number; ranges?: Array<{ offset: number; limit?: number }> }>;
          maxTotalCharacters?: number;
        };
        const executor = await executorForVisibleRoot(context, input.rootId);
        const result = await executor.readFiles(input.files, { maxTotalCharacters: input.maxTotalCharacters });
        return {
          rootId: input.rootId,
          ...result,
          evidenceReceipt: enrichVisibleFilesReceipt(input.rootId, result.evidenceReceipt),
        };
      },
    },
  ];
}

async function executorForVisibleRoot(context: ToolExecutionContext, rootId: string): Promise<ComputerExecutor> {
  const root = context.grant.visibleDirectories.find((item) => item.id === rootId);
  if (root === undefined) throw forbidden(`Visible directory "${rootId}" is not authorized for this run`);
  await assertUsableDirectory(root);
  return new ComputerExecutor(root.path);
}

async function assertUsableDirectory(root: VisibleDirectoryGrant): Promise<void> {
  const stat = await fs.lstat(root.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw badRequest(`Visible directory no longer exists: ${root.name}`);
    throw error;
  });
  if (stat.isSymbolicLink()) throw forbidden(`Visible directory cannot be a symbolic link: ${root.name}`);
  if (!stat.isDirectory()) throw badRequest(`Visible directory is not a directory: ${root.name}`);
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw badRequest(`${field} must be a positive integer`);
  }
  return value as number;
}

function optionalDirectoryPath(value: unknown, field: string): string {
  if (value === undefined) return ".";
  if (typeof value !== "string") throw badRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "/") return ".";
  return requireString(trimmed, field, { max: 4_000 });
}

function optionalBoundedInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw badRequest(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function optionalCappedInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw badRequest(`${field} must be an integer greater than or equal to ${min}`);
  }
  return Math.min(value as number, max);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw badRequest(`${field} must be a boolean`);
  return value;
}

function optionalSearchResultMode(value: unknown): VisibleSearchResultMode | undefined {
  if (value === undefined) return undefined;
  const mode = requireString(value, "resultMode", { max: 20 });
  if (mode === "auto" || mode === "matches" || mode === "compact") return mode;
  throw badRequest("resultMode must be one of: auto, matches, compact");
}

function shouldCompactVisibleSearch(matches: readonly VisibleSearchMatch[], maxMatches: number): boolean {
  if (matches.length >= Math.min(maxMatches, VISIBLE_SEARCH_AUTO_COMPACT_MATCHES)) return true;
  return JSON.stringify({ matches }).length > VISIBLE_SEARCH_AUTO_COMPACT_CHARACTERS;
}

function compactVisibleSearchResult(
  rootId: string,
  path: string,
  query: string,
  maxMatches: number,
  matches: readonly VisibleSearchMatch[],
): Record<string, unknown> {
  const serialized = JSON.stringify(matches);
  const truncated = matches.length >= maxMatches;
  const caveats = [
    "Search result was compacted to avoid sending every path/line match into model context.",
    ...(truncated ? ["Search stopped at maxMatches; additional matches may exist."] : []),
  ];
  const result = {
    rootId,
    schema: "agentloop.visibleSearchSummary/v1",
    resultMode: "compact",
    path,
    query,
    maxMatches,
    returnedMatches: matches.length,
    truncated,
    matchesRef: `visible-search:${createHash("sha256").update(serialized).digest("hex")}`,
    sampleMatches: sampleVisibleSearchMatches(matches),
    textGroups: topVisibleSearchTextGroups(matches),
    pathGroups: topVisibleSearchPathGroups(matches),
    caveats,
  };
  return {
    ...result,
    evidenceReceipt: visibleSearchTextReceipt(rootId, path, query, maxMatches, matches, true, caveats),
  };
}

function visibleFindFilesReceipt(
  rootId: string,
  path: string,
  pattern: string,
  result: { matches: readonly string[]; limit: number; returned: number; totalMatches: number; truncated: boolean },
): VisibleToolEvidenceReceipt {
  const caveats = [
    "File discovery records path identities only; read selected files before relying on file body content.",
    ...(result.truncated ? ["Find result was truncated; additional matching files may exist."] : []),
  ];
  return buildVisibleToolEvidenceReceipt({
    sourceType: "visible_file_discovery",
    sourceRefs: result.matches.map((match) => ({
      sourceRefId: visibleSourceRefId(rootId, match),
      path: match,
      rootId,
      matchedBy: { path, pattern },
    })),
    facts: [{
      kind: "file_discovery",
      rootId,
      path,
      pattern,
      limit: result.limit,
      returned: result.returned,
      totalMatches: result.totalMatches,
      truncated: result.truncated,
      samplePaths: result.matches.slice(0, 50),
    }],
    caveats,
    satisfied: ["source_discovery", "source_refs"],
  });
}

function visibleDirectoryIndexReceipt(
  rootId: string,
  result: {
    path: string;
    totalFiles: number;
    scannedFiles: number;
    totalBytes: number;
    truncated: boolean;
    extensions: Record<string, number>;
    samplePaths: readonly string[];
    groups: readonly unknown[];
    fieldProfiles: readonly unknown[];
    spreadsheetProfile?: unknown;
    indexRef: string;
    sha256: string;
    caveats: readonly string[];
    evidenceKinds: { satisfied: readonly string[]; caveated: readonly string[]; failed: readonly string[] };
  },
): VisibleToolEvidenceReceipt {
  return buildVisibleToolEvidenceReceipt({
    sourceType: "visible_directory",
    sourceRefs: result.samplePaths.map((path) => ({
      sourceRefId: visibleSourceRefId(rootId, path),
      path,
      rootId,
      source: "directory_sample",
    })),
    facts: [{
      kind: "source_summary",
      rootId,
      path: result.path,
      totalFiles: result.totalFiles,
      scannedFiles: result.scannedFiles,
      totalBytes: result.totalBytes,
      truncated: result.truncated,
      extensions: result.extensions,
      groups: result.groups,
      fieldProfiles: result.fieldProfiles,
      spreadsheetProfile: result.spreadsheetProfile,
      indexRef: result.indexRef,
      sha256: result.sha256,
    }],
    caveats: result.caveats,
    satisfied: result.evidenceKinds.satisfied,
    failed: result.evidenceKinds.failed,
  });
}

interface TableExtractionArtifactManifest {
  readonly schema: "agentloop.tableExtractionArtifactManifest/v1";
  readonly artifactSchema: "agentloop.visibleTableExtraction/v1";
  readonly totalFiles: number;
  readonly totalTables: number;
  readonly totalRows: number;
  readonly totalRecords: number;
  readonly totalCells: number;
  readonly truncated: boolean;
  readonly caveats: readonly string[];
  readonly tables: readonly TableExtractionManifestTable[];
}

interface TableExtractionManifestTable {
  readonly tableId: string;
  readonly filePath: string;
  readonly fileIndex: number;
  readonly sheetName: string;
  readonly sheetIndex: number;
  readonly sheetPointer: string;
  readonly rowsPointer: string;
  readonly recordsPointer: string;
  readonly columnsPointer: string;
  readonly sourceRange?: string;
  readonly headerRange?: string;
  readonly rowCount: number;
  readonly recordCount: number;
  readonly cellCount: number;
  readonly recordRows?: { readonly first: number; readonly last: number };
  readonly fields: readonly {
    readonly name: string;
    readonly address: string;
    readonly index: number;
    readonly sourceAddress?: string;
    readonly nonEmptyCellCount: number;
    readonly valueKinds: Record<string, number>;
  }[];
  readonly sampleRecords: readonly {
    readonly row: number;
    readonly sourceRange: string;
    readonly values: Record<string, string | number | boolean>;
  }[];
  readonly sourceRanges: readonly string[];
  readonly truncated: boolean;
}

function visibleTableExtractionReceipt(
  rootId: string,
  result: {
    readonly files: readonly {
      readonly path: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly sheets: readonly {
        readonly name: string;
        readonly sourceRange?: string;
        readonly rowCount: number;
        readonly recordCount?: number;
        readonly cellCount: number;
        readonly truncated: boolean;
      }[];
      readonly truncated: boolean;
      readonly error?: string;
    }[];
    readonly requested: number;
    readonly returned: number;
    readonly totalRows: number;
    readonly totalRecords?: number;
    readonly totalCells: number;
    readonly truncated: boolean;
    readonly sha256: string;
    readonly caveats: readonly string[];
    readonly artifact: {
      readonly path: string;
      readonly bytes: number;
      readonly sha256: string;
      readonly schema: string;
      readonly manifest: TableExtractionArtifactManifest;
      readonly caveats: readonly string[];
    };
  },
): VisibleToolEvidenceReceipt {
  return buildVisibleToolEvidenceReceipt({
    sourceType: "visible_table_extraction",
    sourceRefs: result.files.map((file) => ({
      sourceRefId: visibleSourceRefId(rootId, file.path),
      rootId,
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      sheets: file.sheets.map((sheet) => ({
        name: sheet.name,
        sourceRange: sheet.sourceRange,
        rowCount: sheet.rowCount,
        recordCount: sheet.recordCount,
        cellCount: sheet.cellCount,
        truncated: sheet.truncated,
      })),
      truncated: file.truncated,
      error: file.error,
    })),
    facts: [{
      kind: "structured_table_extraction",
      rootId,
      requested: result.requested,
      returned: result.returned,
      totalRows: result.totalRows,
      totalRecords: result.totalRecords,
      totalCells: result.totalCells,
      truncated: result.truncated,
      artifact: {
        schema: result.artifact.schema,
        path: result.artifact.path,
        bytes: result.artifact.bytes,
        sha256: result.artifact.sha256,
        manifest: result.artifact.manifest,
        caveats: result.artifact.caveats,
      },
      extractionSha256: result.sha256,
    }],
    caveats: result.caveats,
    satisfied: [
      "source_summary",
      "source_read",
      "source_refs",
      "schema_summary",
      "record_counts",
      "structured_extraction_artifact",
    ],
  });
}

function visibleSearchTextReceipt(
  rootId: string,
  path: string,
  query: string,
  maxMatches: number,
  matches: readonly VisibleSearchMatch[],
  compacted: boolean,
  caveats: readonly string[] = matches.length >= maxMatches ? ["Search stopped at maxMatches; additional matches may exist."] : [],
): VisibleToolEvidenceReceipt {
  const truncated = matches.length >= maxMatches;
  return buildVisibleToolEvidenceReceipt({
    sourceType: "visible_search_text",
    sourceRefs: groupSearchSourceRefs(rootId, matches),
    facts: [{
      kind: "text_search",
      rootId,
      path,
      query,
      maxMatches,
      returnedMatches: matches.length,
      truncated,
      compacted,
      sampleMatches: sampleVisibleSearchMatches(matches),
      textGroups: topVisibleSearchTextGroups(matches),
      pathGroups: topVisibleSearchPathGroups(matches),
      matchesRef: `visible-search:${createHash("sha256").update(JSON.stringify(matches)).digest("hex")}`,
    }],
    caveats,
    satisfied: ["source_search", "source_refs"],
  });
}

function groupSearchSourceRefs(rootId: string, matches: readonly VisibleSearchMatch[]): Array<{ sourceRefId: string; rootId: string; path: string; lines: number[] }> {
  const byPath = new Map<string, number[]>();
  for (const match of matches) {
    const lines = byPath.get(match.path) ?? [];
    if (lines.length < 20) lines.push(match.line);
    byPath.set(match.path, lines);
  }
  return [...byPath.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, lines]) => ({ sourceRefId: visibleSourceRefId(rootId, path), rootId, path, lines }));
}

function visibleReadFileReceipt(
  rootId: string,
  path: string,
  requestedPath: string,
  result: {
    content: string;
    bytes: number;
    truncated: boolean;
    resolvedPath?: string;
    requestedPath?: string;
    offset?: number;
    limit?: number;
    totalLines?: number;
    nextOffset?: number;
  },
  inputSourceRef?: VisibleSourceRef,
): VisibleToolEvidenceReceipt {
  const sha256 = createHash("sha256").update(result.content).digest("hex");
  const sourceRef = omitUndefinedDeep({
    sourceRefId: inputSourceRef?.sourceRefId ?? visibleSourceRefId(rootId, path),
    rootId,
    path,
    sha256,
    bytes: result.bytes,
    characters: result.content.length,
    truncated: result.truncated,
    requestedPath: result.requestedPath ?? requestedPath,
    resolvedPath: result.resolvedPath,
    offset: result.offset,
    limit: result.limit,
    totalLines: result.totalLines,
    nextOffset: result.nextOffset,
  });
  const caveats = [
    "Full Tool result remains in canonical events; model context may receive only this structured receipt.",
    ...(result.truncated ? ["File read was truncated; reread explicit ranges before citing omitted text."] : []),
  ];
  return buildVisibleToolEvidenceReceipt({
    sourceType: "visible_files",
    sourceRefs: [sourceRef],
    facts: [extractVisibleTextEvidenceFact(rootId, path, result.content, result.truncated)],
    caveats,
    satisfied: ["source_read", "source_summary", "source_refs"],
  });
}

function enrichVisibleFilesReceipt(rootId: string, receipt: {
  schema: "agentloop.toolEvidenceReceipt/v1";
  sourceType: "visible_files";
  receiptId: string;
  sourceRefs: readonly Record<string, unknown>[];
  facts: readonly unknown[];
  caveats: readonly string[];
  evidenceKinds: { satisfied: readonly string[]; caveated: readonly string[]; failed: readonly string[] };
}): VisibleToolEvidenceReceipt {
  const sourceRefs = receipt.sourceRefs.map((sourceRef) => {
    const path = typeof sourceRef.path === "string" ? sourceRef.path : "";
    return omitUndefinedDeep({
      sourceRefId: typeof sourceRef.sourceRefId === "string" ? sourceRef.sourceRefId : visibleSourceRefId(rootId, path),
      rootId,
      ...sourceRef,
    });
  });
  return buildVisibleToolEvidenceReceipt({
    sourceType: receipt.sourceType,
    sourceRefs,
    facts: receipt.facts.map((fact) => ({ rootId, ...(fact as Record<string, unknown>) })),
    caveats: receipt.caveats,
    satisfied: uniqueStrings([...receipt.evidenceKinds.satisfied, "source_summary"]),
    failed: receipt.evidenceKinds.failed,
  });
}

function buildVisibleToolEvidenceReceipt(input: {
  sourceType: string;
  sourceRefs: readonly unknown[];
  facts: readonly unknown[];
  caveats: readonly string[];
  satisfied: readonly string[];
  failed?: readonly string[];
}): VisibleToolEvidenceReceipt {
  const material = JSON.stringify({
    sourceType: input.sourceType,
    sourceRefs: input.sourceRefs,
    facts: input.facts,
    caveats: input.caveats,
    failed: input.failed ?? [],
  });
  return {
    schema: "agentloop.toolEvidenceReceipt/v1",
    sourceType: input.sourceType,
    receiptId: createHash("sha256").update(material).digest("hex"),
    sourceRefs: input.sourceRefs,
    facts: input.facts,
    caveats: input.caveats,
    evidenceKinds: {
      satisfied: input.caveats.length === 0
        ? uniqueStrings([...input.satisfied, "explicit_caveats"])
        : input.satisfied,
      caveated: input.caveats.length === 0 ? [] : ["explicit_caveats"],
      failed: input.failed ?? [],
    },
  };
}

function sampleVisibleSearchMatches(matches: readonly VisibleSearchMatch[]): VisibleSearchMatch[] {
  if (matches.length <= VISIBLE_SEARCH_SUMMARY_SAMPLE_LIMIT) return [...matches];
  const headCount = Math.ceil(VISIBLE_SEARCH_SUMMARY_SAMPLE_LIMIT / 2);
  const tailCount = Math.floor(VISIBLE_SEARCH_SUMMARY_SAMPLE_LIMIT / 2);
  return [...matches.slice(0, headCount), ...matches.slice(matches.length - tailCount)];
}

function topVisibleSearchTextGroups(matches: readonly VisibleSearchMatch[]): Array<{ text: string; count: number; samplePaths: string[] }> {
  const groups = new Map<string, { count: number; samplePaths: string[] }>();
  for (const match of matches) {
    const text = normalizeVisibleSearchGroupText(match.text);
    const current = groups.get(text) ?? { count: 0, samplePaths: [] };
    current.count += 1;
    if (current.samplePaths.length < 3 && !current.samplePaths.includes(match.path)) current.samplePaths.push(match.path);
    groups.set(text, current);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, VISIBLE_SEARCH_SUMMARY_TEXT_GROUP_LIMIT)
    .map(([text, data]) => ({ text, count: data.count, samplePaths: data.samplePaths }));
}

function topVisibleSearchPathGroups(matches: readonly VisibleSearchMatch[]): Array<{ prefix: string; count: number }> {
  const groups = new Map<string, number>();
  for (const match of matches) {
    const prefix = visibleSearchPathPrefix(match.path);
    groups.set(prefix, (groups.get(prefix) ?? 0) + 1);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, VISIBLE_SEARCH_SUMMARY_PATH_GROUP_LIMIT)
    .map(([prefix, count]) => ({ prefix, count }));
}

function normalizeVisibleSearchGroupText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 500);
}

function visibleSearchPathPrefix(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) {
    const match = /^(.*?)[-_ ]?\d{2,}/u.exec(parts[0] ?? path);
    return normalizeVisibleSearchGroupText(match?.[1] ?? parts[0] ?? path) || "[root]";
  }
  return parts.slice(0, Math.min(parts.length - 1, 3)).join("/");
}

function visibleSourceRefId(rootId: string, path: string): string {
  return `visible-source:${createHash("sha256").update(JSON.stringify({ rootId, path })).digest("hex").slice(0, 16)}`;
}

function extractVisibleTextEvidenceFact(
  rootId: string,
  path: string,
  content: string,
  truncated: boolean,
): Record<string, unknown> {
  const lines = content.split(/\r?\n/u);
  const title = lines.find((line) => /^#{1,6}\s+\S/u.test(line))?.replace(/^#{1,6}\s+/u, "").trim();
  const outline = lines
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter((line) => /^#{1,6}\s+\S/u.test(line.text))
    .slice(0, 20);
  const fields = lines.flatMap((line) => {
    const match = /^([^：:\n]{1,40})[：:]\s*(.+)$/u.exec(line.trim());
    if (match === null) return [];
    return [{ name: match[1].trim(), value: match[2].trim() }];
  }).slice(0, 20);
  return {
    kind: "source_summary",
    rootId,
    path,
    ...(title === undefined ? {} : { title }),
    outline,
    fields,
    excerpt: content.slice(0, 2_000),
    truncated,
  };
}

function parseReadRanges(value: unknown): Array<{ offset: number; limit?: number }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw badRequest("ranges must be an array with 1 to 20 entries");
  }
  return value.map((item, index) => {
    const record = requireRecord(item, `ranges[${index}]`);
    return {
      offset: requireBoundedInteger(record.offset, `ranges[${index}].offset`, 1, Number.MAX_SAFE_INTEGER),
      limit: optionalBoundedInteger(record.limit, `ranges[${index}].limit`, 1, 2_000),
    };
  });
}

function parseSourceRef(value: unknown, field: string): VisibleSourceRef | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, field);
  const lines = record.lines;
  return {
    sourceRefId: record.sourceRefId === undefined ? undefined : requireString(record.sourceRefId, `${field}.sourceRefId`, { max: 200 }),
    rootId: record.rootId === undefined ? undefined : requireString(record.rootId, `${field}.rootId`, { max: 80 }),
    path: record.path === undefined ? undefined : requireString(record.path, `${field}.path`, { max: 4_000 }),
    offset: optionalPositiveInteger(record.offset, `${field}.offset`),
    limit: optionalPositiveInteger(record.limit, `${field}.limit`),
    lines: Array.isArray(lines)
      ? lines.filter((item): item is number => Number.isSafeInteger(item) && item >= 1).slice(0, 20)
      : undefined,
  };
}

function parseReadFileBatch(value: unknown): Array<{
  path: string;
  sourceRef?: VisibleSourceRef;
  offset?: number;
  limit?: number;
  ranges?: Array<{ offset: number; limit?: number }>;
}> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw badRequest("files must be an array with 1 to 50 entries");
  }
  return value.map((item, index) => {
    const record = requireRecord(item, `files[${index}]`);
    if (record.ranges !== undefined && (record.offset !== undefined || record.limit !== undefined)) {
      throw badRequest(`files[${index}].ranges cannot be combined with offset or limit`);
    }
    const sourceRef = parseSourceRef(record.sourceRef, `files[${index}].sourceRef`);
    const path = record.path === undefined
      ? sourceRef?.path
      : requireString(record.path, `files[${index}].path`, { max: 4_000 });
    if (path === undefined) throw badRequest(`files[${index}].path or files[${index}].sourceRef.path is required`);
    return {
      path,
      sourceRef,
      offset: optionalPositiveInteger(record.offset, `files[${index}].offset`),
      limit: optionalPositiveInteger(record.limit, `files[${index}].limit`),
      ranges: parseReadRanges(record.ranges),
    };
  });
}

function parseTableExtractionFiles(value: unknown): Array<{ path: string; sourceRef?: VisibleSourceRef }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw badRequest("files must be an array with 1 to 50 entries");
  }
  return value.map((item, index) => {
    const record = requireRecord(item, `files[${index}]`);
    const sourceRef = parseSourceRef(record.sourceRef, `files[${index}].sourceRef`);
    const path = record.path === undefined
      ? sourceRef?.path
      : requireString(record.path, `files[${index}].path`, { max: 4_000 });
    if (path === undefined) throw badRequest(`files[${index}].path or files[${index}].sourceRef.path is required`);
    return {
      path,
      ...(sourceRef === undefined ? {} : { sourceRef }),
    };
  });
}

async function writeVisibleTableExtractionArtifact(
  workspaceRoot: string | undefined,
  extraction: {
    readonly schema: "agentloop.visibleTableExtraction/v1";
    readonly files: readonly {
      readonly path: string;
      readonly sheets: readonly {
        readonly name: string;
        readonly index: number;
        readonly sourceRange?: string;
        readonly header?: { readonly range: string };
        readonly columns: readonly {
          readonly index: number;
          readonly address: string;
          readonly name: string;
          readonly sourceAddress?: string;
          readonly nonEmptyCellCount: number;
          readonly valueKinds: Record<string, number>;
        }[];
        readonly records: readonly {
          readonly row: number;
          readonly sourceRange: string;
          readonly values: Record<string, string | number | boolean>;
        }[];
        readonly rowCount: number;
        readonly recordCount: number;
        readonly cellCount: number;
        readonly truncated: boolean;
      }[];
    }[];
    readonly totalRows: number;
    readonly totalRecords: number;
    readonly totalCells: number;
    readonly sha256: string;
  },
): Promise<{
  readonly schema: "agentloop.tableExtractionArtifact/v1";
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly manifest: TableExtractionArtifactManifest;
  readonly caveats: readonly string[];
}> {
  if (workspaceRoot === undefined) {
    throw badRequest("visible_extract_tables requires a Runtime workspaceRoot to write a durable extraction artifact");
  }
  const canonicalRoot = await fs.realpath(workspaceRoot);
  const directory = resolve(canonicalRoot, ".agentloop", "table-extractions", extraction.sha256.slice(0, 2));
  assertInsideRoot(directory, canonicalRoot);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = resolve(directory, `${extraction.sha256}.json`);
  assertInsideRoot(target, canonicalRoot);
  const content = JSON.stringify(extraction, null, 2);
  await fs.writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const written = await fs.readFile(target, "utf8");
  const sha256 = createHash("sha256").update(written).digest("hex");
  const manifest = buildTableExtractionArtifactManifest(extraction);
  return {
    schema: "agentloop.tableExtractionArtifact/v1",
    path: relative(canonicalRoot, target).split(sep).join("/"),
    bytes: Buffer.byteLength(written),
    sha256,
    manifest,
    caveats: manifest.caveats,
  };
}

function buildTableExtractionArtifactManifest(
  extraction: Parameters<typeof writeVisibleTableExtractionArtifact>[1],
): TableExtractionArtifactManifest {
  const tables: TableExtractionManifestTable[] = [];
  const caveats: string[] = [];
  let totalTableCount = 0;
  extraction.files.forEach((file, fileIndex) => {
    file.sheets.forEach((sheet, sheetOffset) => {
      totalTableCount += 1;
      if (tables.length >= TABLE_EXTRACTION_MANIFEST_TABLE_LIMIT) return;
      const sheetPointer = `/files/${fileIndex}/sheets/${sheetOffset}`;
      const recordRows = sheet.records.length === 0
        ? undefined
        : { first: sheet.records[0].row, last: sheet.records[sheet.records.length - 1].row };
      if (sheet.columns.length > TABLE_EXTRACTION_MANIFEST_FIELD_LIMIT) {
        caveats.push(`${file.path}:${sheet.name} manifest includes first ${TABLE_EXTRACTION_MANIFEST_FIELD_LIMIT} of ${sheet.columns.length} fields; use columnsPointer for the full list.`);
      }
      if (sheet.records.length > TABLE_EXTRACTION_MANIFEST_SAMPLE_RECORD_LIMIT) {
        caveats.push(`${file.path}:${sheet.name} manifest includes ${TABLE_EXTRACTION_MANIFEST_SAMPLE_RECORD_LIMIT} sample records; use recordsPointer for the full records.`);
      }
      tables.push({
        tableId: `file:${fileIndex}:sheet:${sheet.index}`,
        filePath: file.path,
        fileIndex,
        sheetName: sheet.name,
        sheetIndex: sheet.index,
        sheetPointer,
        rowsPointer: `${sheetPointer}/rows`,
        recordsPointer: `${sheetPointer}/records`,
        columnsPointer: `${sheetPointer}/columns`,
        sourceRange: sheet.sourceRange,
        headerRange: sheet.header?.range,
        rowCount: sheet.rowCount,
        recordCount: sheet.recordCount,
        cellCount: sheet.cellCount,
        ...(recordRows === undefined ? {} : { recordRows }),
        fields: sheet.columns.slice(0, TABLE_EXTRACTION_MANIFEST_FIELD_LIMIT).map((column) => ({
          name: column.name,
          address: column.address,
          index: column.index,
          sourceAddress: column.sourceAddress,
          nonEmptyCellCount: column.nonEmptyCellCount,
          valueKinds: column.valueKinds,
        })),
        sampleRecords: sheet.records.slice(0, TABLE_EXTRACTION_MANIFEST_SAMPLE_RECORD_LIMIT).map((record) => ({
          row: record.row,
          sourceRange: record.sourceRange,
          values: record.values,
        })),
        sourceRanges: uniqueStrings([
          sheet.sourceRange,
          sheet.header?.range,
          ...sheet.records.slice(0, TABLE_EXTRACTION_MANIFEST_SAMPLE_RECORD_LIMIT).map((record) => record.sourceRange),
        ].filter((item): item is string => item !== undefined && item.length > 0)),
        truncated: sheet.truncated,
      });
    });
  });
  if (totalTableCount > TABLE_EXTRACTION_MANIFEST_TABLE_LIMIT) {
    caveats.push(`Manifest includes first ${TABLE_EXTRACTION_MANIFEST_TABLE_LIMIT} of ${totalTableCount} tables; use the artifact root profile or JSON paths for omitted sheets.`);
  }
  return {
    schema: "agentloop.tableExtractionArtifactManifest/v1",
    artifactSchema: extraction.schema,
    totalFiles: extraction.files.length,
    totalTables: totalTableCount,
    totalRows: extraction.totalRows,
    totalRecords: extraction.totalRecords,
    totalCells: extraction.totalCells,
    truncated: caveats.length > 0,
    caveats: uniqueStrings(caveats),
    tables,
  };
}

function assertInsideRoot(path: string, root: string): void {
  const rel = relative(root, path);
  if (rel === "" || (!rel.startsWith("..") && rel !== ".." && !isAbsolute(rel))) return;
  throw forbidden("Resolved artifact path must stay inside the Runtime workspace root");
}

function requireBoundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw badRequest(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function objectSchema(required: readonly string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required, properties };
}

function readFileInputSchema(required: readonly string[], properties: Record<string, unknown>): Record<string, unknown> {
  return {
    ...objectSchema(required, properties),
    allOf: [
      { not: { required: ["ranges", "offset"] } },
      { not: { required: ["ranges", "limit"] } },
    ],
  };
}

function sourceReadableFileInputSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    anyOf: [{ required: ["rootId", "path"] }, { required: ["sourceRef"] }],
    properties,
    allOf: [
      { not: { required: ["ranges", "offset"] } },
      { not: { required: ["ranges", "limit"] } },
    ],
  };
}

function sourceReadableBatchEntrySchema(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    anyOf: [{ required: ["path"] }, { required: ["sourceRef"] }],
    properties,
    allOf: [
      { not: { required: ["ranges", "offset"] } },
      { not: { required: ["ranges", "limit"] } },
    ],
  };
}

function sourceRefSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      sourceRefId: { type: "string" },
      rootId: { type: "string" },
      path: { type: "string" },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
      lines: {
        type: "array",
        items: { type: "integer", minimum: 1 },
      },
    },
  };
}

function omitUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => omitUndefinedDeep(item)).filter((item) => item !== undefined) as T;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, omitUndefinedDeep(item)] as const)
      .filter(([, item]) => item !== undefined);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
