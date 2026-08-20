import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { StoredRunEvent } from "./run-service.ts";

const MAX_PROCESS_ARTIFACT_BYTES = 50 * 1024 * 1024;
const COMMAND_ARTIFACT_EXTENSION_PATTERN = /(?:^|[\s'"(])([^\s'"),:;]+?\.(?:pdf|png|jpe?g|webp|gif|svg|html?|md|txt|csv|json|docx|pptx|xlsx))(?=$|[\s'"),:;])/giu;

export interface ProcessArtifact {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly sourceTool: "computer_write_file" | "computer_run_command";
  readonly previewable: boolean;
}

export async function collectProcessArtifacts(input: {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly runCreatedAt: number;
  readonly events: readonly StoredRunEvent[];
}): Promise<ProcessArtifact[]> {
  const candidates = collectCandidatePaths(input.events);
  const artifacts: ProcessArtifact[] = [];
  for (const candidate of candidates) {
    const file = await inspectCandidate(input.workspaceRoot, input.runCreatedAt, candidate.path);
    if (file === undefined) continue;
    const path = file.path;
    artifacts.push({
      id: artifactId(input.runId, path),
      path,
      name: basename(path),
      bytes: file.bytes,
      mimeType: mimeTypeFor(path),
      sourceTool: candidate.sourceTool,
      previewable: isPreviewable(path),
    });
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

export async function readProcessArtifact(input: {
  readonly artifact: ProcessArtifact;
  readonly workspaceRoot: string;
}): Promise<Buffer> {
  const target = await resolveWorkspaceFile(input.workspaceRoot, input.artifact.path);
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > MAX_PROCESS_ARTIFACT_BYTES) {
    throw new Error("Process artifact is unavailable");
  }
  return fs.readFile(target);
}

export function artifactId(runId: string, path: string): string {
  return createHash("sha256").update(`${runId}\0${path}`).digest("hex");
}

function collectCandidatePaths(events: readonly StoredRunEvent[]): Array<{
  path: string;
  sourceTool: "computer_write_file" | "computer_run_command";
}> {
  const candidates = new Map<string, "computer_write_file" | "computer_run_command">();
  for (const event of events) {
    if (event.type !== "tool.completed") continue;
    const toolName = typeof event.data.toolName === "string" ? event.data.toolName : "";
    const result = parseResult(event.data.result);
    if (toolName === "computer_write_file") {
      const path = result !== undefined && typeof result.path === "string" ? result.path : undefined;
      if (path !== undefined && isSafeRelativePath(path)) candidates.set(path, "computer_write_file");
      continue;
    }
    if (toolName !== "computer_run_command" || result?.exitCode !== 0 || typeof result.stdout !== "string") continue;
    for (const path of pathsMentionedInCommandOutput(result.stdout)) {
      if (!candidates.has(path)) candidates.set(path, "computer_run_command");
    }
  }
  return [...candidates.entries()].map(([path, sourceTool]) => ({ path, sourceTool }));
}

function parseResult(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function pathsMentionedInCommandOutput(stdout: string): string[] {
  const paths = new Set<string>();
  for (const match of stdout.matchAll(COMMAND_ARTIFACT_EXTENSION_PATTERN)) {
    const path = match[1];
    if (path !== undefined && path.length > 0 && !path.includes("\0")) paths.add(path);
  }
  return [...paths];
}

async function inspectCandidate(
  workspaceRoot: string,
  runCreatedAt: number,
  path: string,
): Promise<{ path: string; bytes: number } | undefined> {
  try {
    const resolved = await resolveWorkspacePath(workspaceRoot, path);
    const target = resolved.absolutePath;
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_PROCESS_ARTIFACT_BYTES || stat.mtimeMs + 1_000 < runCreatedAt) return undefined;
    return { path: resolved.relativePath, bytes: stat.size };
  } catch {
    return undefined;
  }
}

async function resolveWorkspaceFile(workspaceRoot: string, path: string): Promise<string> {
  return (await resolveWorkspacePath(workspaceRoot, path)).absolutePath;
}

async function resolveWorkspacePath(workspaceRoot: string, path: string): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  if (path.length === 0 || path.includes("\0")) throw new Error("Invalid artifact path");
  if (!isAbsolute(path) && !isSafeRelativePath(path)) throw new Error("Invalid artifact path");
  const root = await fs.realpath(workspaceRoot);
  const target = await fs.realpath(isAbsolute(path) ? path : resolve(root, path));
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Artifact escapes workspace");
  }
  const normalized = fromRoot.split(sep).join("/");
  if (!isSafeRelativePath(normalized)) throw new Error("Invalid artifact path");
  return { absolutePath: target, relativePath: normalized };
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.includes("\0")) return false;
  const normalized = path.replaceAll("\\", "/");
  return !normalized.split("/").some((part) => part === "" || part === "." || part === "..");
}

function mimeTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const types: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
    html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
    csv: "text/csv; charset=utf-8", json: "application/json; charset=utf-8",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return types[extension] ?? "application/octet-stream";
}

function isPreviewable(path: string): boolean {
  return /\.(?:pdf|png|jpe?g|webp|gif|svg|html?)$/i.test(path);
}
