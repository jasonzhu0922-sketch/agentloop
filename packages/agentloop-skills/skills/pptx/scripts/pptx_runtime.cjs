#!/usr/bin/env node

"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const PptxGenJS = require("pptxgenjs");

const SPEC_SCHEMA = "agentloop.pptxDeckSpec/v1";
const BUILD_RECEIPT_SCHEMA = "agentloop.pptxBuildReceipt/v1";
const INSPECTION_SCHEMA = "agentloop.pptxInspection/v1";
const API_CONTRACT = "agentloop.pptxGenJsApiContract/v1";
const LAYOUTS = new Map([
  ["16:9", "LAYOUT_16x9"],
  ["wide", "LAYOUT_WIDE"],
  ["4:3", "LAYOUT_4X3"],
  ["LAYOUT_16x9", "LAYOUT_16x9"],
  ["LAYOUT_WIDE", "LAYOUT_WIDE"],
  ["LAYOUT_4X3", "LAYOUT_4X3"],
]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action === "preflight" && args.length === 0) {
    writeJson(preflight());
    return;
  }
  if (action === "build" && args.length === 2) {
    writeJson(await buildDeck(args[0], args[1]));
    return;
  }
  if (action === "inspect" && args.length === 2) {
    writeJson(await inspectDeck(args[0], args[1]));
    return;
  }
  throw new Error("Usage: pptx_runtime.cjs preflight | build <absolute-spec.json> <absolute-output.pptx> | inspect <absolute-input.pptx> <absolute-report.json>");
}

function preflight() {
  const presentation = new PptxGenJS();
  const slide = presentation.addSlide();
  const requiredShapes = ["LINE", "OVAL", "RECTANGLE", "ROUNDED_RECTANGLE"];
  const requiredCharts = ["bar", "line", "pie"];
  const missing = [
    ...(typeof presentation.addSlide === "function" ? [] : ["presentation.addSlide"]),
    ...(typeof presentation.writeFile === "function" ? [] : ["presentation.writeFile"]),
    ...(typeof slide.addText === "function" ? [] : ["slide.addText"]),
    ...(typeof slide.addShape === "function" ? [] : ["slide.addShape"]),
    ...(typeof slide.addImage === "function" ? [] : ["slide.addImage"]),
    ...(typeof slide.addTable === "function" ? [] : ["slide.addTable"]),
    ...(typeof slide.addChart === "function" ? [] : ["slide.addChart"]),
    ...requiredShapes.filter((name) => typeof presentation.shapes?.[name] !== "string").map((name) => `presentation.shapes.${name}`),
    ...requiredCharts.filter((name) => typeof presentation.ChartType?.[name] !== "string").map((name) => `presentation.ChartType.${name}`),
  ];
  if (missing.length > 0) throw new Error(`Unsupported pptxgenjs API surface: ${missing.join(", ")}`);
  return {
    schema: API_CONTRACT,
    status: "ready",
    moduleFormat: "commonjs",
    scriptExtension: ".cjs",
    publicApi: {
      presentation: ["addSlide", "writeFile", "shapes", "ChartType"],
      slide: ["addText", "addShape", "addImage", "addTable", "addChart", "addNotes"],
      shapes: requiredShapes,
      charts: requiredCharts,
    },
    forbiddenPrivateApi: ["_shapeType", "_chartType", "_shapes"],
  };
}

async function buildDeck(specPath, outputPath) {
  requireAbsolutePath(specPath, "spec path");
  requireAbsolutePath(outputPath, "output path");
  if (path.extname(specPath).toLowerCase() !== ".json") throw new Error("Build spec must be a .json file");
  if (path.extname(outputPath).toLowerCase() !== ".pptx") throw new Error("Build output must use the .pptx extension");
  preflight();
  const spec = parseJsonFile(specPath);
  validateDeckSpec(spec);

  const presentation = new PptxGenJS();
  presentation.layout = LAYOUTS.get(spec.layout ?? "16:9");
  assignOptionalString(presentation, "author", spec.author);
  assignOptionalString(presentation, "company", spec.company);
  assignOptionalString(presentation, "subject", spec.subject);
  assignOptionalString(presentation, "title", spec.title);
  assignOptionalString(presentation, "lang", spec.lang);
  if (isPlainObject(spec.theme)) presentation.theme = cloneJsonValue(spec.theme);

  for (const [slideIndex, slideSpec] of spec.slides.entries()) {
    const slide = presentation.addSlide();
    if (slideSpec.background !== undefined) slide.background = { color: hexColor(slideSpec.background, `slides[${slideIndex}].background`) };
    if (slideSpec.hidden !== undefined) slide.hidden = Boolean(slideSpec.hidden);
    for (const [elementIndex, element] of slideSpec.elements.entries()) {
      addElement(presentation, slide, element, `slides[${slideIndex}].elements[${elementIndex}]`);
    }
    if (slideSpec.notes !== undefined) {
      const notes = Array.isArray(slideSpec.notes) ? slideSpec.notes : [slideSpec.notes];
      slide.addNotes(notes.map((note, noteIndex) => requiredString(note, `slides[${slideIndex}].notes[${noteIndex}]`)));
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await presentation.writeFile({ fileName: outputPath, compression: spec.compression !== false });
  const content = fs.readFileSync(outputPath);
  return {
    schema: BUILD_RECEIPT_SCHEMA,
    apiContract: API_CONTRACT,
    specSchema: SPEC_SCHEMA,
    moduleFormat: "commonjs",
    output: {
      path: outputPath,
      bytes: content.length,
      sha256: sha256(content),
      kind: "pptx",
      slideCount: spec.slides.length,
    },
  };
}

function addElement(presentation, slide, element, field) {
  requiredRecord(element, field);
  rejectUnsafeKeys(element, field);
  const options = requiredRecord(element.options, `${field}.options`);
  rejectUnsafeKeys(options, `${field}.options`);
  validateGeometry(options, `${field}.options`);
  switch (element.type) {
    case "text": {
      const text = element.text ?? element.runs;
      if (typeof text !== "string" && !Array.isArray(text)) throw new Error(`${field} requires text or runs`);
      slide.addText(cloneJsonValue(text), cloneJsonValue(options));
      return;
    }
    case "shape": {
      const shapeName = requiredString(element.shape, `${field}.shape`);
      const shape = presentation.shapes?.[shapeName];
      if (typeof shape !== "string") throw new Error(`${field}.shape must name a public presentation.shapes entry`);
      slide.addShape(shape, cloneJsonValue(options));
      return;
    }
    case "image":
      if (typeof options.path === "string") requireAbsolutePath(options.path, `${field}.options.path`);
      slide.addImage(cloneJsonValue(options));
      return;
    case "table": {
      if (!Array.isArray(element.rows) || element.rows.length === 0) throw new Error(`${field}.rows must be a non-empty array`);
      slide.addTable(cloneJsonValue(element.rows), cloneJsonValue(options));
      return;
    }
    case "chart": {
      const chartName = requiredString(element.chart, `${field}.chart`);
      const chartType = presentation.ChartType?.[chartName];
      if (typeof chartType !== "string") throw new Error(`${field}.chart must name a public presentation.ChartType entry`);
      if (!Array.isArray(element.data) || element.data.length === 0) throw new Error(`${field}.data must be a non-empty array`);
      slide.addChart(chartType, cloneJsonValue(element.data), cloneJsonValue(options));
      return;
    }
    default:
      throw new Error(`${field}.type must be text, shape, image, table, or chart`);
  }
}

async function inspectDeck(inputPath, reportPath) {
  requireAbsolutePath(inputPath, "input path");
  requireAbsolutePath(reportPath, "report path");
  if (path.extname(inputPath).toLowerCase() !== ".pptx") throw new Error("Inspection input must use the .pptx extension");
  if (path.extname(reportPath).toLowerCase() !== ".json") throw new Error("Inspection report must use the .json extension");
  const content = fs.readFileSync(inputPath);
  const archive = await JSZip.loadAsync(content);
  const names = Object.keys(archive.files);
  const slideNames = names
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort(naturalSlideOrder);
  const slides = [];
  for (const [index, name] of slideNames.entries()) {
    const xml = await archive.file(name).async("string");
    slides.push({
      number: index + 1,
      path: name,
      text: [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)].map((match) => decodeXml(match[1])).join("\n"),
    });
  }
  const report = {
    schema: INSPECTION_SCHEMA,
    apiContract: API_CONTRACT,
    artifact: {
      path: inputPath,
      bytes: content.length,
      sha256: sha256(content),
      kind: "pptx",
      slideCount: slideNames.length,
      mediaCount: names.filter((name) => name.startsWith("ppt/media/") && !name.endsWith("/")).length,
      requiredEntriesMissing: ["[Content_Types].xml", "ppt/presentation.xml"].filter((name) => archive.file(name) === null),
    },
    slides,
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function validateDeckSpec(spec) {
  requiredRecord(spec, "deck spec");
  rejectUnsafeKeys(spec, "deck spec");
  if (spec.schema !== SPEC_SCHEMA) throw new Error(`deck spec schema must be ${SPEC_SCHEMA}`);
  if (!LAYOUTS.has(spec.layout ?? "16:9")) throw new Error("deck spec layout is unsupported");
  if (!Array.isArray(spec.slides) || spec.slides.length === 0 || spec.slides.length > 200) {
    throw new Error("deck spec slides must contain 1-200 entries");
  }
  for (const [index, slide] of spec.slides.entries()) {
    requiredRecord(slide, `slides[${index}]`);
    rejectUnsafeKeys(slide, `slides[${index}]`);
    if (!Array.isArray(slide.elements)) throw new Error(`slides[${index}].elements must be an array`);
    if (slide.elements.length > 500) throw new Error(`slides[${index}].elements exceeds 500 entries`);
  }
}

function validateGeometry(options, field) {
  for (const key of ["x", "y", "w", "h"]) {
    if (options[key] !== undefined && (typeof options[key] !== "number" || !Number.isFinite(options[key]))) {
      throw new Error(`${field}.${key} must be a finite number`);
    }
  }
}

function parseJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read JSON ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requiredRecord(value, field) {
  if (!isPlainObject(value)) throw new Error(`${field} must be an object`);
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function assignOptionalString(target, field, value) {
  if (value !== undefined) target[field] = requiredString(value, field);
}

function requireAbsolutePath(value, field) {
  requiredString(value, field);
  if (!path.isAbsolute(value)) throw new Error(`${field} must be absolute`);
}

function hexColor(value, field) {
  const color = requiredString(value, field);
  if (!/^[0-9A-F]{6}$/u.test(color)) throw new Error(`${field} must be six uppercase hexadecimal digits without #`);
  return color;
}

function rejectUnsafeKeys(value, field) {
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key) || key.startsWith("_")) throw new Error(`${field}.${key} is not part of the public contract`);
    if (isPlainObject(nested)) rejectUnsafeKeys(nested, `${field}.${key}`);
    if (Array.isArray(nested)) nested.forEach((item, index) => {
      if (isPlainObject(item)) rejectUnsafeKeys(item, `${field}.${key}[${index}]`);
    });
  }
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function naturalSlideOrder(left, right) {
  return Number(left.match(/slide(\d+)\.xml$/u)?.[1] ?? 0) - Number(right.match(/slide(\d+)\.xml$/u)?.[1] ?? 0);
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
