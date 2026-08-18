import { badRequest } from "../shared/errors.ts";
import { requireRecord, requireString } from "../shared/validation.ts";
import type { RuntimeTool } from "../runtime/tool-registry.ts";
import type { ComputerDriver } from "./computer-driver.ts";
import { ComputerExecutor } from "./computer-executor.ts";

const MAX_COMMAND_ARGUMENTS = 200;
const MAX_COMMAND_ARGUMENT_CHARACTERS = 4_096;
const MAX_COMMAND_ARGUMENTS_TOTAL_CHARACTERS = 65_536;

export const DANGEROUS_COMPUTER_TOOL_NAMES = new Set([
  "computer_write_file",
  "computer_run_command",
  "computer_click",
  "computer_type_text",
  "computer_press_key",
  "computer_navigate",
]);

export function createComputerTools(executor: ComputerExecutor, driver?: ComputerDriver): RuntimeTool<unknown>[] {
  const tools: RuntimeTool<unknown>[] = [
    {
      name: "computer_list_directory",
      description: "List entries under the configured workspace root",
      inputSchema: objectSchema(["path"], { path: { type: "string" } }),
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => ({ path: fieldString(value, "path", 4_000) }),
      execute: async (_context, value) => executor.listDirectory((value as { path: string }).path),
    },
    {
      name: "computer_read_file",
      description: "Read a UTF-8 file under the configured workspace root",
      inputSchema: objectSchema(["path"], { path: { type: "string" } }),
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => ({ path: fieldString(value, "path", 4_000) }),
      execute: async (_context, value) => executor.readFile((value as { path: string }).path),
    },
    {
      name: "computer_search_text",
      description: "Search literal text recursively under the configured workspace root",
      inputSchema: objectSchema(["path", "query"], { path: { type: "string" }, query: { type: "string" } }),
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => ({ path: fieldString(value, "path", 4_000), query: fieldString(value, "query", 2_000) }),
      execute: async (_context, value) => {
        const input = value as { path: string; query: string };
        return executor.searchText(input.path, input.query);
      },
    },
    {
      name: "computer_write_file",
      description: "Create or overwrite a UTF-8 file under the workspace root; requires dangerous-tool consent",
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
        return executor.writeFile(input.path, input.content, input.overwrite);
      },
    },
    {
      name: "computer_run_command",
      description: "Spawn an executable with an argument array and no shell; requires dangerous-tool consent",
      inputSchema: objectSchema(["command", "args"], {
        command: { type: "string", maxLength: 200 },
        args: {
          type: "array",
          maxItems: MAX_COMMAND_ARGUMENTS,
          items: { type: "string", maxLength: MAX_COMMAND_ARGUMENT_CHARACTERS },
        },
        cwd: { type: "string" }, timeoutMs: { type: "integer" },
      }),
      executionMode: "exclusive",
      replaySafe: false,
      parse: (value) => {
        const record = requireRecord(value, "computer_run_command arguments");
        const timeoutMs = record.timeoutMs === undefined ? 30_000 : record.timeoutMs;
        if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 100 || (timeoutMs as number) > 120_000) {
          throw badRequest("timeoutMs must be an integer between 100 and 120000");
        }
        return {
          command: requireString(record.command, "command", { max: 200 }),
          args: commandArguments(record.args),
          cwd: record.cwd === undefined ? "." : requireString(record.cwd, "cwd", { max: 4_000 }),
          timeoutMs: timeoutMs as number,
        };
      },
      execute: async (context, value) => executor.runCommand({
        ...(value as { command: string; args: string[]; cwd: string; timeoutMs: number }),
        signal: context.signal,
      }),
    },
  ];
  if (driver !== undefined) tools.push(...createDriverTools(driver));
  return tools;
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

function objectSchema(required: readonly string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required, properties };
}
