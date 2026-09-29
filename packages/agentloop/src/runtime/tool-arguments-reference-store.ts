import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { notFound } from "../shared/errors.ts";

const TOOL_ARGUMENT_REFERENCE_THRESHOLD_BYTES = 8 * 1024;
const TOOL_ARGUMENT_REFERENCE_PREVIEW_CHARACTERS = 600;
const MAX_TOOL_ARGUMENT_REFERENCE_BYTES = 50 * 1024 * 1024;

export interface ToolArgumentsReference {
  readonly schema: "agentloop.toolArgumentsReference/v1";
  readonly path: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly characters?: number;
  readonly previewCharacters?: number;
}

export interface ToolArgumentsContent {
  readonly toolCallId: string;
  readonly arguments: unknown;
  readonly content: string;
  readonly path?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly characters?: number;
}

/**
 * Runtime-owned storage and restoration for oversized tool-call arguments.
 * It deliberately owns only neutral persistence and projection semantics.
 */
export class ToolArgumentsReferenceStore {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  project(argumentsValue: unknown): { readonly arguments: unknown; readonly argumentsRef?: ToolArgumentsReference } {
    const serialized = serializeToolArguments(argumentsValue);
    if (Buffer.byteLength(serialized) <= TOOL_ARGUMENT_REFERENCE_THRESHOLD_BYTES) return { arguments: argumentsValue };
    const reference = this.write(serialized);
    return { arguments: projectToolArgumentsValue(argumentsValue, reference, serialized), argumentsRef: reference };
  }

  async read(toolCallId: string, ref: ToolArgumentsReference): Promise<ToolArgumentsContent> {
    const target = await this.resolve(ref.path);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_TOOL_ARGUMENT_REFERENCE_BYTES) throw notFound("Tool arguments");
    const serialized = await fs.readFile(target, "utf8");
    if (ref.sha256 !== undefined && createHash("sha256").update(serialized).digest("hex") !== ref.sha256) {
      throw notFound("Tool arguments");
    }
    const argumentsValue = parseStoredToolArguments(serialized);
    return {
      toolCallId,
      arguments: argumentsValue,
      content: formatToolArgumentsContent(argumentsValue),
      path: ref.path,
      ...(ref.sha256 === undefined ? {} : { sha256: ref.sha256 }),
      ...(ref.bytes === undefined ? { bytes: stat.size } : { bytes: ref.bytes }),
      ...(ref.characters === undefined ? { characters: serialized.length } : { characters: ref.characters }),
    };
  }

  async resolveEventData(data: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
    const directRef = toolArgumentsReference(data.argumentsRef);
    let next: Record<string, unknown> | undefined;
    if (directRef !== undefined) next = { ...data, arguments: (await this.read(String(data.toolCallId ?? ""), directRef)).arguments };
    const toolCallsValue = (next ?? data).toolCalls;
    if (!Array.isArray(toolCallsValue)) return next ?? data;
    let changed = false;
    const toolCalls: unknown[] = [];
    for (const item of toolCallsValue) {
      const call = asRecord(item);
      const ref = toolArgumentsReference(call?.argumentsRef);
      if (call === undefined || ref === undefined) {
        toolCalls.push(item);
        continue;
      }
      toolCalls.push({ ...call, arguments: (await this.read(String(call.id ?? ""), ref)).arguments });
      changed = true;
    }
    return changed ? { ...(next ?? data), toolCalls } : (next ?? data);
  }

  private write(serialized: string): ToolArgumentsReference {
    const sha256 = createHash("sha256").update(serialized).digest("hex");
    const directory = resolve(this.workspaceRoot, ".agentloop", "tool-arguments", sha256.slice(0, 2));
    this.assertInsideWorkspace(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = resolve(directory, `${sha256}.json`);
    this.assertInsideWorkspace(target);
    try {
      writeFileSync(target, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return {
      schema: "agentloop.toolArgumentsReference/v1",
      path: relative(this.workspaceRoot, target),
      sha256,
      bytes: Buffer.byteLength(serialized),
      characters: serialized.length,
      previewCharacters: TOOL_ARGUMENT_REFERENCE_PREVIEW_CHARACTERS,
    };
  }

  private async resolve(path: string): Promise<string> {
    if (path.length === 0 || path.includes("\0") || isAbsolute(path)) throw notFound("Tool arguments");
    const normalized = path.replaceAll("\\", "/");
    if (normalized.split("/").some((part) => part === "" || part === "." || part === "..") || !normalized.startsWith(".agentloop/tool-arguments/")) {
      throw notFound("Tool arguments");
    }
    const root = await fs.realpath(this.workspaceRoot);
    const target = await fs.realpath(resolve(root, normalized));
    const fromRoot = relative(root, target);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw notFound("Tool arguments");
    return target;
  }

  private assertInsideWorkspace(path: string): void {
    const offset = relative(this.workspaceRoot, path);
    if (offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))) return;
    throw new TypeError("Tool arguments storage escapes the configured workspace root");
  }
}

export function toolArgumentsReference(value: unknown): ToolArgumentsReference | undefined {
  const record = asRecordOrJson(value);
  if (record === undefined || typeof record.path !== "string") return undefined;
  return {
    schema: "agentloop.toolArgumentsReference/v1",
    path: record.path,
    ...(typeof record.sha256 === "string" ? { sha256: record.sha256 } : {}),
    ...(typeof record.bytes === "number" ? { bytes: record.bytes } : {}),
    ...(typeof record.characters === "number" ? { characters: record.characters } : {}),
    ...(typeof record.previewCharacters === "number" ? { previewCharacters: record.previewCharacters } : {}),
  };
}

export function inlineToolArgumentsContent(toolCallId: string, argumentsValue: unknown): ToolArgumentsContent {
  const content = formatToolArgumentsContent(argumentsValue);
  return { toolCallId, arguments: argumentsValue, content, bytes: Buffer.byteLength(content), characters: content.length };
}

function asRecordOrJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try { return asRecordOrJson(JSON.parse(value) as unknown); } catch { return undefined; }
  }
  return asRecord(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function serializeToolArguments(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? JSON.stringify(String(value)) : serialized;
  } catch {
    return JSON.stringify(String(value));
  }
}

function parseStoredToolArguments(serialized: string): unknown {
  try { return JSON.parse(serialized) as unknown; } catch { throw notFound("Tool arguments"); }
}

function formatToolArgumentsContent(value: unknown): string {
  if (typeof value === "string") return value;
  const formatted = JSON.stringify(value, null, 2);
  return formatted === undefined ? String(value) : formatted;
}

function projectToolArgumentsValue(value: unknown, reference: ToolArgumentsReference, serialized: string): unknown {
  const summarized = summarizeToolArgumentValue(value);
  if (Buffer.byteLength(serializeToolArguments(summarized)) <= TOOL_ARGUMENT_REFERENCE_THRESHOLD_BYTES) return summarized;
  return {
    schema: "agentloop.toolArgumentsProjection/v1", projected: true,
    originalBytes: reference.bytes, originalCharacters: reference.characters, sha256: reference.sha256,
    preview: serialized.slice(0, TOOL_ARGUMENT_REFERENCE_PREVIEW_CHARACTERS),
    omittedCharacters: Math.max(0, serialized.length - TOOL_ARGUMENT_REFERENCE_PREVIEW_CHARACTERS),
    outline: outlineToolArguments(value),
  };
}

function summarizeToolArgumentValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) <= TOOL_ARGUMENT_REFERENCE_THRESHOLD_BYTES) return value;
    const sha256 = createHash("sha256").update(value).digest("hex");
    return { schema: "agentloop.toolArgumentTextProjection/v1", projected: true, originalBytes: Buffer.byteLength(value), originalCharacters: value.length, sha256,
      preview: value.slice(0, TOOL_ARGUMENT_REFERENCE_PREVIEW_CHARACTERS), omittedCharacters: Math.max(0, value.length - TOOL_ARGUMENT_REFERENCE_PREVIEW_CHARACTERS) };
  }
  if (Array.isArray(value)) return value.map((item) => summarizeToolArgumentValue(item));
  const record = asRecord(value);
  if (record === undefined) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) projected[key] = summarizeToolArgumentValue(item);
  return projected;
}

function outlineToolArguments(value: unknown): unknown {
  if (typeof value === "string") return { type: "string", characters: value.length, bytes: Buffer.byteLength(value) };
  if (Array.isArray(value)) return { type: "array", length: value.length, items: value.slice(0, 8).map((item) => outlineToolArguments(item)), truncated: value.length > 8 };
  const record = asRecord(value);
  if (record === undefined) return { type: value === null ? "null" : typeof value };
  const entries = Object.entries(record);
  return { type: "object", keys: entries.slice(0, 24).map(([key, item]) => ({ key, outline: outlineToolArguments(item) })), truncated: entries.length > 24 };
}
