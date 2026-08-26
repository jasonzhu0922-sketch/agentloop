import { createHash } from "node:crypto";
import { badRequest, forbidden } from "../shared/errors.ts";
import { optionalPositiveInteger, requireRecord, requireString } from "../shared/validation.ts";
import { SourceRepository } from "../storage/repositories/source-repository.ts";
import type { RuntimeTool } from "./tool-registry.ts";

export function createSourceTools(repository: SourceRepository): RuntimeTool<unknown>[] {
  return [{
    name: "read_source",
    description: [
      "Read chunks from uploaded sources authorized for the current Run or conversation.",
      "Use sourceId from sources in runtime context.",
      "When chunkIndex is supplied with maxChunks, read a consecutive window starting at chunkIndex.",
      "This reads extracted source chunks, not arbitrary filesystem paths.",
    ].join(" "),
    inputSchema: objectSchema(["sourceId"], {
      sourceId: { type: "string" },
      chunkIndex: { type: "integer", minimum: 0 },
      query: { type: "string" },
      maxChunks: { type: "integer", minimum: 1, maximum: 10 },
    }),
    executionMode: "parallel",
    replaySafe: true,
    maxResultCharacters: 40_000,
    parse: (value) => {
      const record = requireRecord(value, "read_source arguments");
      return {
        sourceId: requireString(record.sourceId, "sourceId", { max: 80, pattern: /^src_[a-f0-9]{32}$/ }),
        chunkIndex: optionalNonNegativeInteger(record.chunkIndex, "chunkIndex", 100_000),
        query: optionalString(record.query, "query", 200),
        maxChunks: optionalPositiveInteger(record.maxChunks, "maxChunks", 5, 10),
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
      const allChunks = repository.chunks(input.sourceId);
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
  }];
}

function selectChunks(
  chunks: ReturnType<SourceRepository["chunks"]>,
  input: { chunkIndex?: number; query?: string; maxChunks: number },
): ReturnType<SourceRepository["chunks"]> {
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
  chunks: ReturnType<SourceRepository["chunks"]>,
  query: string,
): ReturnType<SourceRepository["chunks"]> {
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

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, label, { max });
}

function optionalNonNegativeInteger(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw badRequest(`${label} must be an integer between 0 and ${maximum}`);
  }
  return value as number;
}
