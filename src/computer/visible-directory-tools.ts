import { promises as fs } from "node:fs";
import { badRequest, forbidden } from "../shared/errors.ts";
import { requireRecord, requireString } from "../shared/validation.ts";
import type { VisibleDirectoryGrant } from "../runtime/contracts.ts";
import type { RuntimeTool, ToolExecutionContext } from "../runtime/tool-registry.ts";
import { ComputerExecutor } from "./computer-executor.ts";

export const VISIBLE_DIRECTORY_TOOL_NAMES = new Set([
  "visible_list_directory",
  "visible_find_files",
  "visible_search_text",
  "visible_read_file",
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
          path: record.path === undefined ? "." : requireString(record.path, "path", { max: 4_000 }),
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
          path: record.path === undefined ? "." : requireString(record.path, "path", { max: 4_000 }),
          pattern: requireString(record.pattern, "pattern", { max: 1_000 }),
          limit: optionalPositiveInteger(record.limit, "limit"),
        };
      },
      execute: async (context, value) => {
        const input = value as { rootId: string; path: string; pattern: string; limit?: number };
        const executor = await executorForVisibleRoot(context, input.rootId);
        return {
          rootId: input.rootId,
          ...(await executor.findFiles(input.path, input.pattern, { limit: input.limit })),
        };
      },
    },
    {
      name: "visible_search_text",
      description: [
        "Search literal text recursively under a user-authorized local visible directory.",
        "Use this when the user references local material by content rather than filename.",
        "Use rootId from visibleDirectories in runtime context. path is relative to that root.",
      ].join(" "),
      inputSchema: objectSchema(["rootId", "query"], {
        rootId: { type: "string" },
        query: { type: "string" },
        path: { type: "string" },
        maxMatches: { type: "integer", minimum: 1, maximum: 200 },
        contextBefore: { type: "integer", minimum: 0, maximum: 20 },
        contextAfter: { type: "integer", minimum: 0, maximum: 20 },
      }),
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => {
        const record = requireRecord(value, "visible_search_text arguments");
        return {
          rootId: requireString(record.rootId, "rootId", { max: 80 }),
          path: record.path === undefined ? "." : requireString(record.path, "path", { max: 4_000 }),
          query: requireString(record.query, "query", { max: 2_000 }),
          maxMatches: optionalBoundedInteger(record.maxMatches, "maxMatches", 1, 200),
          contextBefore: optionalBoundedInteger(record.contextBefore, "contextBefore", 0, 20),
          contextAfter: optionalBoundedInteger(record.contextAfter, "contextAfter", 0, 20),
        };
      },
      execute: async (context, value) => {
        const input = value as { rootId: string; path: string; query: string; maxMatches?: number; contextBefore?: number; contextAfter?: number };
        const executor = await executorForVisibleRoot(context, input.rootId);
        return {
          rootId: input.rootId,
          matches: await executor.searchText(input.path, input.query, {
            maxMatches: input.maxMatches,
            contextBefore: input.contextBefore,
            contextAfter: input.contextAfter,
          }),
        };
      },
    },
    {
      name: "visible_read_file",
      description: [
        "Read a UTF-8 file under a user-authorized local visible directory.",
        "Use rootId from visibleDirectories in runtime context and a path returned by visible_find_files or visible_search_text.",
        "If a bare filename is missing at the visible root, the tool searches authorized subdirectories by basename; unique ranked matches are read and ambiguous matches return candidate paths.",
        "Use optional 1-indexed offset and limit for one line window, or ranges for multiple line windows; do not combine ranges with offset or limit.",
      ].join(" "),
      inputSchema: readFileInputSchema(["rootId", "path"], {
        rootId: { type: "string" },
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
      maxResultCharacters: 250_000,
      parse: (value) => {
        const record = requireRecord(value, "visible_read_file arguments");
        if (record.ranges !== undefined && (record.offset !== undefined || record.limit !== undefined)) {
          throw badRequest("ranges cannot be combined with offset or limit");
        }
        return {
          rootId: requireString(record.rootId, "rootId", { max: 80 }),
          path: requireString(record.path, "path", { max: 4_000 }),
          offset: optionalPositiveInteger(record.offset, "offset"),
          limit: optionalPositiveInteger(record.limit, "limit"),
          ranges: parseReadRanges(record.ranges),
        };
      },
      execute: async (context, value) => {
        const input = value as { rootId: string; path: string; offset?: number; limit?: number; ranges?: Array<{ offset: number; limit?: number }> };
        const executor = await executorForVisibleRoot(context, input.rootId);
        return {
          rootId: input.rootId,
          path: input.path,
          ...(await executor.readFile(input.path, undefined, {
            offset: input.offset,
            limit: input.limit,
            ranges: input.ranges,
          })),
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
