import { clip, fmtBytes, parseResult } from "./format";
import type { RunEvent, ToolArgumentsReference } from "./types";

export type CommandStatus = "queued" | "running" | "completed" | "failed" | "rejected";

export interface CommandActivity {
  readonly toolCallId: string;
  readonly step?: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly status: CommandStatus;
  readonly submittedAt?: number;
  readonly dispatchedAt?: number;
  readonly completedAt?: number;
  readonly durationMs?: number;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly stdoutRef?: CommandOutputReference;
  readonly stderrRef?: CommandOutputReference;
  readonly argumentsRef?: ToolArgumentsReference;
  readonly error?: string;
}

interface MutableCommandActivity {
  toolCallId: string;
  step?: number;
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  status: CommandStatus;
  submittedAt?: number;
  dispatchedAt?: number;
  completedAt?: number;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  stdoutRef?: CommandOutputReference;
  stderrRef?: CommandOutputReference;
  argumentsRef?: ToolArgumentsReference;
  error?: string;
}

export interface CommandOutputReference {
  readonly path: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly characters?: number;
  readonly previewCharacters?: number;
}

export function commandActivities(events: readonly RunEvent[]): readonly CommandActivity[] {
  const commands = new Map<string, MutableCommandActivity>();
  for (const event of events) {
    const d = event.data ?? {};
    const toolCallId = typeof d.toolCallId === "string" ? d.toolCallId : undefined;
    if (toolCallId === undefined) continue;
    if (event.type === "assistant.tool_call.committed" || event.type === "tool.planned") {
      const toolName = String(d.toolName ?? d.name ?? "");
      if (toolName !== "computer_run_command") continue;
      const args = commandArgs(d.arguments);
      const current = commands.get(toolCallId) ?? {
        toolCallId,
        command: "",
        args: [],
        status: "queued" as const,
      };
      current.step = numberValue(d.step) ?? current.step;
      current.command = stringField(d.arguments, "command") ?? current.command;
      current.args = args;
      current.cwd = stringField(d.arguments, "cwd") ?? current.cwd;
      current.timeoutMs = numberValue(recordValue(d.arguments)?.timeoutMs) ?? current.timeoutMs;
      current.argumentsRef = toolArgumentsRef(d.argumentsRef) ?? current.argumentsRef;
      current.submittedAt = current.submittedAt ?? event.createdAt;
      commands.set(toolCallId, current);
      continue;
    }
    const current = commands.get(toolCallId);
    if (current === undefined) continue;
    if (event.type === "tool.dispatched") {
      current.status = "running";
      current.dispatchedAt = event.createdAt;
      continue;
    }
    if (event.type === "tool.completed") {
      current.status = "completed";
      current.completedAt = event.createdAt;
      current.durationMs = duration(current.dispatchedAt ?? current.submittedAt, current.completedAt);
      applyCommandResult(current, parseResult(d.result));
      continue;
    }
    if (event.type === "tool.failed") {
      current.status = "failed";
      current.completedAt = event.createdAt;
      current.durationMs = duration(current.dispatchedAt ?? current.submittedAt, current.completedAt);
      current.error = String(d.error ?? "");
      continue;
    }
    if (event.type === "tool.rejected") {
      current.status = "rejected";
      current.completedAt = event.createdAt;
      current.durationMs = duration(current.dispatchedAt ?? current.submittedAt, current.completedAt);
      current.error = String(d.reason ?? "");
    }
  }
  return [...commands.values()].sort((left, right) =>
    (left.submittedAt ?? 0) - (right.submittedAt ?? 0) || left.toolCallId.localeCompare(right.toolCallId)
  );
}

export function commandLine(activity: Pick<CommandActivity, "command" | "args">): string {
  const args = summarizeArgs(activity.args);
  return [activity.command || "?", ...args].join(" ").trim();
}

export function fullCommandLine(activity: Pick<CommandActivity, "command" | "args">): string {
  return [activity.command || "?", ...activity.args.map(shellQuote)].join(" ").trim();
}

export function commandStatusLabel(status: CommandStatus): string {
  return {
    queued: "已提交",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    rejected: "被拒绝",
  }[status];
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return ms + " ms";
  const seconds = ms / 1000;
  if (seconds < 60) return seconds.toFixed(seconds < 10 ? 1 : 0) + " s";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return minutes + " min " + rest + " s";
}

export function commandSummary(activity: CommandActivity): string {
  if (activity.status === "running") return "已派发，等待命令返回";
  if (activity.status === "queued") return "等待执行";
  if (activity.status === "rejected") return clip(activity.error, 120) || "Runtime 未执行该命令";
  if (activity.status === "failed") return clip(activity.error, 120) || "命令执行失败";
  const parts = [
    activity.exitCode === undefined ? "" : "退出码 " + String(activity.exitCode),
    activity.durationMs === undefined ? "" : formatDuration(activity.durationMs),
    activity.stdoutRef === undefined ? "" : "stdout " + refLabel(activity.stdoutRef),
    activity.stderrRef === undefined ? "" : "stderr " + refLabel(activity.stderrRef),
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  return clip(activity.stdout || activity.stderr, 120) || "命令执行完成";
}

function summarizeArgs(args: readonly string[]): string[] {
  if (!args.includes("-c")) return [...args];
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    result.push(args[index]);
    if (args[index] === "-c" && index + 1 < args.length) {
      result.push("[inline script]");
      index += 1;
    }
  }
  return result;
}

function applyCommandResult(activity: MutableCommandActivity, result: unknown): void {
  const record = recordValue(result);
  if (record === undefined) return;
  activity.exitCode = numberValue(record.exitCode) ?? null;
  activity.signal = typeof record.signal === "string" ? record.signal : null;
  activity.stdout = typeof record.stdout === "string" ? record.stdout : undefined;
  activity.stderr = typeof record.stderr === "string" ? record.stderr : undefined;
  activity.stdoutRef = commandRef(record.stdoutRef);
  activity.stderrRef = commandRef(record.stderrRef);
}

function commandArgs(value: unknown): string[] {
  const args = recordValue(value)?.args;
  return Array.isArray(args) ? args.map((item) => argumentText(item)) : [];
}

function commandRef(value: unknown): CommandOutputReference | undefined {
  const record = recordValue(value);
  if (record === undefined) return undefined;
  const path = typeof record.path === "string" ? record.path : undefined;
  if (path === undefined) return undefined;
  return {
    path,
    ...(typeof record.sha256 === "string" ? { sha256: record.sha256 } : {}),
    ...(typeof record.bytes === "number" ? { bytes: record.bytes } : {}),
    ...(typeof record.characters === "number" ? { characters: record.characters } : {}),
    ...(typeof record.previewCharacters === "number" ? { previewCharacters: record.previewCharacters } : {}),
  };
}

function toolArgumentsRef(value: unknown): ToolArgumentsReference | undefined {
  const record = recordValue(value);
  if (record === undefined) return undefined;
  const path = typeof record.path === "string" ? record.path : undefined;
  if (path === undefined) return undefined;
  return {
    ...(typeof record.schema === "string" ? { schema: record.schema as ToolArgumentsReference["schema"] } : {}),
    path,
    ...(typeof record.sha256 === "string" ? { sha256: record.sha256 } : {}),
    ...(typeof record.bytes === "number" ? { bytes: record.bytes } : {}),
    ...(typeof record.characters === "number" ? { characters: record.characters } : {}),
    ...(typeof record.previewCharacters === "number" ? { previewCharacters: record.previewCharacters } : {}),
  };
}

function refLabel(ref: { readonly path: string; readonly bytes?: number; readonly characters?: number }): string {
  return ref.bytes === undefined ? ref.path : ref.path + " (" + fmtBytes(ref.bytes) + ")";
}

function duration(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined || end < start) return undefined;
  return end - start;
}

function stringField(value: unknown, field: string): string | undefined {
  const record = recordValue(value);
  const item = record?.[field];
  return typeof item === "string" ? item : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function argumentText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = recordValue(value);
  if (record?.schema === "agentloop.toolArgumentTextProjection/v1") {
    const preview = typeof record.preview === "string" ? record.preview : "";
    const characters = typeof record.originalCharacters === "number" ? ` (${record.originalCharacters} chars)` : "";
    return preview + "… [ref]" + characters;
  }
  return String(value);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
