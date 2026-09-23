#!/usr/bin/env node
/*
 * Build a bounded DOCX report from a JSON spec.
 *
 * The model owns report content; this Skill-owned builder owns docx-js layout
 * invariants so every run does not have to rediscover them in a custom script.
 */
const { createHash } = require("node:crypto");
const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} = require("docx");

const PAGE_WIDTH_DXA = 10_466; // A4 content width with 0.5in margins.
const MAX_COLUMNS = 20;
const MAX_ROWS = 500;
const MAX_TEXT = 1_000_000;

async function main() {
  const [specPath, outputArg] = process.argv.slice(2);
  if (!specPath) throw new Error("Usage: node build_report.cjs <spec.json> [output.docx]");
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  validateSpec(spec);
  const outputPath = outputArg || spec.outputPath;
  if (typeof outputPath !== "string" || !outputPath.trim()) {
    throw new Error("Spec must provide outputPath or a second output path argument");
  }

  const document = new Document({
    numbering: {
      config: [{ reference: "docx-skill-bullets", levels: [{ level: 0, format: "bullet", text: "•", alignment: AlignmentType.LEFT }] }],
    },
    sections: [{
      properties: {
        page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } },
      },
      children: buildChildren(spec),
    }],
  });
  const buffer = await Packer.toBuffer(document);
  await writeFile(outputPath, buffer);
  process.stdout.write(JSON.stringify({
    schema: "agentloop.docxBuild/v1",
    outputPath: path.resolve(outputPath),
    bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sections: spec.sections.length,
    tables: spec.sections.reduce((count, section) => count + (section.tables || []).length, 0),
  }) + "\n");
}

function validateSpec(spec) {
  if (!isRecord(spec) || spec.schema !== "agentloop.docxReportSpec/v1") {
    throw new Error("Spec schema must be agentloop.docxReportSpec/v1");
  }
  if (!Array.isArray(spec.sections) || spec.sections.length === 0 || spec.sections.length > 100) {
    throw new Error("Spec sections must contain 1 to 100 sections");
  }
  let characters = 0;
  for (const [sectionIndex, section] of spec.sections.entries()) {
    if (!isRecord(section)) throw new Error(`sections[${sectionIndex}] must be an object`);
    if (section.tables !== undefined && !Array.isArray(section.tables)) throw new Error(`sections[${sectionIndex}].tables must be an array`);
    for (const [tableIndex, table] of (section.tables || []).entries()) {
      if (!isRecord(table) || !Array.isArray(table.columns) || table.columns.length === 0 || table.columns.length > MAX_COLUMNS) {
        throw new Error(`sections[${sectionIndex}].tables[${tableIndex}] must define 1 to ${MAX_COLUMNS} columns`);
      }
      if (!Array.isArray(table.rows) || table.rows.length > MAX_ROWS) throw new Error(`sections[${sectionIndex}].tables[${tableIndex}].rows must contain at most ${MAX_ROWS} rows`);
      const widths = table.columns.map((column) => isRecord(column) ? column.width : undefined).filter((width) => width !== undefined);
      if (widths.length !== 0 && widths.length !== table.columns.length) throw new Error(`sections[${sectionIndex}].tables[${tableIndex}] must provide widths for every column or none`);
      if (widths.some((width) => !Number.isFinite(width) || width <= 0)) throw new Error(`sections[${sectionIndex}].tables[${tableIndex}] has invalid column width`);
      for (const row of table.rows) {
        if (!Array.isArray(row) || row.length !== table.columns.length) throw new Error(`sections[${sectionIndex}].tables[${tableIndex}] row width does not match columns`);
      }
    }
    characters += JSON.stringify(section).length;
  }
  if (characters > MAX_TEXT) throw new Error(`Spec exceeds ${MAX_TEXT} characters`);
}

function buildChildren(spec) {
  const children = [];
  if (typeof spec.title === "string" && spec.title.trim()) children.push(new Paragraph({ text: spec.title, heading: HeadingLevel.TITLE }));
  if (typeof spec.subtitle === "string" && spec.subtitle.trim()) children.push(new Paragraph({ children: [new TextRun({ text: spec.subtitle, italics: true })] }));
  for (const section of spec.sections) {
    if (typeof section.heading === "string" && section.heading.trim()) children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
    for (const paragraph of section.paragraphs || []) children.push(new Paragraph({ children: [new TextRun(String(paragraph))] }));
    for (const bullet of section.bullets || []) children.push(new Paragraph({ numbering: { reference: "docx-skill-bullets", level: 0 }, children: [new TextRun(String(bullet))] }));
    for (const table of section.tables || []) children.push(buildTable(table));
  }
  return children;
}

function buildTable(table) {
  const widths = normalizeWidths(table.columns.map((column) => isRecord(column) ? column.width : undefined));
  const headerCells = table.columns.map((column, index) => cell(isRecord(column) ? column.header : column, widths[index], true));
  const rows = [new TableRow({ children: headerCells })];
  for (const row of table.rows) rows.push(new TableRow({ children: row.map((value, index) => cell(value, widths[index], false)) }));
  return new Table({
    width: { size: PAGE_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: widths,
    rows,
    borders: {
      top: border(), bottom: border(), left: border(), right: border(), insideHorizontal: border(), insideVertical: border(),
    },
  });
}

function cell(value, width, header) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: header ? { type: ShadingType.CLEAR, fill: "D9EAF7" } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: String(value ?? ""), bold: header })] })],
  });
}

function normalizeWidths(widths) {
  if (widths.every((width) => width === undefined)) return equalWidths(widths.length);
  const sum = widths.reduce((total, width) => total + width, 0);
  if (Math.abs(sum - PAGE_WIDTH_DXA) < 0.5) return widths.map((width) => Math.round(width));
  if (sum <= 1.0001) return widths.map((width) => Math.round(width * PAGE_WIDTH_DXA));
  if (sum <= 100.0001) return widths.map((width) => Math.round(width / 100 * PAGE_WIDTH_DXA));
  throw new Error(`Column widths must sum to ${PAGE_WIDTH_DXA} DXA, 1.0, or 100`);
}

function equalWidths(count) {
  const base = Math.floor(PAGE_WIDTH_DXA / count);
  return Array.from({ length: count }, (_, index) => base + (index < PAGE_WIDTH_DXA % count ? 1 : 0));
}

function border() {
  return { style: BorderStyle.SINGLE, size: 1, color: "B7C9D6" };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

main().catch((error) => {
  process.stderr.write(`DOCX_BUILD_ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
