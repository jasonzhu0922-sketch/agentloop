import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import { AppError, badRequest } from "../shared/errors.ts";
import { requireRecord, requireString } from "../shared/validation.ts";
import { buildOpaqueArtifactReceipt } from "../runtime/artifact-receipt.ts";
import { ComputerExecutor } from "../computer/computer-executor.ts";
import type { RuntimeTool, ToolExecutionContext } from "./tool-registry.ts";

const DEFAULT_CONVERSION_TIMEOUT_MS = 120_000;
const MIN_CONVERSION_TIMEOUT_MS = 1_000;
const MAX_CONVERSION_TIMEOUT_MS = 300_000;

const SOURCE_FORMATS = ["auto", "markdown", "html", "docx", "txt"] as const;
const TARGET_FORMATS = ["docx", "pdf", "html", "markdown", "txt"] as const;

type SourceFormat = typeof SOURCE_FORMATS[number];
type ResolvedSourceFormat = Exclude<SourceFormat, "auto">;
type TargetFormat = typeof TARGET_FORMATS[number];

export interface ConvertArtifactInput {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly sourceFormat: SourceFormat;
  readonly targetFormat: TargetFormat;
  readonly overwrite: boolean;
  readonly timeoutMs: number;
}

export function createArtifactConverterTools(executor: ComputerExecutor): RuntimeTool<unknown>[] {
  return [{
    name: "convert_artifact",
    description: [
      "Convert an existing artifact under the workspace root to another document format; requires dangerous-tool consent.",
      "inputPath and outputPath must be relative to the workspace root; absolute paths and @skills/@visible aliases are rejected.",
      "Supported source formats are auto, markdown, html, docx, and txt. Supported target formats are docx, pdf, html, markdown, and txt.",
      "PDF output is rendered through an HTML pipeline when possible, avoiding direct LaTeX-dependent Markdown-to-PDF conversion.",
      "The result includes schema agentloop.artifactConversion/v1 and an embedded artifactReceipt for the converted output. After conversion, call verify_artifact_acceptance for the requested target format.",
    ].join(" "),
    inputSchema: objectSchema(["inputPath", "outputPath", "targetFormat"], {
      inputPath: { type: "string", maxLength: 4_000 },
      outputPath: { type: "string", maxLength: 4_000 },
      sourceFormat: { type: "string", enum: SOURCE_FORMATS },
      targetFormat: { type: "string", enum: TARGET_FORMATS },
      overwrite: { type: "boolean" },
      timeoutMs: { type: "integer", minimum: MIN_CONVERSION_TIMEOUT_MS, maximum: MAX_CONVERSION_TIMEOUT_MS },
    }),
    executionMode: "exclusive",
    replaySafe: false,
    timeoutMs: MAX_CONVERSION_TIMEOUT_MS,
    parse: parseConvertArtifactInput,
    execute: async (context, value) => executeArtifactConversion(
      executorForContext(executor, context),
      value as ConvertArtifactInput,
      context.signal,
    ),
  }];
}

export function parseConvertArtifactInput(value: unknown): ConvertArtifactInput {
  const record = requireRecord(value, "convert_artifact arguments");
  const sourceFormat = record.sourceFormat === undefined
    ? "auto"
    : normalizeSourceFormat(requireString(record.sourceFormat, "sourceFormat", { max: 64 }));
  const targetFormat = normalizeTargetFormat(requireString(record.targetFormat, "targetFormat", { max: 64 }));
  if (record.overwrite !== undefined && typeof record.overwrite !== "boolean") {
    throw badRequest("overwrite must be boolean");
  }
  const timeoutMs = record.timeoutMs === undefined ? DEFAULT_CONVERSION_TIMEOUT_MS : record.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < MIN_CONVERSION_TIMEOUT_MS || (timeoutMs as number) > MAX_CONVERSION_TIMEOUT_MS) {
    throw badRequest(`timeoutMs must be an integer between ${MIN_CONVERSION_TIMEOUT_MS} and ${MAX_CONVERSION_TIMEOUT_MS}`);
  }
  const outputPath = requireString(record.outputPath, "outputPath", { max: 4_000 });
  assertTargetExtension(outputPath, targetFormat);
  return {
    inputPath: requireString(record.inputPath, "inputPath", { max: 4_000 }),
    outputPath,
    sourceFormat,
    targetFormat,
    overwrite: record.overwrite === true,
    timeoutMs: timeoutMs as number,
  };
}

async function executeArtifactConversion(
  executor: ComputerExecutor,
  input: ConvertArtifactInput,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const source = await executor.inspectFile(input.inputPath);
  if (source.bytes === 0) throw badRequest("inputPath must identify a non-empty artifact");
  const sourceFormat = input.sourceFormat === "auto" ? inferSourceFormat(source.path) : input.sourceFormat;
  if (sourceFormat === undefined) {
    throw badRequest("sourceFormat could not be inferred from inputPath; set sourceFormat explicitly");
  }
  if (normalizeWorkspacePath(source.path) === normalizeWorkspacePath(input.outputPath)) {
    throw badRequest("outputPath must be different from inputPath");
  }
  const preparedOutput = await executor.prepareWritableFile(input.outputPath, input.overwrite ? "overwrite" : "create");
  const commands: Array<{ engine: string; args: readonly string[]; exitCode: number | null }> = [];
  if (input.targetFormat === "pdf") {
    const htmlPath = sourceFormat === "html"
      ? source.path
      : `.agentloop/conversions/${conversionId(source.path, preparedOutput.path)}.html`;
    if (sourceFormat !== "html") {
      await executor.prepareWritableFile(htmlPath, "create");
      const htmlArgs = pandocArgs(source.path, htmlPath, sourceFormat, "html");
      const htmlResult = await executor.runCommand({ command: "pandoc", args: htmlArgs, cwd: ".", timeoutMs: input.timeoutMs, signal });
      commands.push({ engine: "pandoc", args: htmlArgs, exitCode: htmlResult.exitCode });
      assertCommandSucceeded("pandoc", htmlResult);
    }
    const pdfArgs = [htmlPath, preparedOutput.path] as const;
    const pdfResult = await executor.runCommand({ command: "weasyprint", args: pdfArgs, cwd: ".", timeoutMs: input.timeoutMs, signal });
    commands.push({ engine: "weasyprint", args: pdfArgs, exitCode: pdfResult.exitCode });
    assertCommandSucceeded("weasyprint", pdfResult);
  } else {
    const args = pandocArgs(source.path, preparedOutput.path, sourceFormat, input.targetFormat);
    const result = await executor.runCommand({ command: "pandoc", args, cwd: ".", timeoutMs: input.timeoutMs, signal });
    commands.push({ engine: "pandoc", args, exitCode: result.exitCode });
    assertCommandSucceeded("pandoc", result);
  }
  const artifact = await executor.inspectFile(preparedOutput.path);
  if (artifact.bytes === 0) throw new AppError("TOOL_EXECUTION_ERROR", "Artifact conversion produced an empty output file", 500);
  const receipt = buildOpaqueArtifactReceipt("convert_artifact", artifact, {
    artifactKind: input.targetFormat === "txt" ? "generic_file" : input.targetFormat,
    acceptanceProfile: input.targetFormat === "txt" ? "generic_file" : input.targetFormat,
    writeMode: preparedOutput.mode,
    writtenBytes: artifact.bytes,
    conversionEngine: commands.map((command) => command.engine).join("+"),
    sourcePath: source.path,
    sourceFormat,
    targetFormat: input.targetFormat,
  });
  return {
    schema: "agentloop.artifactConversion/v1",
    source: {
      path: source.path,
      format: sourceFormat,
      bytes: source.bytes,
      sha256: source.sha256,
    },
    output: {
      path: artifact.path,
      format: input.targetFormat,
      mimeType: mimeTypeForTarget(input.targetFormat),
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    },
    engine: commands.map((command) => command.engine).join("+"),
    commands,
    artifactReceipt: receipt,
  };
}

function executorForContext(executor: ComputerExecutor, context: ToolExecutionContext): ComputerExecutor {
  if (context.grant.workspaceRoot !== undefined) return executor.withWorkspaceRoot(context.grant.workspaceRoot);
  return executor;
}

function pandocArgs(
  inputPath: string,
  outputPath: string,
  sourceFormat: ResolvedSourceFormat,
  targetFormat: TargetFormat,
): readonly string[] {
  return [
    "--standalone",
    "--from",
    pandocSourceFormat(sourceFormat),
    "--to",
    pandocTargetFormat(targetFormat),
    inputPath,
    "--output",
    outputPath,
  ];
}

function assertCommandSucceeded(
  engine: string,
  result: Awaited<ReturnType<ComputerExecutor["runCommand"]>>,
): void {
  if (result.exitCode === 0) return;
  throw new AppError("TOOL_EXECUTION_ERROR", `${engine} artifact conversion failed`, 500, {
    engine,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function normalizeSourceFormat(value: string): SourceFormat {
  const normalized = value.toLowerCase() === "md" ? "markdown" : value.toLowerCase();
  if ((SOURCE_FORMATS as readonly string[]).includes(normalized)) return normalized as SourceFormat;
  throw badRequest(`sourceFormat must be one of ${SOURCE_FORMATS.join(", ")}`);
}

function normalizeTargetFormat(value: string): TargetFormat {
  const normalized = value.toLowerCase() === "md" ? "markdown" : value.toLowerCase();
  if ((TARGET_FORMATS as readonly string[]).includes(normalized)) return normalized as TargetFormat;
  throw badRequest(`targetFormat must be one of ${TARGET_FORMATS.join(", ")}`);
}

function inferSourceFormat(path: string): ResolvedSourceFormat | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension === ".docx") return "docx";
  if (extension === ".txt") return "txt";
  return undefined;
}

function assertTargetExtension(path: string, targetFormat: TargetFormat): void {
  const extension = extname(path).toLowerCase();
  const valid = targetFormat === "markdown"
    ? extension === ".md" || extension === ".markdown"
    : targetFormat === "html"
      ? extension === ".html" || extension === ".htm"
      : extension === `.${targetFormat}`;
  if (!valid) throw badRequest(`outputPath extension must match targetFormat ${targetFormat}`);
}

function pandocSourceFormat(format: ResolvedSourceFormat): string {
  if (format === "markdown") return "gfm";
  if (format === "txt") return "markdown";
  return format;
}

function pandocTargetFormat(format: TargetFormat): string {
  if (format === "markdown") return "gfm";
  if (format === "txt") return "plain";
  return format;
}

function mimeTypeForTarget(format: TargetFormat): string {
  switch (format) {
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "pdf":
      return "application/pdf";
    case "html":
      return "text/html; charset=utf-8";
    case "markdown":
      return "text/markdown; charset=utf-8";
    case "txt":
      return "text/plain; charset=utf-8";
  }
}

function conversionId(inputPath: string, outputPath: string): string {
  const suffix = createHash("sha256").update(`${inputPath}\0${outputPath}\0${randomUUID()}`).digest("hex").slice(0, 24);
  return `convert-${suffix}`;
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//u, "").replace(/\/+/gu, "/");
}

function objectSchema(required: readonly string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required, properties };
}
