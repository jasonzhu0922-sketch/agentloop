import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { notFound } from "../shared/errors.ts";

const MAX_COMMAND_OUTPUT_REFERENCE_BYTES = 50 * 1024 * 1024;

export interface CommandOutputQueryRun {
  readonly ownerUserId: string;
  readonly conversationId?: string;
}

export interface CommandOutputQueryEvent {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface CommandOutputContent {
  readonly toolCallId: string;
  readonly stream: "stdout" | "stderr";
  readonly content: string;
  readonly path?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly characters?: number;
}

/** Read-only command-output projection from durable tool evidence. */
export class RuntimeCommandOutputQueryService {
  private readonly input: {
    readonly run: (actorUserId: string, runId: string) => Promise<CommandOutputQueryRun>;
    readonly events: (actorUserId: string, runId: string) => Promise<readonly CommandOutputQueryEvent[]>;
    readonly workspaceRoot: (run: CommandOutputQueryRun) => string;
  };

  constructor(input: RuntimeCommandOutputQueryService["input"]) { this.input = input; }

  async read(actorUserId: string, runId: string, toolCallId: string, stream: "stdout" | "stderr"): Promise<CommandOutputContent> {
    const run = await this.input.run(actorUserId, runId);
    const completed = (await this.input.events(actorUserId, runId)).find((event) => event.type === "tool.completed"
      && event.data.toolName === "computer_run_command" && event.data.toolCallId === toolCallId);
    if (completed === undefined) throw notFound("Command output");
    const result = record(completed.data.result);
    if (result === undefined) throw notFound("Command output");
    const ref = reference(result[`${stream}Ref`]);
    if (ref === undefined) {
      const content = typeof result[stream] === "string" ? result[stream] : "";
      return { toolCallId, stream, content, bytes: Buffer.byteLength(content), characters: content.length };
    }
    const target = await safeReference(this.input.workspaceRoot(run), ref.path);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_COMMAND_OUTPUT_REFERENCE_BYTES) throw notFound("Command output");
    return { toolCallId, stream, content: await fs.readFile(target, "utf8"), path: ref.path,
      ...(ref.sha256 === undefined ? {} : { sha256: ref.sha256 }),
      ...(ref.bytes === undefined ? { bytes: stat.size } : { bytes: ref.bytes }),
      ...(ref.characters === undefined ? {} : { characters: ref.characters }) };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") { try { return record(JSON.parse(value) as unknown); } catch { return undefined; } }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function reference(value: unknown): { readonly path: string; readonly sha256?: string; readonly bytes?: number; readonly characters?: number } | undefined {
  const item = record(value);
  return item === undefined || typeof item.path !== "string" ? undefined : { path: item.path,
    ...(typeof item.sha256 === "string" ? { sha256: item.sha256 } : {}), ...(typeof item.bytes === "number" ? { bytes: item.bytes } : {}), ...(typeof item.characters === "number" ? { characters: item.characters } : {}) };
}
async function safeReference(workspaceRoot: string, path: string): Promise<string> {
  if (path.length === 0 || path.includes("\0") || isAbsolute(path)) throw notFound("Command output");
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) throw notFound("Command output");
  const root = await fs.realpath(workspaceRoot); const target = await fs.realpath(resolve(root, normalized)); const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw notFound("Command output");
  return target;
}
