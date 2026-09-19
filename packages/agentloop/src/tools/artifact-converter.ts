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

const SOURCE_FORMATS = ["auto", "markdown", "html", "docx", "pptx", "txt"] as const;
const TARGET_FORMATS = ["docx", "pdf", "html", "markdown", "txt"] as const;
const REPORTLAB_PDF_FALLBACK_SCRIPT = String.raw`
import html
import re
import sys
from html.parser import HTMLParser

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer

FONT_NAME = "STSong-Light"
pdfmetrics.registerFont(UnicodeCIDFont(FONT_NAME))


class TextHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in {"script", "style", "svg"}:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag in {"h1", "h2", "h3", "h4"}:
            self.parts.append("\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self.parts.append("\n- ")
        elif tag in {"td", "th"}:
            self.parts.append(" | ")
        elif tag in {"p", "div", "br", "tr", "table", "section", "article", "main"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in {"script", "style", "svg"} and self.skip_depth:
            self.skip_depth -= 1
            return
        if not self.skip_depth and tag in {"p", "div", "li", "tr", "table", "h1", "h2", "h3", "h4"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip_depth:
            self.parts.append(data)

    def text(self):
        return re.sub(r"\n{3,}", "\n\n", "".join(self.parts))


def source_text(path, source_format):
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        raw = handle.read()
    if source_format == "html":
        parser = TextHTMLParser()
        parser.feed(raw)
        return parser.text()
    return raw


def clean_inline(text):
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = text.replace(chr(96), "").replace("**", "").replace("__", "").replace("*", "")
    return html.escape(text.strip())


def build_pdf(input_path, output_path, source_format):
    styles = {
        "h1": ParagraphStyle("H1", fontName=FONT_NAME, fontSize=18, leading=24, spaceBefore=8, spaceAfter=8),
        "h2": ParagraphStyle("H2", fontName=FONT_NAME, fontSize=15, leading=21, spaceBefore=8, spaceAfter=6),
        "h3": ParagraphStyle("H3", fontName=FONT_NAME, fontSize=12.5, leading=18, spaceBefore=6, spaceAfter=4),
        "body": ParagraphStyle("Body", fontName=FONT_NAME, fontSize=10.5, leading=16, spaceAfter=6),
    }
    text = source_text(input_path, source_format)
    doc = SimpleDocTemplate(output_path, pagesize=A4, leftMargin=1.7 * cm, rightMargin=1.7 * cm, topMargin=1.6 * cm, bottomMargin=1.6 * cm)
    story = []
    pending_para = []

    def flush_para():
        if pending_para:
            story.append(Paragraph(clean_inline(" ".join(pending_para)), styles["body"]))
            pending_para.clear()

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            flush_para()
            continue
        heading = re.match(r"^(#{1,3})\s+(.+)$", line)
        if heading:
            flush_para()
            story.append(Paragraph(clean_inline(heading.group(2)), styles["h" + str(len(heading.group(1)))]))
        elif re.match(r"^[-*+]\s+", line):
            flush_para()
            story.append(Paragraph("&#8226; " + clean_inline(re.sub(r"^[-*+]\s+", "", line)), styles["body"]))
        else:
            pending_para.append(line)
    flush_para()
    if not story:
        story.append(Paragraph("No readable text was found in the source artifact.", styles["body"]))
    story.append(Spacer(1, 0.1 * cm))
    doc.build(story)


if __name__ == "__main__":
    build_pdf(sys.argv[1], sys.argv[2], sys.argv[3])
`;

// LibreOffice is deliberately not part of the Runtime conversion contract. This
// renderer covers the portable PPTX subset (slide geometry, fills, text, images,
// and basic shapes) using the same Python packages already used by the PPTX Skill.
const PPTX_PDF_RENDERER_SCRIPT = String.raw`
from io import BytesIO
import sys
import textwrap

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from reportlab.lib.colors import HexColor, black, white
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen.canvas import Canvas

EMU_PER_POINT = 12700.0
FONT_NAME = "STSong-Light"
pdfmetrics.registerFont(UnicodeCIDFont(FONT_NAME))


def color(value, fallback=black):
    try:
        rgb = value.rgb
        if rgb is not None:
            return HexColor("#" + str(rgb))
    except Exception:
        pass
    return fallback


def fill_color(shape):
    try:
        if shape.fill.type is None:
            return None
        return color(shape.fill.fore_color, white)
    except Exception:
        return None


def line_color(shape):
    try:
        return color(shape.line.color, black)
    except Exception:
        return None


def draw_text(canvas, shape, slide_height):
    frame = shape.text_frame
    left = shape.left / EMU_PER_POINT
    top = slide_height - (shape.top + shape.height) / EMU_PER_POINT
    width = max(shape.width / EMU_PER_POINT, 1.0)
    height = max(shape.height / EMU_PER_POINT, 1.0)
    margin_left = getattr(frame, "margin_left", 0) / EMU_PER_POINT
    margin_top = getattr(frame, "margin_top", 0) / EMU_PER_POINT
    x = left + margin_left
    y = top + height - margin_top
    for paragraph in frame.paragraphs:
        runs = [run for run in paragraph.runs if run.text]
        text = "".join(run.text for run in runs).strip()
        if not text:
            y -= 12
            continue
        run = runs[0] if runs else None
        size = 12
        if run is not None and run.font.size is not None:
            size = max(run.font.size.pt, 4)
        canvas.setFont(FONT_NAME, size)
        canvas.setFillColor(color(run.font.color, black) if run is not None else black)
        line_height = size * 1.25
        max_chars = max(int(width / max(size * 0.55, 1)), 1)
        for line in text.splitlines() or [""]:
            for wrapped in textwrap.wrap(line, width=max_chars, break_long_words=False, break_on_hyphens=False) or [""]:
                if y < top:
                    return
                canvas.drawString(x, y - size, wrapped)
                y -= line_height


def draw_shape(canvas, shape, slide_height):
    shape_type = getattr(shape, "shape_type", None)
    if shape_type == MSO_SHAPE_TYPE.GROUP:
        for child in shape.shapes:
            draw_shape(canvas, child, slide_height)
        return
    if shape_type not in {MSO_SHAPE_TYPE.AUTO_SHAPE, MSO_SHAPE_TYPE.PICTURE, MSO_SHAPE_TYPE.TEXT_BOX, MSO_SHAPE_TYPE.PLACEHOLDER}:
        raise RuntimeError("unsupported PPTX shape type: " + str(shape_type))
    left = shape.left / EMU_PER_POINT
    bottom = slide_height - (shape.top + shape.height) / EMU_PER_POINT
    width = max(shape.width / EMU_PER_POINT, 0)
    height = max(shape.height / EMU_PER_POINT, 0)
    if shape_type == MSO_SHAPE_TYPE.PICTURE:
        canvas.drawImage(ImageReader(BytesIO(shape.image.blob)), left, bottom, width, height, preserveAspectRatio=True, anchor="c", mask="auto")
    else:
        fill = fill_color(shape)
        stroke = line_color(shape)
        if fill is not None:
            canvas.setFillColor(fill)
        if stroke is not None:
            canvas.setStrokeColor(stroke)
        canvas.rect(left, bottom, width, height, fill=1 if fill is not None else 0, stroke=1 if stroke is not None else 0)
    if getattr(shape, "has_text_frame", False):
        draw_text(canvas, shape, slide_height)


def render(input_path, output_path):
    presentation = Presentation(input_path)
    width = presentation.slide_width / EMU_PER_POINT
    height = presentation.slide_height / EMU_PER_POINT
    canvas = Canvas(output_path, pagesize=(width, height))
    for slide in presentation.slides:
        try:
            background = slide.background.fill
            if background.type is not None:
                canvas.setFillColor(color(background.fore_color, white))
                canvas.rect(0, 0, width, height, fill=1, stroke=0)
        except Exception:
            pass
        for shape in slide.shapes:
            draw_shape(canvas, shape, height)
        canvas.showPage()
    canvas.save()


if __name__ == "__main__":
    render(sys.argv[1], sys.argv[2])
`;

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
      "Supported source formats are auto, markdown, html, docx, pptx, and txt. Supported target formats are docx, pdf, html, markdown, and txt.",
      "PPTX sources currently support PDF output through the portable python-pptx/reportlab renderer; LibreOffice is not required.",
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
  if (sourceFormat === "pptx" && input.targetFormat !== "pdf") {
    throw badRequest("pptx source format currently supports only pdf target format");
  }
  const preparedOutput = await executor.prepareWritableFile(input.outputPath, input.overwrite ? "overwrite" : "create");
  const commands: Array<{ engine: string; args: readonly string[]; exitCode: number | null }> = [];
  if (sourceFormat === "pptx") {
    const args = ["-c", PPTX_PDF_RENDERER_SCRIPT, source.path, preparedOutput.path] as const;
    const result = await executor.runCommand({ command: "python3", args, cwd: ".", timeoutMs: input.timeoutMs, signal });
    commands.push({ engine: "python-pptx-reportlab", args: ["-c", "[embedded-pptx-pdf-renderer]", source.path, preparedOutput.path], exitCode: result.exitCode });
    assertCommandSucceeded("python-pptx-reportlab", result);
  } else if (input.targetFormat === "pdf") {
    const htmlPath = sourceFormat === "html"
      ? source.path
      : `.agentloop/conversions/${conversionId(source.path, preparedOutput.path)}.html`;
    let fallbackInputPath = source.path;
    let fallbackSourceFormat: ResolvedSourceFormat = sourceFormat;
    if (sourceFormat !== "html") {
      await executor.prepareWritableFile(htmlPath, "create");
      const htmlArgs = pandocArgs(source.path, htmlPath, sourceFormat, "html");
      const htmlResult = await executor.runCommand({ command: "pandoc", args: htmlArgs, cwd: ".", timeoutMs: input.timeoutMs, signal });
      commands.push({ engine: "pandoc", args: htmlArgs, exitCode: htmlResult.exitCode });
      assertCommandSucceeded("pandoc", htmlResult);
      fallbackInputPath = htmlPath;
      fallbackSourceFormat = "html";
    }
    const pdfArgs = [htmlPath, preparedOutput.path] as const;
    const pdfResult = await runOptionalConversionCommand(executor, "weasyprint", pdfArgs, input.timeoutMs, signal);
    commands.push({ engine: "weasyprint", args: pdfArgs, exitCode: pdfResult?.exitCode ?? null });
    if (pdfResult?.exitCode !== 0) {
      const fallbackArgs = ["-c", REPORTLAB_PDF_FALLBACK_SCRIPT, fallbackInputPath, preparedOutput.path, fallbackSourceFormat] as const;
      const fallbackResult = await executor.runCommand({ command: "python3", args: fallbackArgs, cwd: ".", timeoutMs: input.timeoutMs, signal });
      commands.push({ engine: "reportlab-fallback", args: ["-c", "[embedded-reportlab-pdf-fallback]", fallbackInputPath, preparedOutput.path, fallbackSourceFormat], exitCode: fallbackResult.exitCode });
      assertCommandSucceeded("reportlab-fallback", fallbackResult);
    }
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

async function runOptionalConversionCommand(
  executor: ComputerExecutor,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<ComputerExecutor["runCommand"]>> | undefined> {
  try {
    return await executor.runCommand({ command, args, cwd: ".", timeoutMs, signal });
  } catch (error) {
    if (error instanceof AppError && error.code === "TOOL_EXECUTION_ERROR") return undefined;
    throw error;
  }
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
  if (extension === ".pptx") return "pptx";
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
