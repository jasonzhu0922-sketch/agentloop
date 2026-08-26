import { badRequest } from "../shared/errors.ts";
import { requireRecord, requireString } from "../shared/validation.ts";
import { buildArtifactReceipt } from "../runtime/artifact-receipt.ts";
import type { RuntimeTool, ToolExecutionContext } from "./tool-registry.ts";
import { ArtifactAcceptanceService, type ArtifactAcceptanceKind } from "../acceptance/artifact-acceptance.ts";
import type { ComputerDriver } from "../computer/computer-driver.ts";
import { ComputerExecutor, type CommandRootMount } from "../computer/computer-executor.ts";
import { parsePaginatedHtmlMaterializeInput, renderPaginatedHtml } from "./paginated-html-materializer.ts";

const MAX_COMMAND_ARGUMENTS = 200;
const MAX_COMMAND_ARGUMENT_CHARACTERS = 4_096;
const MAX_COMMAND_ARGUMENTS_TOTAL_CHARACTERS = 65_536;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MIN_COMMAND_TIMEOUT_MS = 100;
const MAX_COMMAND_TIMEOUT_MS = 300_000;

export const DANGEROUS_COMPUTER_TOOL_NAMES = new Set([
  "materialize_paginated_html",
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
      description: "List entries under the configured workspace root. path must be relative to the workspace root; absolute paths are rejected.",
      inputSchema: objectSchema(["path"], { path: { type: "string" } }),
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => ({ path: rootPathString(value, "path", 4_000) }),
      execute: async (context, value) => executorForContext(executor, context).listDirectory((value as { path: string }).path),
    },
    {
      name: "computer_read_file",
      description: [
        "Read a UTF-8 file under the configured workspace root.",
        "path must be relative to the workspace root; absolute paths are rejected.",
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
        "Find files under the configured workspace root using a glob pattern; respects workspace containment and skips .git and node_modules.",
        "Use this for low-noise discovery before reading files or running commands.",
        "path is optional and relative to the workspace root; pattern supports *, **, and ?; limit defaults to 1000.",
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
        "This read-only tool performs deterministic local structure/package checks; browser, PDF, Office, or image render checks are reported as skipped_unavailable unless a renderer is later wired into this same acceptance boundary.",
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
        "Search literal text recursively under the configured workspace root.",
        "path must be relative to the workspace root; absolute paths are rejected.",
        "Use this low-noise search tool instead of running shell grep/cat loops for file discovery.",
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
      name: "computer_write_file",
      description: [
        "Create or overwrite a UTF-8 file under the workspace root; requires dangerous-tool consent.",
        "path must be relative to the workspace root; absolute paths are rejected.",
        "For explicitly paginated HTML, HTML-PPT, or browser slide decks that fit a compact page spec, use materialize_paginated_html instead of streaming the full generated document here.",
        "For ordinary standalone HTML, custom visual pages, dashboards, apps, or interactions, this Tool may write the authored HTML/CSS/JS file directly.",
        "For other very large content, prefer reusable scripts or several smaller write_file calls over one oversized call so the arguments do not exceed the output budget.",
        "The result includes sha256, line count, Markdown-style outline, and bounded first/last sample ranges as write-after-inspection evidence; cite that receipt before rereading the whole file.",
      ].join(" "),
      inputSchema: objectSchema(["path", "content"], {
        path: { type: "string" }, content: { type: "string" }, overwrite: { type: "boolean" },
      }),
      executionMode: "exclusive",
      replaySafe: false,
      parse: (value) => {
        const record = requireRecord(value, "computer_write_file arguments");
        if (record.overwrite !== undefined && typeof record.overwrite !== "boolean") {
          throw badRequest("overwrite must be boolean");
        }
        if (typeof record.content !== "string" || record.content.length > 1_000_000) {
          throw badRequest("content must be a string of at most 1000000 characters");
        }
        return {
          path: requireString(record.path, "path", { max: 4_000 }),
          content: record.content,
          overwrite: record.overwrite === true,
        };
      },
      execute: async (_context, value) => {
        const input = value as { path: string; content: string; overwrite: boolean };
        const receipt = await executorForContext(executor, _context).writeFile(input.path, input.content, input.overwrite);
        return {
          ...receipt,
          artifactReceipt: buildArtifactReceipt("computer_write_file", receipt),
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
        "Command arguments must not reference filesystem paths outside the workspace root, the current command root, or another authorized command root.",
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
