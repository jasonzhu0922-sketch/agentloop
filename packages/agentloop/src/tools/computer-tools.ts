import { createHash } from "node:crypto";
import { badRequest } from "../shared/errors.ts";
import { requireRecord, requireString } from "../shared/validation.ts";
import { buildArtifactReceipt } from "../runtime/artifact-receipt.ts";
import type { RuntimeTool, ToolExecutionContext } from "./tool-registry.ts";
import { ArtifactAcceptanceService, type ArtifactAcceptanceKind } from "../acceptance/artifact-acceptance.ts";
import type { ComputerDriver } from "../computer/computer-driver.ts";
import { ComputerExecutor, type CommandRootMount } from "../computer/computer-executor.ts";
import type { PatchFileInput, WriteFileMode } from "../computer/computer-executor.ts";
import { parsePaginatedHtmlMaterializeInput, renderPaginatedHtml } from "./paginated-html-materializer.ts";

const MAX_COMMAND_ARGUMENTS = 200;
const MAX_COMMAND_ARGUMENT_CHARACTERS = 4_096;
const MAX_COMMAND_ARGUMENTS_TOTAL_CHARACTERS = 65_536;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MIN_COMMAND_TIMEOUT_MS = 100;
const MAX_COMMAND_TIMEOUT_MS = 300_000;
const JSON_READ_MAX_BYTES = 8_000_000;
const JSON_READ_MAX_QUERIES = 20;
const JSON_READ_MAX_POINTER_LENGTH = 1_000;
const JSON_READ_MAX_ARRAY_LIMIT = 500;
const TABLE_ARTIFACT_SUMMARY_MAX_TABLES = 200;
const TABLE_ARTIFACT_SUMMARY_MAX_SAMPLE_RECORDS = 5;
const TABLE_ARTIFACT_SUMMARY_MAX_TEXT_SAMPLES = 6;
const TABLE_ARTIFACT_AGGREGATION_MAX_QUERIES = 20;
const TABLE_ARTIFACT_AGGREGATION_MAX_GROUPS = 500;

export const DANGEROUS_COMPUTER_TOOL_NAMES = new Set([
  "convert_artifact",
  "materialize_paginated_html",
  "computer_patch_file",
  "computer_write_file",
  "computer_run_command",
  "computer_click",
  "computer_type_text",
  "computer_press_key",
  "computer_navigate",
]);

export function createComputerTools(
  executor: ComputerExecutor,
  driver?: ComputerDriver,
  acceptanceService = new ArtifactAcceptanceService(),
): RuntimeTool<unknown>[] {
  const tools: RuntimeTool<unknown>[] = [
    {
      name: "computer_list_directory",
      description: "List entries under the configured workspace root or an authorized read-only @skills/<skill-name> root. path must be relative to an authorized root; absolute paths are rejected.",
      inputSchema: objectSchema(["path"], { path: { type: "string" } }),
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => ({ path: rootPathString(value, "path", 4_000) }),
      execute: async (context, value) => executorForContext(executor, context).listDirectory((value as { path: string }).path),
    },
    {
      name: "computer_read_file",
      description: [
        "Read a UTF-8 file under the configured workspace root or an authorized read-only @skills/<skill-name> root.",
        "path must be relative to an authorized root; absolute paths are rejected.",
        "For loaded Skill reference files, use @skills/<skill-name>/... paths with this tool instead of shell cat/sed loops.",
        "If a bare filename is missing at the workspace root, the tool searches authorized subdirectories by basename; unique ranked matches are read and ambiguous matches return candidate paths.",
        "Use optional 1-indexed offset and limit for one line window, or ranges for multiple line windows; do not combine ranges with offset or limit.",
      ].join(" "),
      inputSchema: readFileInputSchema(["path"], {
        path: { type: "string" },
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
      parse: (value) => {
        const record = requireRecord(value, "computer_read_file arguments");
        if (record.ranges !== undefined && (record.offset !== undefined || record.limit !== undefined)) {
          throw badRequest("ranges cannot be combined with offset or limit");
        }
        return {
          path: requireString(record.path, "path", { max: 4_000 }),
          offset: optionalPositiveInteger(record.offset, "offset"),
          limit: optionalPositiveInteger(record.limit, "limit"),
          ranges: parseReadRanges(record.ranges),
        };
      },
      execute: async (context, value) => {
        const input = value as { path: string; offset?: number; limit?: number; ranges?: Array<{ offset: number; limit?: number }> };
        return executorForContext(executor, context).readFile(input.path, undefined, {
          offset: input.offset,
          limit: input.limit,
          ranges: input.ranges,
        });
      },
    },
    {
      name: "computer_find_files",
      description: [
        "Find files under the configured workspace root or an authorized read-only @skills/<skill-name> root using a glob pattern; respects root containment and skips .git and node_modules.",
        "Use this for low-noise discovery before reading files or running commands.",
        "path is optional and relative to an authorized root; pattern supports *, **, and ?; limit defaults to 1000.",
      ].join(" "),
      inputSchema: objectSchema(["pattern"], {
        pattern: { type: "string" },
        path: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 10_000 },
      }),
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => {
        const record = requireRecord(value, "computer_find_files arguments");
        return {
          path: record.path === undefined || record.path === "" ? "." : requireString(record.path, "path", { max: 4_000 }),
          pattern: requireString(record.pattern, "pattern", { max: 1_000 }),
          limit: optionalPositiveInteger(record.limit, "limit"),
        };
      },
      execute: async (context, value) => {
        const input = value as { path: string; pattern: string; limit?: number };
        return executorForContext(executor, context).findFiles(input.path, input.pattern, { limit: input.limit });
      },
    },
    {
      name: "verify_artifact_acceptance",
      description: [
        "Produce one aggregate artifact acceptance evidence object for a file under the workspace root.",
        "Use this after creating or locating a deliverable to record artifact_path, artifact_non_empty, artifact_openable, format_matches_request, explicit caveats, and artifact_acceptance evidence.",
        "Profiles cover generic_file, html, html_ppt, docx, xlsx, pptx, pdf, markdown, image, and json.",
        "This read-only tool performs deterministic local structure/package checks, including lightweight image decoding for dimensions; browser, PDF, or Office render checks are reported as skipped_unavailable unless a renderer is later wired into this same acceptance boundary.",
      ].join(" "),
      inputSchema: objectSchema(["artifactPath"], {
        artifactPath: { type: "string" },
        artifactKind: artifactKindSchema(),
        profileId: artifactKindSchema(),
        checks: {
          type: "array",
          maxItems: MAX_ACCEPTANCE_CHECKS,
          items: { type: "string", maxLength: MAX_ACCEPTANCE_CHECK_CHARACTERS },
        },
      }),
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => {
        const record = requireRecord(value, "verify_artifact_acceptance arguments");
        return {
          artifactPath: requireString(record.artifactPath, "artifactPath", { max: 4_000 }),
          artifactKind: optionalArtifactKind(record.artifactKind, "artifactKind"),
          profileId: optionalArtifactKind(record.profileId, "profileId"),
          checks: parseOptionalStringArray(record.checks, "checks", MAX_ACCEPTANCE_CHECKS, MAX_ACCEPTANCE_CHECK_CHARACTERS),
        };
      },
      execute: async (context, value) => acceptanceService.verify(
        executorForContext(executor, context),
        value as {
          artifactPath: string;
          artifactKind?: ArtifactAcceptanceKind;
          profileId?: ArtifactAcceptanceKind;
          checks?: readonly string[];
        },
        { signal: context.signal },
      ),
    },
    {
      name: "computer_search_text",
      description: [
        "Search literal text recursively under the configured workspace root or an authorized read-only @skills/<skill-name> root.",
        "path must be relative to an authorized root; absolute paths are rejected.",
        "Use this low-noise search tool instead of running shell grep/cat loops for file discovery.",
        "For structured JSON artifacts, use computer_read_json with schema/profile or JSON Pointer first; use text search only when the keyword location is unknown or the manifest is insufficient.",
        "Use optional contextBefore/contextAfter to return small evidence windows around each match.",
      ].join(" "),
      inputSchema: objectSchema(["path", "query"], {
        path: { type: "string" },
        query: { type: "string" },
        maxMatches: { type: "integer", minimum: 1, maximum: 200 },
        contextBefore: { type: "integer", minimum: 0, maximum: 20 },
        contextAfter: { type: "integer", minimum: 0, maximum: 20 },
      }),
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => {
        const record = requireRecord(value, "computer_search_text arguments");
        return {
          path: rootPathString(record, "path", 4_000),
          query: requireString(record.query, "query", { max: 2_000 }),
          maxMatches: optionalBoundedInteger(record.maxMatches, "maxMatches", 1, 200),
          contextBefore: optionalBoundedInteger(record.contextBefore, "contextBefore", 0, 20),
          contextAfter: optionalBoundedInteger(record.contextAfter, "contextAfter", 0, 20),
        };
      },
      execute: async (_context, value) => {
        const input = value as { path: string; query: string; maxMatches?: number; contextBefore?: number; contextAfter?: number };
        return executorForContext(executor, _context).searchText(input.path, input.query, {
          maxMatches: input.maxMatches,
          contextBefore: input.contextBefore,
          contextAfter: input.contextAfter,
        });
      },
    },
    {
      name: "computer_read_json",
      description: [
        "Read structured data from a JSON file under the configured workspace root or an authorized read-only @skills/<skill-name> root.",
        "Use this for durable JSON artifacts such as .agentloop/table-extractions/*.json before falling back to computer_search_text or line-window computer_read_file.",
        "queries are JSON Pointer selectors; omit queries to get a compact profile. For array targets, offset is 0-indexed and limit returns a bounded window.",
        "The result includes schema, path, sha256, root profile, selected values, source pointers, counts, and caveats without interpreting business semantics.",
      ].join(" "),
      inputSchema: objectSchema(["path"], {
        path: { type: "string" },
        queries: {
          type: "array",
          minItems: 1,
          maxItems: JSON_READ_MAX_QUERIES,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["pointer"],
            properties: {
              // The root profile is requested by omitting `queries`; an empty
              // JSON Pointer is not a supported selector and must be rejected
              // consistently by both the exposed schema and parser.
              pointer: { type: "string", minLength: 1, maxLength: JSON_READ_MAX_POINTER_LENGTH },
              offset: { type: "integer", minimum: 0 },
              limit: { type: "integer", minimum: 1, maximum: JSON_READ_MAX_ARRAY_LIMIT },
            },
          },
        },
      }),
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => {
        const record = requireRecord(value, "computer_read_json arguments");
        return {
          path: requireString(record.path, "path", { max: 4_000 }),
          queries: parseJsonReadQueries(record.queries),
        };
      },
      execute: async (context, value) => {
        const input = value as { path: string; queries?: JsonReadQuery[] };
        const file = await executorForContext(executor, context).readFile(input.path, JSON_READ_MAX_BYTES);
        if (file.truncated) {
          throw badRequest(`JSON file exceeds the ${JSON_READ_MAX_BYTES} byte structured read limit; use narrower source tooling or a purpose-built parser`);
        }
        let document: unknown;
        try {
          document = JSON.parse(file.content);
        } catch {
          throw badRequest("path must identify a valid JSON file");
        }
        const queries = input.queries ?? [];
        const caveats: string[] = [];
        const results = queries.map((query) => readJsonPointer(document, query, caveats));
        return {
          schema: "agentloop.jsonRead/v1",
          path: file.resolvedPath ?? input.path,
          ...(file.requestedPath === undefined ? {} : { requestedPath: file.requestedPath }),
          bytes: file.bytes,
          sha256: createHash("sha256").update(file.content).digest("hex"),
          root: summarizeJsonValue(document),
          queries: results,
          caveats,
        };
      },
    },
    {
      name: "computer_summarize_table_artifact",
      description: [
        "Summarize a durable agentloop.visibleTableExtraction/v1 JSON artifact under the workspace root.",
        "Use this before manual computer_read_json windows when a downstream analysis must cover many extracted tables/files.",
        "Returns every manifest table up to a bounded limit, field names, record counts, source ranges, compact numeric statistics, representative text samples, and caveats without interpreting business semantics.",
      ].join(" "),
      inputSchema: objectSchema(["path"], {
        path: { type: "string" },
        maxTables: { type: "integer", minimum: 1, maximum: TABLE_ARTIFACT_SUMMARY_MAX_TABLES },
        sampleRecords: { type: "integer", minimum: 0, maximum: TABLE_ARTIFACT_SUMMARY_MAX_SAMPLE_RECORDS },
      }),
      executionMode: "parallel",
      replaySafe: true,
      maxResultCharacters: 120_000,
      parse: (value) => {
        const record = requireRecord(value, "computer_summarize_table_artifact arguments");
        return {
          path: requireString(record.path, "path", { max: 4_000 }),
          maxTables: optionalBoundedInteger(record.maxTables, "maxTables", 1, TABLE_ARTIFACT_SUMMARY_MAX_TABLES),
          sampleRecords: optionalBoundedInteger(record.sampleRecords, "sampleRecords", 0, TABLE_ARTIFACT_SUMMARY_MAX_SAMPLE_RECORDS),
        };
      },
      execute: async (context, value) => {
        const input = value as { path: string; maxTables?: number; sampleRecords?: number };
        const file = await executorForContext(executor, context).readFile(input.path, JSON_READ_MAX_BYTES);
        if (file.truncated) {
          throw badRequest(`JSON file exceeds the ${JSON_READ_MAX_BYTES} byte structured read limit; use narrower source tooling or a purpose-built parser`);
        }
        let document: unknown;
        try {
          document = JSON.parse(file.content);
        } catch {
          throw badRequest("path must identify a valid JSON file");
        }
        return summarizeTableExtractionArtifact({
          path: file.resolvedPath ?? input.path,
          requestedPath: file.requestedPath,
          bytes: file.bytes,
          sha256: createHash("sha256").update(file.content).digest("hex"),
          document,
          maxTables: input.maxTables ?? TABLE_ARTIFACT_SUMMARY_MAX_TABLES,
          sampleRecords: input.sampleRecords ?? 2,
        });
      },
    },
    {
      name: "computer_aggregate_table_artifact",
      description: [
        "Derive deterministic count, group-count, sum, average, minimum, or maximum statistics from a durable agentloop.visibleTableExtraction/v1 JSON artifact.",
        "Use this for a downstream count, grouping, distribution, ranking, or numeric aggregate question after structured extraction; it reads every selected record and returns coverage, source ranges, filters, values/groups, and a reusable derived_aggregation evidence receipt.",
        "This Tool preserves data semantics only. It does not decide business labels or write the user-facing conclusion.",
      ].join(" "),
      inputSchema: objectSchema(["path", "queries"], {
        path: { type: "string" },
        queries: {
          type: "array",
          minItems: 1,
          maxItems: TABLE_ARTIFACT_AGGREGATION_MAX_QUERIES,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["operation"],
            properties: {
              operation: { type: "string", enum: ["count", "sum", "average", "min", "max"] },
              field: { type: "string", minLength: 1, maxLength: 512 },
              groupBy: { type: "string", minLength: 1, maxLength: 512 },
              order: { type: "string", enum: ["asc", "desc"] },
              maxGroups: { type: "integer", minimum: 1, maximum: TABLE_ARTIFACT_AGGREGATION_MAX_GROUPS },
              where: {
                type: "array",
                maxItems: 20,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["field", "equals"],
                  properties: {
                    field: { type: "string", minLength: 1, maxLength: 512 },
                    equals: { type: ["string", "number", "boolean"] },
                  },
                },
              },
            },
          },
        },
      }),
      executionMode: "parallel",
      replaySafe: true,
      maxResultCharacters: 120_000,
      parse: (value) => {
        const record = requireRecord(value, "computer_aggregate_table_artifact arguments");
        return {
          path: requireString(record.path, "path", { max: 4_000 }),
          queries: parseTableArtifactAggregationQueries(record.queries),
        };
      },
      execute: async (context, value) => {
        const input = value as { path: string; queries: readonly TableArtifactAggregationQuery[] };
        const scopedExecutor = executorForContext(executor, context);
        const file = await scopedExecutor.readFile(input.path, JSON_READ_MAX_BYTES);
        if (file.truncated) {
          throw badRequest(`JSON file exceeds the ${JSON_READ_MAX_BYTES} byte structured read limit; use a narrower artifact or purpose-built parser`);
        }
        let document: unknown;
        try {
          document = JSON.parse(file.content);
        } catch {
          throw badRequest("path must identify a valid JSON file");
        }
        const aggregation = aggregateTableExtractionArtifact({
          path: file.resolvedPath ?? input.path,
          requestedPath: file.requestedPath,
          bytes: file.bytes,
          sha256: createHash("sha256").update(file.content).digest("hex"),
          document,
          queries: input.queries,
        });
        const materialization = JSON.stringify({
          schema: "agentloop.tableAggregationResult/v1",
          sourceArtifact: {
            path: aggregation.path,
            sha256: aggregation.sha256,
            sourceSchema: aggregation.sourceSchema,
          },
          coverage: aggregation.coverage,
          results: aggregation.materializedResults,
          caveats: aggregation.caveats,
        });
        const resultHash = createHash("sha256").update(materialization).digest("hex");
        const stored = await scopedExecutor.writeFile(
          `.agentloop/table-aggregations/${resultHash.slice(0, 2)}/${resultHash}.json`,
          materialization,
          "overwrite",
        );
        const resultRef = tableAggregationResultRef({
          path: stored.path,
          sha256: stored.sha256,
          coverage: aggregation.coverage,
          results: aggregation.materializedResults,
        });
        const { materializedResults: _materializedResults, ...response } = aggregation;
        return {
          ...response,
          resultRef,
          evidenceReceipt: {
            ...response.evidenceReceipt,
            facts: response.evidenceReceipt.facts.map((fact) => ({ ...fact, resultRef })),
          },
        };
      },
    },
    {
      name: "computer_write_file",
      description: [
        "Create, overwrite, or append to a UTF-8 file under the workspace root; requires dangerous-tool consent.",
        "path must be relative to the workspace root; absolute paths are rejected.",
        "Use only mode for write behavior: create, overwrite, or append; omit mode for create. Append requires an existing file, so create the first chunk with mode=create.",
        "For explicitly paginated HTML, HTML-PPT, or browser slide decks that fit a compact page spec, use materialize_paginated_html instead of streaming the full generated document here.",
        "For ordinary standalone HTML, custom visual pages, dashboards, apps, or interactions, this Tool may write the authored HTML/CSS/JS file directly.",
        "For other very large content, prefer reusable scripts or several smaller append calls over one oversized call so each content argument stays within the output budget.",
        "The result includes the write mode, bytes written by this call, final file sha256, final byte size, line count, Markdown-style outline, and bounded first/last sample ranges as write-after-inspection evidence; cite that receipt before rereading the whole file.",
      ].join(" "),
      inputSchema: objectSchema(["path", "content"], {
        path: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["create", "overwrite", "append"] },
      }),
      executionMode: "exclusive",
      replaySafe: false,
      parse: (value) => {
        const record = requireRecord(value, "computer_write_file arguments");
        if (record.overwrite !== undefined && typeof record.overwrite !== "boolean") {
          throw badRequest("overwrite must be boolean");
        }
        const mode = parseWriteFileMode(record.mode, record.overwrite);
        if (typeof record.content !== "string") {
          if (typeof record.schema === "string" && record.schema.startsWith("agentloop.contextArtifact")) {
            throw badRequest(
              "content must be a string; received a read-only artifact evidence projection, not executable write_file arguments",
            );
          }
          throw badRequest("content must be a string");
        }
        if (record.content.length > 1_000_000) {
          throw badRequest("content must contain at most 1000000 characters");
        }
        return {
          path: requireString(record.path, "path", { max: 4_000 }),
          content: record.content,
          mode,
        };
      },
      execute: async (_context, value) => {
        const input = value as { path: string; content: string; mode: WriteFileMode };
        const receipt = await executorForContext(executor, _context).writeFile(input.path, input.content, input.mode);
        return {
          ...receipt,
          artifactReceipt: buildArtifactReceipt("computer_write_file", receipt, {
            writeMode: receipt.mode,
            writtenBytes: receipt.writtenBytes,
          }),
        };
      },
    },
    {
      name: "computer_patch_file",
      description: [
        "Patch an existing UTF-8 text file under the workspace root by replacing one exact fragment; requires dangerous-tool consent.",
        "Use this for local repairs to an existing artifact or generated source file instead of rewriting the whole file with computer_write_file.",
        "path must be relative to the workspace root; absolute paths and read-only virtual roots are rejected.",
        "oldText must match the current file exactly once; zero matches or multiple matches fail closed. Provide a larger surrounding fragment when needed.",
        "expectedSha256 is optional but should be set when a prior receipt or read result exposed the current file hash.",
        "The result includes schema agentloop.filePatch/v1, before/after sha256 and byte counts, hunk line metadata, final inspection, and a standard artifactReceipt. After patching a deliverable, call verify_artifact_acceptance for the patched artifact.",
      ].join(" "),
      inputSchema: objectSchema(["path", "oldText", "newText"], {
        path: { type: "string" },
        oldText: { type: "string", minLength: 1, maxLength: 500_000 },
        newText: { type: "string", maxLength: 500_000 },
        expectedSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      }),
      executionMode: "exclusive",
      replaySafe: false,
      parse: (value) => {
        const record = requireRecord(value, "computer_patch_file arguments");
        return {
          path: requireString(record.path, "path", { max: 4_000 }),
          oldText: requirePatchText(record.oldText, "oldText", { min: 1, max: 500_000 }),
          newText: requirePatchText(record.newText, "newText", { min: 0, max: 500_000 }),
          expectedSha256: record.expectedSha256 === undefined
            ? undefined
            : requireString(record.expectedSha256, "expectedSha256", { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/u }),
        };
      },
      execute: async (_context, value) => {
        const receipt = await executorForContext(executor, _context).patchFile(value as PatchFileInput);
        return {
          ...receipt,
          artifactReceipt: buildArtifactReceipt("computer_patch_file", {
            path: receipt.path,
            bytes: receipt.after.bytes,
            sha256: receipt.after.sha256,
            characters: receipt.after.characters,
            totalLines: receipt.after.totalLines,
            inspection: receipt.inspection,
          }, {
            writeMode: "patch",
            writtenBytes: Buffer.byteLength((value as PatchFileInput).newText),
            replacementCount: receipt.replacements,
            beforeSha256: receipt.before.sha256,
            afterSha256: receipt.after.sha256,
          }),
        };
      },
    },
    {
      name: "materialize_paginated_html",
      description: [
        "Create or overwrite a browser-presentable paginated HTML file under the workspace root from a compact structured page specification; requires dangerous-tool consent.",
        "Use only for explicit paginated reports, HTML-PPT, slide decks, training materials, and page-by-page artifacts where each page can be represented as title/subtitle/body/bullets/callout/sourceRefs.",
        "Do not use for ordinary standalone HTML, distinctive visual pages, dashboards, apps, or custom interactions that require authored markup, CSS, or JavaScript beyond the page spec.",
        "Set renderMode to slides for deck-like output; set acceptanceProfile to html_ppt only when the requested artifact is specifically an HTML-PPT or slide deck, otherwise use html.",
        "Do not stream a full HTML document through computer_write_file for this case; pass the page spec here, then verify the resulting file with verify_artifact_acceptance using the same acceptanceProfile.",
        "path must be relative to the workspace root; absolute paths are rejected.",
        "The result includes schema, artifactKind, renderMode, acceptanceProfile, pageCount, specSha256, and the normal write-after-inspection receipt for the generated HTML file.",
      ].join(" "),
      inputSchema: objectSchema(["path", "title", "renderMode", "acceptanceProfile", "pages"], {
        path: { type: "string" },
        title: { type: "string", maxLength: 240 },
        subtitle: { type: "string", maxLength: 500 },
        renderMode: { type: "string", enum: ["slides"] },
        acceptanceProfile: { type: "string", enum: ["html", "html_ppt"] },
        theme: {
          type: "object",
          additionalProperties: false,
          properties: {
            accent: { type: "string", pattern: "^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$" },
            background: { type: "string", pattern: "^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$" },
            text: { type: "string", pattern: "^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$" },
            surface: { type: "string", pattern: "^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$" },
          },
        },
        pages: {
          type: "array",
          minItems: 1,
          maxItems: 80,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title"],
            properties: {
              eyebrow: { type: "string", maxLength: 120 },
              title: { type: "string", maxLength: 240 },
              subtitle: { type: "string", maxLength: 500 },
              body: { type: "string", maxLength: 2_000 },
              bullets: {
                type: "array",
                maxItems: 12,
                items: { type: "string", maxLength: 500 },
              },
              callout: { type: "string", maxLength: 1_000 },
              sourceRefs: {
                type: "array",
                maxItems: 12,
                items: { type: "string", maxLength: 500 },
              },
            },
          },
        },
        overwrite: { type: "boolean" },
      }),
      executionMode: "exclusive",
      replaySafe: false,
      parse: parsePaginatedHtmlMaterializeInput,
      execute: async (context, value) => {
        const input = value as ReturnType<typeof parsePaginatedHtmlMaterializeInput>;
        const rendered = renderPaginatedHtml(input);
        const receipt = await executorForContext(executor, context).writeFile(input.path, rendered.content, input.overwrite);
        return {
          schema: "agentloop.paginatedHtmlMaterialization/v1",
          artifactKind: "html",
          renderMode: input.renderMode,
          acceptanceProfile: input.acceptanceProfile,
          pageCount: rendered.pageCount,
          specSha256: rendered.specSha256,
          ...receipt,
          artifactReceipt: buildArtifactReceipt("materialize_paginated_html", receipt, {
            artifactKind: "html",
            renderMode: input.renderMode,
            acceptanceProfile: input.acceptanceProfile,
            pageCount: rendered.pageCount,
            specSha256: rendered.specSha256,
          }),
        };
      },
    },
    {
      name: "computer_run_command",
      description: [
        "Spawn an executable with an argument array and no shell; requires dangerous-tool consent.",
        "command must be a bare executable name (no path separators or shell syntax).",
        "cwd must be relative to the workspace root; absolute paths are rejected. For an authorized package Skill, cwd may also be the Runtime-provided @skills/<skill-name> execution root shown by load_skill; for an authorized visible directory, cwd may be the Runtime-provided @visible/<root-id> command root.",
        "@skills/<skill-name> and @visible/<root-id> are virtual cwd aliases only; do not pass @skills/... or @visible/... as command arguments or write them into generated scripts as file paths.",
        "Generated scripts that need read-only Skill assets should read the AGENTLOOP_SKILL_ROOT_* environment variable shown in execution context and join package-relative asset paths from there.",
        "When cwd is @skills/<skill-name>, relative task paths in arguments resolve under the read-only Skill package; pass task inputs, outputs, workspaces, and QA directories as absolute paths under the Runtime workspace root.",
        "Command arguments must not reference filesystem paths outside the workspace root, the current command root, or another authorized command root.",
        "Do not use a structured data artifact such as .json, .csv, .tsv, .xlsx, .docx, .pptx, or .pdf as a Python, Node, shell, or other interpreter entry point.",
        "Do not pass multi-line or large inline programs through command arguments; write reusable scripts with computer_write_file, then run the script with a short command.",
        "Large stdout/stderr is returned as a short preview plus stdoutRef/stderrRef path, sha256, and size; inspect that referenced file instead of rerunning the same command solely to recover prior output.",
        "The result includes bounded fileChanges for workspace files created, modified, or deleted by the command; use that structured receipt instead of inferring artifacts from stdout text.",
        `timeoutMs is optional, defaults to ${DEFAULT_COMMAND_TIMEOUT_MS}, and must be between ${MIN_COMMAND_TIMEOUT_MS} and ${MAX_COMMAND_TIMEOUT_MS}.`,
      ].join(" "),
      inputSchema: objectSchema(["command", "args"], {
        command: { type: "string", maxLength: 200 },
        args: {
          type: "array",
          maxItems: MAX_COMMAND_ARGUMENTS,
          items: { type: "string", maxLength: MAX_COMMAND_ARGUMENT_CHARACTERS },
        },
        cwd: { type: "string" },
        timeoutMs: { type: "integer", minimum: MIN_COMMAND_TIMEOUT_MS, maximum: MAX_COMMAND_TIMEOUT_MS },
      }),
      executionMode: "exclusive",
      replaySafe: false,
      parse: (value) => {
        const record = requireRecord(value, "computer_run_command arguments");
        const timeoutMs = record.timeoutMs === undefined ? DEFAULT_COMMAND_TIMEOUT_MS : record.timeoutMs;
        if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < MIN_COMMAND_TIMEOUT_MS || (timeoutMs as number) > MAX_COMMAND_TIMEOUT_MS) {
          throw badRequest(`timeoutMs must be an integer between ${MIN_COMMAND_TIMEOUT_MS} and ${MAX_COMMAND_TIMEOUT_MS}`);
        }
        return {
          command: requireString(record.command, "command", { max: 200 }),
          args: commandArguments(record.args),
          cwd: record.cwd === undefined || record.cwd === "" ? "." : requireString(record.cwd, "cwd", { max: 4_000 }),
          timeoutMs: timeoutMs as number,
        };
      },
      execute: async (context, value) => executorForContext(executor, context).runCommand({
        ...(value as { command: string; args: string[]; cwd: string; timeoutMs: number }),
        signal: context.signal,
      }),
    },
  ];
  if (driver !== undefined) tools.push(...createDriverTools(driver));
  return tools;
}

function executorForContext(executor: ComputerExecutor, context: ToolExecutionContext): ComputerExecutor {
  const commandRoots: CommandRootMount[] = [
    ...context.grant.skillExecutionRoots.map((root) => ({
      id: root.cwd,
      path: root.path,
    })),
    ...context.grant.visibleDirectories.map((root) => ({
      id: `@visible/${root.id}`,
      path: root.path,
    })),
  ];
  if (context.grant.workspaceRoot !== undefined) {
    return executor.withWorkspaceRoot(context.grant.workspaceRoot, { commandRoots });
  }
  if (commandRoots.length > 0) return executor.withWorkspaceRoot(executor.workspaceRoot, { commandRoots });
  return executor;
}

function commandArguments(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_COMMAND_ARGUMENTS) {
    throw badRequest(`args must be an array with at most ${MAX_COMMAND_ARGUMENTS} entries`);
  }
  let totalCharacters = 0;
  const result = value.map((argument, index) => {
    if (typeof argument !== "string") throw badRequest(`args[${index}] must be a string`);
    if (argument.length > MAX_COMMAND_ARGUMENT_CHARACTERS) {
      throw badRequest(`args[${index}] must contain at most ${MAX_COMMAND_ARGUMENT_CHARACTERS} characters`);
    }
    if (argument.includes("\0")) throw badRequest(`args[${index}] must not contain NUL bytes`);
    totalCharacters += argument.length;
    return argument;
  });
  if (totalCharacters > MAX_COMMAND_ARGUMENTS_TOTAL_CHARACTERS) {
    throw badRequest(`args must contain at most ${MAX_COMMAND_ARGUMENTS_TOTAL_CHARACTERS} characters in total`);
  }
  return result;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw badRequest(`${field} must be a positive integer`);
  }
  return value as number;
}

function directoryPath(value: string): string {
  return value === "" || value === "/" ? "." : value;
}

function optionalBoundedInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw badRequest(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
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

interface JsonReadQuery {
  readonly pointer: string;
  readonly offset?: number;
  readonly limit?: number;
}

function parseJsonReadQueries(value: unknown): JsonReadQuery[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > JSON_READ_MAX_QUERIES) {
    throw badRequest(`queries must be an array with 1 to ${JSON_READ_MAX_QUERIES} entries`);
  }
  return value.map((item, index) => {
    const record = requireRecord(item, `queries[${index}]`);
    const pointer = requireString(record.pointer, `queries[${index}].pointer`, { max: JSON_READ_MAX_POINTER_LENGTH });
    if (pointer !== "" && !pointer.startsWith("/")) {
      throw badRequest(`queries[${index}].pointer must be an empty string or a JSON Pointer beginning with /`);
    }
    return {
      pointer,
      offset: optionalBoundedInteger(record.offset, `queries[${index}].offset`, 0, Number.MAX_SAFE_INTEGER),
      limit: optionalBoundedInteger(record.limit, `queries[${index}].limit`, 1, JSON_READ_MAX_ARRAY_LIMIT),
    };
  });
}

function readJsonPointer(document: unknown, query: JsonReadQuery, caveats: string[]): {
  readonly pointer: string;
  readonly found: boolean;
  readonly summary?: JsonValueSummary;
  readonly value?: unknown;
  readonly offset?: number;
  readonly limit?: number;
  readonly returned?: number;
  readonly totalItems?: number;
  readonly sourceRange?: string;
} {
  const selected = selectJsonPointer(document, query.pointer);
  if (!selected.found) return { pointer: query.pointer, found: false };
  const value = selected.value;
  if (Array.isArray(value)) {
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    const window = value.slice(offset, offset + limit);
    if (window.length < value.length) {
      caveats.push(`Query ${query.pointer || "/"} returned ${window.length} of ${value.length} array items; request another offset for more.`);
    }
    return {
      pointer: query.pointer,
      found: true,
      summary: summarizeJsonValue(value),
      value: window,
      offset,
      limit,
      returned: window.length,
      totalItems: value.length,
      sourceRange: `${query.pointer || "/"}[${offset}:${offset + window.length}]`,
    };
  }
  return {
    pointer: query.pointer,
    found: true,
    summary: summarizeJsonValue(value),
    value: boundJsonValue(value, caveats, query.pointer || "/"),
    sourceRange: query.pointer || "/",
  };
}

function selectJsonPointer(document: unknown, pointer: string): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  if (pointer === "") return { found: true, value: document };
  let cursor = document;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9]\d*)$/u.test(token)) return { found: false };
      const index = Number(token);
      if (index >= cursor.length) return { found: false };
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object" || cursor === null || !(token in cursor)) return { found: false };
    cursor = (cursor as Record<string, unknown>)[token];
  }
  return { found: true, value: cursor };
}

function summarizeTableExtractionArtifact(input: {
  readonly path: string;
  readonly requestedPath?: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly document: unknown;
  readonly maxTables: number;
  readonly sampleRecords: number;
}): {
  readonly schema: "agentloop.tableArtifactSummary/v1";
  readonly path: string;
  readonly requestedPath?: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly sourceSchema: string;
  readonly requested: number;
  readonly returned: number;
  readonly totalRows: number;
  readonly totalRecords: number;
  readonly totalCells: number;
  readonly truncated: boolean;
  readonly tableCount: number;
  readonly returnedTables: number;
  readonly tables: readonly TableArtifactSummaryTable[];
  readonly caveats: readonly string[];
  readonly evidenceReceipt: {
    readonly schema: "agentloop.toolEvidenceReceipt/v1";
    readonly sourceType: "table_artifact_summary";
    readonly receiptId: string;
    readonly sourceRefs: readonly unknown[];
    readonly facts: readonly unknown[];
    readonly caveats: readonly string[];
    readonly evidenceKinds: {
      readonly satisfied: readonly string[];
      readonly caveated: readonly string[];
      readonly failed: readonly string[];
    };
  };
} {
  const artifact = requireTableExtractionArtifact(input.document);
  const tables = tableExtractionTables(artifact);
  const returnedTables = tables.slice(0, input.maxTables);
  const caveats = [
    ...artifact.caveats,
    ...(tables.length > returnedTables.length ? [`Table artifact summary returned ${returnedTables.length} of ${tables.length} tables; increase maxTables or use computer_read_json for later table pointers.`] : []),
  ];
  const summaries = returnedTables.map((table) => summarizeTableArtifactTable(table, input.sampleRecords));
  const sourceRefs = summaries.map((table) => ({
    fileIndex: table.fileIndex,
    sheetIndex: table.sheetIndex,
    filePath: table.filePath,
    sheetName: table.sheetName,
    recordsPointer: table.recordsPointer,
    rowsPointer: table.rowsPointer,
    columnsPointer: table.columnsPointer,
    recordCount: table.recordCount,
    sourceRange: table.sourceRange,
  }));
  const facts = [{
    kind: "table_artifact_summary",
    artifactPath: input.path,
    artifactSha256: input.sha256,
    sourceSchema: artifact.schema,
    requested: artifact.requested,
    returned: artifact.returned,
    totalRows: artifact.totalRows,
    totalRecords: artifact.totalRecords,
    totalCells: artifact.totalCells,
    tableCount: tables.length,
    returnedTables: summaries.length,
    fullTableCoverage: summaries.length === tables.length,
  }];
  const receiptMaterial = JSON.stringify({ input, sourceRefs, facts, caveats });
  return {
    schema: "agentloop.tableArtifactSummary/v1",
    path: input.path,
    ...(input.requestedPath === undefined ? {} : { requestedPath: input.requestedPath }),
    bytes: input.bytes,
    sha256: input.sha256,
    sourceSchema: artifact.schema,
    requested: artifact.requested,
    returned: artifact.returned,
    totalRows: artifact.totalRows,
    totalRecords: artifact.totalRecords,
    totalCells: artifact.totalCells,
    truncated: artifact.truncated || tables.length > returnedTables.length,
    tableCount: tables.length,
    returnedTables: summaries.length,
    tables: summaries,
    caveats,
    evidenceReceipt: {
      schema: "agentloop.toolEvidenceReceipt/v1",
      sourceType: "table_artifact_summary",
      receiptId: createHash("sha256").update(receiptMaterial).digest("hex"),
      sourceRefs,
      facts,
      caveats,
      evidenceKinds: {
        satisfied: ["source_summary", "schema_summary", "record_counts", "table_coverage", "structured_extraction_artifact", ...(caveats.length === 0 ? ["explicit_caveats"] : [])],
        caveated: caveats.length === 0 ? [] : ["explicit_caveats"],
        failed: [],
      },
    },
  };
}

interface TableExtractionArtifact {
  readonly schema: "agentloop.visibleTableExtraction/v1";
  readonly files: readonly TableExtractionArtifactFile[];
  readonly requested: number;
  readonly returned: number;
  readonly totalRows: number;
  readonly totalRecords: number;
  readonly totalCells: number;
  readonly truncated: boolean;
  readonly caveats: readonly string[];
}

interface TableExtractionArtifactFile {
  readonly path: string;
  readonly sheets: readonly TableExtractionArtifactSheet[];
}

interface TableExtractionArtifactSheet {
  readonly name: string;
  readonly index: number;
  readonly sourceRange?: string;
  readonly columns: readonly TableExtractionArtifactColumn[];
  readonly records: readonly TableExtractionArtifactRecord[];
  readonly rowCount: number;
  readonly recordCount: number;
  readonly cellCount: number;
  readonly truncated: boolean;
}

interface TableExtractionArtifactColumn {
  readonly index: number;
  readonly address: string;
  readonly name: string;
  readonly sourceAddress?: string;
  readonly nonEmptyCellCount: number;
  readonly valueKinds: Record<string, number>;
}

interface TableExtractionArtifactRecord {
  readonly row: number;
  readonly sourceRange: string;
  readonly values: Record<string, unknown>;
  readonly cellCount: number;
}

interface TableArtifactSummaryTable {
  readonly fileIndex: number;
  readonly sheetIndex: number;
  readonly filePath: string;
  readonly sheetName: string;
  readonly sourceRange?: string;
  readonly recordsPointer: string;
  readonly rowsPointer: string;
  readonly columnsPointer: string;
  readonly rowCount: number;
  readonly recordCount: number;
  readonly cellCount: number;
  readonly truncated: boolean;
  readonly fields: readonly {
    readonly name: string;
    readonly address: string;
    readonly nonEmptyCellCount: number;
    readonly valueKinds: Record<string, number>;
  }[];
  readonly numericFields: readonly {
    readonly name: string;
    readonly count: number;
    readonly min: number;
    readonly max: number;
    readonly sum: number;
    readonly mean: number;
  }[];
  readonly textSamples: Record<string, readonly string[]>;
  readonly sampleRecords: readonly TableExtractionArtifactRecord[];
}

function requireTableExtractionArtifact(value: unknown): TableExtractionArtifact {
  const record = requireRecord(value, "table artifact");
  if (record.schema !== "agentloop.visibleTableExtraction/v1") {
    throw badRequest("path must identify an agentloop.visibleTableExtraction/v1 artifact");
  }
  if (!Array.isArray(record.files)) throw badRequest("table artifact files must be an array");
  return {
    schema: "agentloop.visibleTableExtraction/v1",
    files: record.files.map((file, fileIndex) => {
      const fileRecord = requireRecord(file, `files[${fileIndex}]`);
      if (!Array.isArray(fileRecord.sheets)) throw badRequest(`files[${fileIndex}].sheets must be an array`);
      return {
        path: requireString(fileRecord.path, `files[${fileIndex}].path`, { max: 4_000 }),
        sheets: fileRecord.sheets.map((sheet, sheetIndex) => {
          const sheetRecord = requireRecord(sheet, `files[${fileIndex}].sheets[${sheetIndex}]`);
          if (!Array.isArray(sheetRecord.columns)) throw badRequest(`files[${fileIndex}].sheets[${sheetIndex}].columns must be an array`);
          if (!Array.isArray(sheetRecord.records)) throw badRequest(`files[${fileIndex}].sheets[${sheetIndex}].records must be an array`);
          return {
            name: requireString(sheetRecord.name, `files[${fileIndex}].sheets[${sheetIndex}].name`, { max: 512 }),
            index: Number.isSafeInteger(sheetRecord.index) ? sheetRecord.index as number : sheetIndex,
            ...(typeof sheetRecord.sourceRange === "string" ? { sourceRange: sheetRecord.sourceRange } : {}),
            columns: sheetRecord.columns.map((column, columnIndex) => {
              const columnRecord = requireRecord(column, `files[${fileIndex}].sheets[${sheetIndex}].columns[${columnIndex}]`);
              return {
                index: Number.isSafeInteger(columnRecord.index) ? columnRecord.index as number : columnIndex + 1,
                address: typeof columnRecord.address === "string" ? columnRecord.address : "",
                name: requireString(columnRecord.name, `files[${fileIndex}].sheets[${sheetIndex}].columns[${columnIndex}].name`, { max: 512 }),
                ...(typeof columnRecord.sourceAddress === "string" ? { sourceAddress: columnRecord.sourceAddress } : {}),
                nonEmptyCellCount: Number.isSafeInteger(columnRecord.nonEmptyCellCount) ? columnRecord.nonEmptyCellCount as number : 0,
                valueKinds: isRecord(columnRecord.valueKinds) ? numericRecord(columnRecord.valueKinds) : {},
              };
            }),
            records: sheetRecord.records.map((row, rowIndex) => {
              const rowRecord = requireRecord(row, `files[${fileIndex}].sheets[${sheetIndex}].records[${rowIndex}]`);
              return {
                row: Number.isSafeInteger(rowRecord.row) ? rowRecord.row as number : rowIndex + 1,
                sourceRange: typeof rowRecord.sourceRange === "string" ? rowRecord.sourceRange : "",
                values: isRecord(rowRecord.values) ? rowRecord.values : {},
                cellCount: Number.isSafeInteger(rowRecord.cellCount) ? rowRecord.cellCount as number : Object.keys(isRecord(rowRecord.values) ? rowRecord.values : {}).length,
              };
            }),
            rowCount: Number.isSafeInteger(sheetRecord.rowCount) ? sheetRecord.rowCount as number : 0,
            recordCount: Number.isSafeInteger(sheetRecord.recordCount) ? sheetRecord.recordCount as number : sheetRecord.records.length,
            cellCount: Number.isSafeInteger(sheetRecord.cellCount) ? sheetRecord.cellCount as number : 0,
            truncated: sheetRecord.truncated === true,
          };
        }),
      };
    }),
    requested: Number.isSafeInteger(record.requested) ? record.requested as number : 0,
    returned: Number.isSafeInteger(record.returned) ? record.returned as number : record.files.length,
    totalRows: Number.isSafeInteger(record.totalRows) ? record.totalRows as number : 0,
    totalRecords: Number.isSafeInteger(record.totalRecords) ? record.totalRecords as number : 0,
    totalCells: Number.isSafeInteger(record.totalCells) ? record.totalCells as number : 0,
    truncated: record.truncated === true,
    caveats: Array.isArray(record.caveats) ? record.caveats.filter((item): item is string => typeof item === "string") : [],
  };
}

function tableExtractionTables(artifact: TableExtractionArtifact): Array<{
  readonly file: TableExtractionArtifactFile;
  readonly fileIndex: number;
  readonly sheet: TableExtractionArtifactSheet;
  readonly sheetIndex: number;
}> {
  return artifact.files.flatMap((file, fileIndex) =>
    file.sheets.map((sheet, sheetIndex) => ({ file, fileIndex, sheet, sheetIndex }))
  );
}

function summarizeTableArtifactTable(
  table: ReturnType<typeof tableExtractionTables>[number],
  sampleRecords: number,
): TableArtifactSummaryTable {
  const { file, fileIndex, sheet, sheetIndex } = table;
  const numeric = new Map<string, { count: number; min: number; max: number; sum: number }>();
  const textSamples = new Map<string, string[]>();
  for (const record of sheet.records) {
    for (const [field, value] of Object.entries(record.values)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        const current = numeric.get(field) ?? { count: 0, min: value, max: value, sum: 0 };
        current.count += 1;
        current.min = Math.min(current.min, value);
        current.max = Math.max(current.max, value);
        current.sum += value;
        numeric.set(field, current);
      } else if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length === 0) continue;
        const samples = textSamples.get(field) ?? [];
        if (samples.length < TABLE_ARTIFACT_SUMMARY_MAX_TEXT_SAMPLES && !samples.includes(trimmed)) {
          samples.push(trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed);
        }
        textSamples.set(field, samples);
      }
    }
  }
  return {
    fileIndex,
    sheetIndex,
    filePath: file.path,
    sheetName: sheet.name,
    ...(sheet.sourceRange === undefined ? {} : { sourceRange: sheet.sourceRange }),
    recordsPointer: `/files/${fileIndex}/sheets/${sheetIndex}/records`,
    rowsPointer: `/files/${fileIndex}/sheets/${sheetIndex}/rows`,
    columnsPointer: `/files/${fileIndex}/sheets/${sheetIndex}/columns`,
    rowCount: sheet.rowCount,
    recordCount: sheet.recordCount,
    cellCount: sheet.cellCount,
    truncated: sheet.truncated,
    fields: sheet.columns.map((column) => ({
      name: column.name,
      address: column.address,
      nonEmptyCellCount: column.nonEmptyCellCount,
      valueKinds: column.valueKinds,
    })),
    numericFields: [...numeric.entries()]
      .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
      .map(([name, stats]) => ({
        name,
        count: stats.count,
        min: stats.min,
        max: stats.max,
        sum: Number(stats.sum.toFixed(6)),
        mean: Number((stats.sum / stats.count).toFixed(6)),
      })),
    textSamples: Object.fromEntries([...textSamples.entries()].sort(([left], [right]) => left.localeCompare(right))),
    sampleRecords: sheet.records.slice(0, sampleRecords),
  };
}

type TableArtifactAggregationOperation = "count" | "sum" | "average" | "min" | "max";

interface TableArtifactAggregationQuery {
  readonly operation: TableArtifactAggregationOperation;
  readonly field?: string;
  readonly groupBy?: string;
  readonly order?: "asc" | "desc";
  readonly maxGroups?: number;
  readonly where: readonly { readonly field: string; readonly equals: string | number | boolean }[];
}

function parseTableArtifactAggregationQueries(value: unknown): TableArtifactAggregationQuery[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > TABLE_ARTIFACT_AGGREGATION_MAX_QUERIES) {
    throw badRequest(`queries must contain 1 to ${TABLE_ARTIFACT_AGGREGATION_MAX_QUERIES} aggregation requests`);
  }
  return value.map((item, index) => {
    const record = requireRecord(item, `queries[${index}]`);
    const operation = requireString(record.operation, `queries[${index}].operation`, { max: 32 });
    if (!isTableArtifactAggregationOperation(operation)) {
      throw badRequest(`queries[${index}].operation must be count, sum, average, min, or max`);
    }
    const field = record.field === undefined ? undefined : requireString(record.field, `queries[${index}].field`, { max: 512 });
    const groupBy = record.groupBy === undefined ? undefined : requireString(record.groupBy, `queries[${index}].groupBy`, { max: 512 });
    if (operation !== "count" && field === undefined) {
      throw badRequest(`queries[${index}].field is required for ${operation}`);
    }
    if (operation !== "count" && groupBy !== undefined) {
      throw badRequest(`queries[${index}].groupBy is supported only for count`);
    }
    const order = record.order === undefined ? undefined : requireString(record.order, `queries[${index}].order`, { max: 8 });
    if (order !== undefined && order !== "asc" && order !== "desc") {
      throw badRequest(`queries[${index}].order must be asc or desc`);
    }
    const maxGroups = optionalBoundedInteger(record.maxGroups, `queries[${index}].maxGroups`, 1, TABLE_ARTIFACT_AGGREGATION_MAX_GROUPS);
    if (maxGroups !== undefined && groupBy === undefined) {
      throw badRequest(`queries[${index}].maxGroups requires groupBy`);
    }
    const where = parseTableArtifactAggregationWhere(record.where, index);
    return {
      operation,
      ...(field === undefined ? {} : { field }),
      ...(groupBy === undefined ? {} : { groupBy }),
      ...(order === undefined ? {} : { order }),
      ...(maxGroups === undefined ? {} : { maxGroups }),
      where,
    };
  });
}

function isTableArtifactAggregationOperation(value: string): value is TableArtifactAggregationOperation {
  return value === "count" || value === "sum" || value === "average" || value === "min" || value === "max";
}

function parseTableArtifactAggregationWhere(
  value: unknown,
  queryIndex: number,
): Array<{ field: string; equals: string | number | boolean }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw badRequest(`queries[${queryIndex}].where must contain at most 20 equality filters`);
  }
  return value.map((item, index) => {
    const record = requireRecord(item, `queries[${queryIndex}].where[${index}]`);
    const equals = record.equals;
    if (typeof equals !== "string" && typeof equals !== "number" && typeof equals !== "boolean") {
      throw badRequest(`queries[${queryIndex}].where[${index}].equals must be a string, number, or boolean`);
    }
    return {
      field: requireString(record.field, `queries[${queryIndex}].where[${index}].field`, { max: 512 }),
      equals,
    };
  });
}

function aggregateTableExtractionArtifact(input: {
  readonly path: string;
  readonly requestedPath?: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly document: unknown;
  readonly queries: readonly TableArtifactAggregationQuery[];
}) {
  const artifact = requireTableExtractionArtifact(input.document);
  const tables = tableExtractionTables(artifact);
  const tableRecords = tables.flatMap(({ file, fileIndex, sheet, sheetIndex }) => sheet.records.map((record) => ({
    values: record.values,
    fileIndex,
    sheetIndex,
    filePath: file.path,
    sheetName: sheet.name,
    sourceRange: record.sourceRange,
  })));
  const caveats = [...artifact.caveats];
  if (artifact.truncated || tables.some((table) => table.sheet.truncated)) {
    caveats.push("The structured extraction is truncated, so aggregations cover only the extracted records.");
  }
  const computedResults = input.queries.map((query, index) => aggregateTableArtifactQuery({
    query,
    queryIndex: index,
    records: tableRecords,
    sourceTruncated: artifact.truncated || tables.some((table) => table.sheet.truncated),
  }));
  const results = computedResults.map(({ materializedGroups: _materializedGroups, materializedComplete: _materializedComplete, ...result }) => result);
  const materializedResults = computedResults.map(({ materializedGroups, materializedComplete, ...result }) => ({
    ...result,
    ...(materializedGroups === undefined ? {} : {
      groups: materializedGroups,
      returnedGroupCount: materializedGroups.length,
      nextGroupOffset: undefined,
    }),
    complete: materializedComplete,
  }));
  for (const result of results) caveats.push(...result.caveats);
  const complete = materializedResults.every((result) => result.complete);
  const deduplicatedCaveats = [...new Set(caveats)];
  const sourceRefs = tables.map(({ file, fileIndex, sheet, sheetIndex }) => ({
    fileIndex,
    sheetIndex,
    filePath: file.path,
    sheetName: sheet.name,
    recordsPointer: `/files/${fileIndex}/sheets/${sheetIndex}/records`,
    sourceRange: sheet.sourceRange,
    recordCount: sheet.recordCount,
    extractedRecordCount: sheet.records.length,
    truncated: sheet.truncated,
  }));
  const facts = [{
    kind: "table_artifact_aggregation",
    artifactPath: input.path,
    artifactSha256: input.sha256,
    queryCount: results.length,
    complete,
    totalTables: tables.length,
    totalRecords: tableRecords.length,
    artifactTruncated: artifact.truncated || tables.some((table) => table.sheet.truncated),
  }];
  return {
    schema: "agentloop.tableArtifactAggregation/v1" as const,
    path: input.path,
    ...(input.requestedPath === undefined ? {} : { requestedPath: input.requestedPath }),
    bytes: input.bytes,
    sha256: input.sha256,
    sourceSchema: artifact.schema,
    coverage: {
      complete,
      totalTables: tables.length,
      totalRecords: tableRecords.length,
      truncated: artifact.truncated || tables.some((table) => table.sheet.truncated),
    },
    results,
    materializedResults,
    caveats: deduplicatedCaveats,
    evidenceReceipt: {
      schema: "agentloop.toolEvidenceReceipt/v1" as const,
      sourceType: "table_artifact_aggregation",
      receiptId: createHash("sha256").update(JSON.stringify({ path: input.path, sha256: input.sha256, queries: input.queries, results: materializedResults })).digest("hex"),
      sourceRefs,
      facts,
      caveats: deduplicatedCaveats,
      evidenceKinds: {
        satisfied: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", ...(complete ? ["derived_aggregation", "table_coverage"] : [])],
        caveated: deduplicatedCaveats.length === 0 ? [] : ["explicit_caveats"],
        failed: complete ? [] : ["derived_aggregation"],
      },
    },
  };
}

function aggregateTableArtifactQuery(input: {
  readonly query: TableArtifactAggregationQuery;
  readonly queryIndex: number;
  readonly records: readonly { readonly values: Record<string, unknown> }[];
  readonly sourceTruncated: boolean;
}) {
  const caveats: string[] = [];
  const relevantFields = [input.query.field, input.query.groupBy, ...input.query.where.map((filter) => filter.field)]
    .filter((field): field is string => field !== undefined);
  const missingFields = relevantFields.filter((field) => !input.records.some((record) => Object.hasOwn(record.values, field)));
  if (missingFields.length > 0) caveats.push(`Requested aggregation field(s) were absent from extracted records: ${[...new Set(missingFields)].join(", ")}.`);
  const filtered = input.records.filter((record) => input.query.where.every((filter) => record.values[filter.field] === filter.equals));
  const base = {
    queryIndex: input.queryIndex,
    operation: input.query.operation,
    ...(input.query.field === undefined ? {} : { field: input.query.field }),
    ...(input.query.groupBy === undefined ? {} : { groupBy: input.query.groupBy }),
    where: input.query.where,
    inputRecordCount: input.records.length,
    matchedRecordCount: filtered.length,
  };
  if (input.query.operation === "count" && input.query.groupBy !== undefined) {
    const groups = new Map<string, { value: unknown; count: number }>();
    let missingGroupValues = 0;
    for (const record of filtered) {
      const value = record.values[input.query.groupBy];
      if (value === undefined || value === null || value === "") {
        missingGroupValues += 1;
        continue;
      }
      const key = `${typeof value}:${JSON.stringify(value)}`;
      const current = groups.get(key) ?? { value, count: 0 };
      current.count += 1;
      groups.set(key, current);
    }
    const order = input.query.order ?? "desc";
    const allGroups = [...groups.values()].sort((left, right) => order === "desc"
      ? right.count - left.count || String(left.value).localeCompare(String(right.value))
      : left.count - right.count || String(left.value).localeCompare(String(right.value)));
    const maxGroups = input.query.maxGroups ?? TABLE_ARTIFACT_AGGREGATION_MAX_GROUPS;
    if (allGroups.length > maxGroups) caveats.push(`Only ${maxGroups} of ${allGroups.length} groups were returned; increase maxGroups for a complete ranking.`);
    const materializedComplete = !input.sourceTruncated && missingFields.length === 0;
    return {
      ...base,
      groupCount: allGroups.length,
      missingGroupValues,
      groups: allGroups.slice(0, maxGroups),
      returnedGroupCount: Math.min(allGroups.length, maxGroups),
      ...(allGroups.length > maxGroups ? { nextGroupOffset: maxGroups } : {}),
      complete: materializedComplete && allGroups.length <= maxGroups,
      materializedGroups: allGroups,
      materializedComplete,
      caveats,
    };
  }
  if (input.query.operation === "count") {
    const materializedComplete = !input.sourceTruncated && missingFields.length === 0;
    return {
      ...base,
      value: filtered.length,
      complete: materializedComplete,
      materializedGroups: undefined,
      materializedComplete,
      caveats,
    };
  }
  const numeric = filtered
    .map((record) => record.values[input.query.field as string])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (numeric.length === 0) caveats.push(`No finite numeric values were available for ${input.query.field}.`);
  const value = numeric.length === 0 ? undefined
    : input.query.operation === "sum" ? numeric.reduce((total, item) => total + item, 0)
    : input.query.operation === "average" ? numeric.reduce((total, item) => total + item, 0) / numeric.length
    : input.query.operation === "min" ? Math.min(...numeric)
    : Math.max(...numeric);
  const materializedComplete = !input.sourceTruncated && missingFields.length === 0 && numeric.length > 0;
  return {
    ...base,
    numericValueCount: numeric.length,
    ...(value === undefined ? {} : { value: Number(value.toFixed(6)) }),
    complete: materializedComplete,
    materializedGroups: undefined,
    materializedComplete,
    caveats,
  };
}

function tableAggregationResultRef(input: {
  readonly path: string;
  readonly sha256: string;
  readonly coverage: { readonly complete: boolean; readonly totalTables: number; readonly totalRecords: number; readonly truncated: boolean };
  readonly results: readonly Record<string, unknown>[];
}) {
  return {
    schema: "agentloop.tableAggregationResultRef/v1" as const,
    path: input.path,
    sha256: input.sha256,
    coverage: input.coverage,
    results: input.results.map((result, index) => ({
      queryIndex: typeof result.queryIndex === "number" ? result.queryIndex : index,
      operation: result.operation,
      ...(typeof result.field === "string" ? { field: result.field } : {}),
      ...(typeof result.groupBy === "string" ? { groupBy: result.groupBy } : {}),
      ...(Array.isArray(result.where) ? { where: result.where } : {}),
      inputRecordCount: result.inputRecordCount,
      matchedRecordCount: result.matchedRecordCount,
      ...(typeof result.groupCount === "number" ? {
        groupCount: result.groupCount,
        returnedGroupCount: result.returnedGroupCount,
        groupsPointer: `/results/${index}/groups`,
      } : {}),
      resultPointer: `/results/${index}`,
      complete: result.complete,
    })),
    instruction: "Use computer_read_json with this path and a resultPointer or groupsPointer. For an array pointer, supply offset and limit to read only the needed window.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numericRecord(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

interface JsonValueSummary {
  readonly type: string;
  readonly keys?: readonly string[];
  readonly omittedKeys?: number;
  readonly length?: number;
  readonly itemSummary?: JsonValueSummary;
  readonly properties?: Record<string, JsonValueSummary>;
}

function summarizeJsonValue(value: unknown, depth = 0): JsonValueSummary {
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      ...(value.length === 0 || depth >= 2 ? {} : { itemSummary: summarizeJsonValue(value[0], depth + 1) }),
    };
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    const keys = entries.map(([key]) => key);
    const shown = entries.slice(0, 30);
    return {
      type: "object",
      keys: keys.slice(0, 60),
      ...(keys.length > 60 ? { omittedKeys: keys.length - 60 } : {}),
      ...(depth >= 2 ? {} : { properties: Object.fromEntries(shown.map(([key, child]) => [key, summarizeJsonValue(child, depth + 1)])) }),
    };
  }
  return { type: value === null ? "null" : typeof value };
}

function boundJsonValue(value: unknown, caveats: string[], pointer: string, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length <= 4_000) return value;
    caveats.push(`String at ${pointer} was truncated to 4000 characters.`);
    return `${value.slice(0, 4_000)}...`;
  }
  if (Array.isArray(value)) {
    const maxItems = 50;
    if (value.length > maxItems) caveats.push(`Array at ${pointer} was truncated to ${maxItems} of ${value.length} items.`);
    return value.slice(0, maxItems).map((item, index) => boundJsonValue(item, caveats, `${pointer}/${index}`, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    if (depth >= 4) {
      caveats.push(`Object at ${pointer} was summarized after depth 4.`);
      return summarizeJsonValue(value, depth);
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const maxKeys = 80;
    if (entries.length > maxKeys) caveats.push(`Object at ${pointer} was truncated to ${maxKeys} of ${entries.length} keys.`);
    return Object.fromEntries(entries.slice(0, maxKeys).map(([key, child]) => [key, boundJsonValue(child, caveats, `${pointer}/${key}`, depth + 1)]));
  }
  return value;
}

const ARTIFACT_ACCEPTANCE_KINDS = [
  "auto",
  "generic_file",
  "html",
  "html_ppt",
  "docx",
  "xlsx",
  "pptx",
  "pdf",
  "markdown",
  "image",
  "json",
] as const satisfies readonly ArtifactAcceptanceKind[];
const MAX_ACCEPTANCE_CHECKS = 50;
const MAX_ACCEPTANCE_CHECK_CHARACTERS = 512;

function artifactKindSchema(): Record<string, unknown> {
  return { type: "string", enum: ARTIFACT_ACCEPTANCE_KINDS };
}

function optionalArtifactKind(value: unknown, field: string): ArtifactAcceptanceKind | undefined {
  if (value === undefined) return undefined;
  const kind = requireString(value, field, { max: 64 });
  if ((ARTIFACT_ACCEPTANCE_KINDS as readonly string[]).includes(kind)) return kind as ArtifactAcceptanceKind;
  throw badRequest(`${field} must be one of ${ARTIFACT_ACCEPTANCE_KINDS.join(", ")}`);
}

function parseOptionalStringArray(value: unknown, field: string, maximum: number, itemMaximum = 128): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximum) {
    throw badRequest(`${field} must be an array with at most ${maximum} entries`);
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`, { max: itemMaximum }));
}

function requireBoundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw badRequest(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function createDriverTools(driver: ComputerDriver): RuntimeTool<unknown>[] {
  return [
    {
      name: "computer_snapshot", description: "Capture the current computer screen", inputSchema: objectSchema([], {}),
      executionMode: "exclusive", replaySafe: true, parse: (value) => requireRecord(value),
      execute: async (context) => driver.snapshot(context.signal),
    },
    {
      name: "computer_click", description: "Click screen coordinates", inputSchema: objectSchema(["x", "y"], { x: { type: "number" }, y: { type: "number" } }),
      executionMode: "exclusive", replaySafe: false,
      parse: (value) => {
        const record = requireRecord(value);
        if (typeof record.x !== "number" || typeof record.y !== "number") throw badRequest("x and y must be numbers");
        return { x: record.x, y: record.y };
      },
      execute: async (context, value) => driver.click(value as { x: number; y: number }, context.signal),
    },
    driverTextTool("computer_type_text", "Type text into the focused computer control", "text", (value, signal) => driver.typeText(value, signal)),
    driverTextTool("computer_press_key", "Press one key in the focused computer control", "key", (value, signal) => driver.pressKey(value, signal)),
    driverTextTool("computer_navigate", "Navigate the controlled browser to an HTTP(S) URL", "url", async (value, signal) => {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw badRequest("url must use http or https");
      await driver.navigate(url.toString(), signal);
    }),
  ];
}

function driverTextTool(
  name: string,
  description: string,
  field: string,
  execute: (value: string, signal?: AbortSignal) => Promise<void>,
): RuntimeTool<unknown> {
  return {
    name, description, inputSchema: objectSchema([field], { [field]: { type: "string" } }),
    executionMode: "exclusive", replaySafe: false,
    parse: (value) => ({ [field]: fieldString(value, field, 20_000) }),
    execute: async (context, value) => execute((value as Record<string, string>)[field], context.signal),
  };
}

function fieldString(value: unknown, field: string, max: number): string {
  return requireString(requireRecord(value)[field], field, { max });
}

function rootPathString(value: unknown, field: string, max: number): string {
  const item = requireRecord(value)[field];
  if (typeof item !== "string" || item.length > max) {
    throw badRequest(`${field} must be a string of at most ${max} characters`);
  }
  return directoryPath(item);
}

function parseWriteFileMode(mode: unknown, overwrite: unknown): WriteFileMode {
  if (mode !== undefined && overwrite !== undefined) {
    throw badRequest("mode and overwrite cannot both be set; use exactly one, preferably mode, and remove overwrite");
  }
  if (mode === undefined) return overwrite === true ? "overwrite" : "create";
  if (mode === "create" || mode === "overwrite" || mode === "append") return mode;
  throw badRequest("mode must be one of create, overwrite, or append");
}

function requirePatchText(value: unknown, label: string, options: { min: number; max: number }): string {
  if (typeof value !== "string") throw badRequest(`${label} must be a string`);
  if (value.length < options.min) throw badRequest(`${label} must contain at least ${options.min} characters`);
  if (value.length > options.max) throw badRequest(`${label} must contain at most ${options.max} characters`);
  return value;
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
