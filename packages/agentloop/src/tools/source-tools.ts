import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { badRequest, forbidden } from "../shared/errors.ts";
import { optionalPositiveInteger, requireRecord, requireString } from "../shared/validation.ts";
import { SourceRepository } from "../storage/repositories/source-repository.ts";
import { extractSpreadsheetTables } from "../computer/spreadsheet-inspector.ts";
import type { RuntimeTool } from "./tool-registry.ts";
import { writeTableExtractionArtifact, type TableExtractionArtifactManifest } from "./visible-directory-tools.ts";

const DEFAULT_FILTERED_SOURCE_READ_CHUNKS = 5;
const DEFAULT_UNFILTERED_SOURCE_READ_CHUNKS = 10;
const MAX_SOURCE_READ_CHUNKS = 10;

export function createSourceTools(repository: SourceRepository): RuntimeTool<unknown>[] {
  return [{
    name: "read_source",
    description: [
      "Read chunks from uploaded sources authorized for the current Run or conversation.",
      "Use sourceId from sources in runtime context.",
      "Omit query to read source content directly; never pass an empty query.",
      "When chunkIndex is supplied with maxChunks, read a consecutive window starting at chunkIndex.",
      "Without query, the default window reads up to 10 chunks, which is the full source when the upload has 10 or fewer chunks.",
      "Use query only as a non-empty search filter for selecting matching chunks.",
      "This reads extracted source chunks, not arbitrary filesystem paths.",
    ].join(" "),
    inputSchema: objectSchema(["sourceId"], {
      sourceId: { type: "string" },
      chunkIndex: { type: "integer", minimum: 0 },
      query: {
        type: "string",
        description: "Optional non-empty search filter. Omit this field for full/windowed source reading; do not pass an empty string.",
      },
      maxChunks: { type: "integer", minimum: 1, maximum: MAX_SOURCE_READ_CHUNKS },
    }),
    executionMode: "parallel",
    replaySafe: true,
    maxResultCharacters: 40_000,
    parse: (value) => {
      const record = requireRecord(value, "read_source arguments");
      const query = optionalSourceQuery(record.query, "query", 200);
      return {
        sourceId: requireString(record.sourceId, "sourceId", { max: 80, pattern: /^src_[a-f0-9]{32}$/ }),
        chunkIndex: optionalNonNegativeInteger(record.chunkIndex, "chunkIndex", 100_000),
        query,
        maxChunks: optionalPositiveInteger(
          record.maxChunks,
          "maxChunks",
          query === undefined ? DEFAULT_UNFILTERED_SOURCE_READ_CHUNKS : DEFAULT_FILTERED_SOURCE_READ_CHUNKS,
          MAX_SOURCE_READ_CHUNKS,
        ),
      };
    },
    execute: async (context, value) => {
      const input = value as {
        sourceId: string;
        chunkIndex?: number;
        query?: string;
        maxChunks: number;
      };
      const source = (context.grant.uploadedSources ?? []).find((item) => item.id === input.sourceId);
      if (source === undefined) throw forbidden("Source is not authorized for this run");
      if (source.status !== "ready") throw badRequest(`Source is not ready: ${source.status}`);
      const allChunks = await repository.chunks(input.sourceId);
      const selectedChunks = selectChunks(allChunks, input);
      const chunks = selectedChunks.slice(0, input.maxChunks);
      const caveats = sourceReadCaveats({
        sourceTruncated: source.truncated,
        selectedCount: selectedChunks.length,
        returnedCount: chunks.length,
        totalCount: allChunks.length,
        input,
      });
      const caveatedKinds = [
        ...(chunks.length === 0 ? ["source_summary"] : []),
        ...(caveats.length === 0 ? [] : ["explicit_caveats"]),
      ];
      return {
        schema: "agentloop.uploadedSourceRead/v1",
        sourceId: source.id,
        originalName: source.originalName,
        totalChunks: allChunks.length,
        returnedChunks: chunks.length,
        selectedChunks: selectedChunks.length,
        truncated: source.truncated,
        chunks: chunks.map((chunk) => ({
          chunkIndex: chunk.chunk_index,
          kind: chunk.kind,
          locator: chunk.locator,
          sha256: chunk.sha256,
          content: chunk.content,
        })),
        evidenceReceipt: {
          schema: "agentloop.toolEvidenceReceipt/v1",
          sourceType: "uploaded_source",
          receiptId: createHash("sha256").update([
            source.id,
            ...chunks.map((chunk) => chunk.sha256),
          ].join("\n")).digest("hex"),
          sourceRefs: chunks.map((chunk) => ({
            sourceId: source.id,
            chunkIndex: chunk.chunk_index,
            locator: chunk.locator,
            sha256: chunk.sha256,
          })),
          facts: [{
            kind: "source_chunks",
            sourceId: source.id,
            originalName: source.originalName,
            totalChunkCount: allChunks.length,
            selectedChunkCount: selectedChunks.length,
            returnedChunkCount: chunks.length,
            returnedChunkIndexes: chunks.map((chunk) => chunk.chunk_index),
            selectedBy: input.query === undefined ? "chunkIndex" : "query",
          }],
          caveats,
          evidenceKinds: {
            satisfied: chunks.length === 0
              ? []
              : ["source_summary", ...(caveats.length === 0 ? ["explicit_caveats"] : [])],
            caveated: caveatedKinds,
            failed: [],
          },
        },
      };
    },
  }, {
    name: "extract_source_tables",
    description: [
      "Extract bounded, coordinate-preserving table records from one authorized uploaded CSV, XLSX, or XLSM source.",
      "Use sourceId from sources in runtime context. This reads the server-owned original through the source grant; it never exposes an upload storage path.",
      "Returns sheets, cells, header-derived columns, records, source ranges, counts, hashes, caveats, and a durable JSON artifact under the Runtime workspace.",
      "Use this instead of reconstructing a spreadsheet from read_source text when field-based analysis, grouping, or counting is needed.",
    ].join(" "),
    inputSchema: objectSchema(["sourceId"], {
      sourceId: { type: "string" },
      maxRowsPerSheet: { type: "integer", minimum: 1, maximum: 2_000 },
      maxTotalCells: { type: "integer", minimum: 1, maximum: 100_000 },
    }),
    executionMode: "parallel",
    replaySafe: true,
    maxResultCharacters: 250_000,
    parse: (value) => {
      const record = requireRecord(value, "extract_source_tables arguments");
      return {
        sourceId: requireString(record.sourceId, "sourceId", { max: 80, pattern: /^src_[a-f0-9]{32}$/ }),
        maxRowsPerSheet: optionalBoundedInteger(record.maxRowsPerSheet, "maxRowsPerSheet", 1, 2_000),
        maxTotalCells: optionalBoundedInteger(record.maxTotalCells, "maxTotalCells", 1, 100_000),
      };
    },
    execute: async (context, value) => {
      const input = value as { sourceId: string; maxRowsPerSheet?: number; maxTotalCells?: number };
      const source = (context.grant.uploadedSources ?? []).find((item) => item.id === input.sourceId);
      if (source === undefined) throw forbidden("Source is not authorized for this run");
      if (source.status !== "ready") throw badRequest(`Source is not ready: ${source.status}`);
      if (!isStructuredSpreadsheetExtension(source.extension)) {
        throw badRequest(`extract_source_tables supports .csv, .xlsx, and .xlsm uploads; received ${source.extension || "an extensionless source"}`);
      }
      if (context.grant.workspaceRoot === undefined) {
        throw badRequest("extract_source_tables requires a Runtime workspaceRoot to write a durable extraction artifact");
      }
      const row = await repository.requireByOwner(context.grant.actorUserId, input.sourceId);
      const stat = await fs.stat(row.storage_path).catch(() => undefined);
      if (stat === undefined || !stat.isFile()) throw badRequest("Authorized source original is unavailable for structured extraction");
      const extraction = await extractSpreadsheetTables(".", [{
        path: source.originalName,
        bytes: stat.size,
        readPath: row.storage_path,
      }], {
        maxRowsPerSheet: input.maxRowsPerSheet,
        maxTotalCells: input.maxTotalCells,
      });
      const artifact = await writeTableExtractionArtifact(context.grant.workspaceRoot, extraction);
      const result = {
        sourceId: source.id,
        originalName: source.originalName,
        sourceSha256: source.sha256,
        ...extraction,
        artifact,
      };
      return {
        ...result,
        evidenceReceipt: uploadedTableExtractionReceipt(result),
      };
    },
  }];
}

function isStructuredSpreadsheetExtension(extension: string): boolean {
  return extension === ".csv" || extension === ".xlsx" || extension === ".xlsm";
}

function uploadedTableExtractionReceipt(result: {
  readonly sourceId: string;
  readonly originalName: string;
  readonly sourceSha256: string;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly sheets: readonly {
      readonly name: string;
      readonly sourceRange?: string;
      readonly rowCount: number;
      readonly recordCount: number;
      readonly cellCount: number;
      readonly truncated: boolean;
    }[];
    readonly truncated: boolean;
    readonly error?: string;
  }[];
  readonly requested: number;
  readonly returned: number;
  readonly totalRows: number;
  readonly totalRecords: number;
  readonly totalCells: number;
  readonly truncated: boolean;
  readonly sha256: string;
  readonly caveats: readonly string[];
  readonly artifact: {
    readonly schema: string;
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly manifest: TableExtractionArtifactManifest;
    readonly caveats: readonly string[];
  };
}) {
  return {
    schema: "agentloop.toolEvidenceReceipt/v1",
    sourceType: "uploaded_table_extraction",
    receiptId: createHash("sha256").update([result.sourceId, result.sourceSha256, result.sha256].join("\n")).digest("hex"),
    sourceRefs: result.files.map((file) => ({
      sourceId: result.sourceId,
      originalName: result.originalName,
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
      ...(file.error === undefined ? {} : { error: file.error }),
    })),
    facts: [{
      kind: "structured_table_extraction",
      sourceId: result.sourceId,
      originalName: result.originalName,
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
    evidenceKinds: {
      satisfied: ["source_summary", "source_read", "source_refs", "schema_summary", "record_counts", "structured_extraction_artifact"],
      caveated: result.caveats.length === 0 ? [] : ["explicit_caveats"],
      failed: [],
    },
  };
}

function selectChunks(
  chunks: Awaited<ReturnType<SourceRepository["chunks"]>>,
  input: { chunkIndex?: number; query?: string; maxChunks: number },
): Awaited<ReturnType<SourceRepository["chunks"]>> {
  const startChunkIndex = input.chunkIndex;
  const candidates = startChunkIndex === undefined
    ? chunks
    : chunks
      .filter((chunk) => chunk.chunk_index >= startChunkIndex)
      .slice(0, input.maxChunks);
  if (input.query !== undefined) {
    return searchChunks(candidates, input.query);
  }
  return candidates;
}

function sourceReadCaveats(input: {
  sourceTruncated: boolean;
  selectedCount: number;
  returnedCount: number;
  totalCount: number;
  input: { chunkIndex?: number; query?: string; maxChunks: number };
}): string[] {
  const caveats: string[] = [];
  if (input.returnedCount === 0) {
    caveats.push("No source chunks matched the requested selector.");
  }
  if (input.selectedCount > input.returnedCount) {
    caveats.push(`Only ${input.returnedCount} of ${input.selectedCount} matching source chunks were returned; increase maxChunks or read a later chunkIndex for more content.`);
  }
  if (
    input.input.chunkIndex === undefined
    && input.input.query === undefined
    && input.returnedCount > 0
    && input.returnedCount < input.totalCount
  ) {
    caveats.push(`Only ${input.returnedCount} of ${input.totalCount} source chunks were returned; read additional chunkIndex values for complete content.`);
  }
  if (input.sourceTruncated) {
    caveats.push("The uploaded source extraction was truncated; unavailable content must be explicitly caveated.");
  }
  return caveats;
}

function searchChunks(
  chunks: Awaited<ReturnType<SourceRepository["chunks"]>>,
  query: string,
): Awaited<ReturnType<SourceRepository["chunks"]>> {
  const normalizedQuery = normalizeSourceQuery(query);
  if (normalizedQuery.length === 0) return chunks;
  const exactMatches = chunks.filter((chunk) =>
    normalizeSourceQuery(chunk.content).includes(normalizedQuery)
  );
  if (exactMatches.length > 0) return exactMatches;
  const terms = sourceQueryTerms(normalizedQuery);
  if (terms.length === 0) return [];
  return chunks
    .map((chunk) => ({
      chunk,
      score: sourceQueryScore(normalizeSourceQuery(chunk.content), terms),
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.chunk.chunk_index - right.chunk.chunk_index)
    .map((match) => match.chunk);
}

function sourceQueryScore(content: string, terms: readonly string[]): number {
  return terms.reduce((score, term) => score + (content.includes(term) ? 1 : 0), 0);
}

function sourceQueryTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of query.split(/[\s,，;；、|/\\()[\]{}"'“”‘’<>《》:：.!?！？]+/u)) {
    if (term.length < 2 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function normalizeSourceQuery(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

function objectSchema(required: readonly string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required, properties };
}

function optionalSourceQuery(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  return requireString(value, label, { max });
}

function optionalNonNegativeInteger(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw badRequest(`${label} must be an integer between 0 and ${maximum}`);
  }
  return value as number;
}

function optionalBoundedInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw badRequest(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}
