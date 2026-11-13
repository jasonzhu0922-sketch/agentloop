#!/usr/bin/env node

"use strict";

const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const PptxGenJS = require("pptxgenjs");

const SPEC_SCHEMA = "agentloop.pptxDeckSpec/v1";
const BUILD_RECEIPT_SCHEMA = "agentloop.pptxBuildReceipt/v1";
const VALIDATION_SCHEMA = "agentloop.pptxSpecValidation/v1";
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
const CANVASES = new Map([
  ["16:9", { name: "16:9", pptxLayout: "LAYOUT_16x9", width: 10, height: 5.625 }],
  ["wide", { name: "wide", pptxLayout: "LAYOUT_WIDE", width: 13.333333333333334, height: 7.5 }],
  ["4:3", { name: "4:3", pptxLayout: "LAYOUT_4X3", width: 10, height: 7.5 }],
  ["LAYOUT_16x9", { name: "16:9", pptxLayout: "LAYOUT_16x9", width: 10, height: 5.625 }],
  ["LAYOUT_WIDE", { name: "wide", pptxLayout: "LAYOUT_WIDE", width: 13.333333333333334, height: 7.5 }],
  ["LAYOUT_4X3", { name: "4:3", pptxLayout: "LAYOUT_4X3", width: 10, height: 7.5 }],
]);
const GEOMETRY_EPSILON = 1e-6;
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
  if (action === "validate" && (args.length === 2 || args.length === 3)) {
    const report = validateSpecFile(args[0], args[1], args[2]);
    writeJson(report);
    if (!report.valid) process.exitCode = 1;
    return;
  }
  if (action === "assemble" && args.length === 3) {
    const receipt = assembleDeck(args[0], args[1], args[2]);
    writeJson(receipt);
    if (!receipt.validation.valid) process.exitCode = 1;
    return;
  }
  if (action === "inspect" && args.length === 2) {
    writeJson(await inspectDeck(args[0], args[1]));
    return;
  }
  throw new Error("Usage: pptx_runtime.cjs preflight | assemble <absolute-assembly.json> <absolute-spec.json> <absolute-report.json> | build <absolute-spec.json> <absolute-output.pptx> | validate <absolute-spec.json> <absolute-report.json> [<absolute-previous-report.json>] | inspect <absolute-input.pptx> <absolute-report.json>");
}

/** Parts are complete JSON documents; only this adapter serializes the merged deck. */
function assembleDeck(manifestPath, specPath, reportPath) {
  for (const [value, label] of [[manifestPath, "assembly path"], [specPath, "spec path"], [reportPath, "report path"]]) requireAbsolutePath(value, label);
  const manifestContent = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestContent.toString("utf8"));
  requiredRecord(manifest, "assembly");
  if (manifest.schema !== "agentloop.pptxAssembly/v1") throw new Error("assembly schema must be agentloop.pptxAssembly/v1");
  requiredRecord(manifest.deck, "assembly.deck");
  if (Object.hasOwn(manifest.deck, "slides")) throw new Error("assembly.deck must omit slides; declare ordered parts instead");
  if (!Array.isArray(manifest.parts) || manifest.parts.length < 1 || manifest.parts.length > 200) throw new Error("assembly.parts must contain 1-200 relative JSON paths");
  const root = fs.realpathSync(path.dirname(manifestPath));
  const sources = [], slides = [], seen = new Set([fs.realpathSync(manifestPath)]);
  for (const [index, relative] of manifest.parts.entries()) {
    requiredString(relative, `parts[${index}]`);
    if (path.isAbsolute(relative)) throw new Error(`parts[${index}] must be relative to the assembly file`);
    const resolved = fs.realpathSync(path.resolve(root, relative));
    const within = path.relative(root, resolved);
    if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw new Error(`parts[${index}] escapes the assembly directory`);
    if (seen.has(resolved)) throw new Error(`parts[${index}] duplicates an assembly input`);
    seen.add(resolved);
    const content = fs.readFileSync(resolved);
    let part;
    try { part = JSON.parse(content.toString("utf8")); }
    catch (error) { throw new Error(`Invalid slide part ${relative}: ${error.message}; rewrite this part as one complete JSON document`); }
    if (part?.schema !== "agentloop.pptxSlidePart/v1" || !Array.isArray(part.slides) || part.slides.length < 1) throw new Error(`Slide part ${relative} must be agentloop.pptxSlidePart/v1 with a nonempty slides array`);
    if (slides.length + part.slides.length > 200) throw new Error("Assembled deck exceeds 200 slides");
    sources.push({ path: resolved, sha256: sha256(content), bytes: content.length, firstSlide: slides.length + 1, slideCount: part.slides.length });
    slides.push(...part.slides);
  }
  const outputIdentity = value => fs.existsSync(value) ? fs.realpathSync(value) : path.resolve(value);
  if (seen.has(outputIdentity(specPath)) || seen.has(outputIdentity(reportPath)) || outputIdentity(specPath) === outputIdentity(reportPath)) throw new Error("Assembly inputs, spec, and report must use distinct paths");
  const spec = { ...manifest.deck, slides };
  const content = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
  const validation = validateSpec(spec, specPath, content);
  const receipt = { schema: "agentloop.pptxAssemblyReceipt/v1", manifest: { path: manifestPath, sha256: sha256(manifestContent), bytes: manifestContent.length },
    parts: sources, output: { ...validation.source, slideCount: slides.length, written: validation.valid }, validation };
  // Invalid parts never replace the last valid assembled spec. No repair, clamping, or content dropping.
  if (validation.valid) writeJsonAtomic(specPath, content);
  writeJsonAtomic(reportPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`));
  return receipt;
}

function writeJsonAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, content, { flag: "wx" }); fs.renameSync(temporary, filePath); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
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
  const specContent = fs.readFileSync(specPath);
  const spec = JSON.parse(specContent.toString("utf8"));
  const validation = validateSpec(spec, specPath, specContent);
  if (!validation.valid) {
    writeJson(validation);
    throw new Error(`PPTX spec validation failed (${validation.diagnostics.length} issues): ${validation.diagnostics.slice(0, 8).map(item => item.message).join("; ")}. Full diagnostics are in the stdout report.`);
  }
  const canvas = CANVASES.get(spec.layout);

  const presentation = new PptxGenJS();
  presentation.layout = canvas.pptxLayout;
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
      addElement(presentation, slide, element, `slides[${slideIndex}].elements[${elementIndex}]`, canvas);
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
    source: validation.source,
    moduleFormat: "commonjs",
    output: {
      path: outputPath,
      bytes: content.length,
      sha256: sha256(content),
      kind: "pptx",
      slideCount: spec.slides.length,
      canvas: { layout: canvas.name, width: canvas.width, height: canvas.height },
    },
  };
}

function addElement(presentation, slide, element, field, canvas) {
  validateGeometry(element.options, `${field}.options`, canvas);
  const { method, args } = elementArguments(presentation, element, field);
  slide[method](...args.map(cloneJsonValue));
}

// Both the full-spec validator and the renderer use these exact content rules.
function elementArguments(presentation, element, field) {
  requiredRecord(element, field);
  rejectUnsafeKeys(element, field);
  const options = requiredRecord(element.options, `${field}.options`);
  switch (element.type) {
    case "text": {
      const text = element.text ?? element.runs;
      if (typeof text !== "string" && !Array.isArray(text)) throw new Error(`${field} requires text or runs`);
      return { method: "addText", args: [text, options] };
    }
    case "shape": {
      const shape = presentation.shapes?.[requiredString(element.shape, `${field}.shape`)];
      if (typeof shape !== "string") throw new Error(`${field}.shape must name a public presentation.shapes entry`);
      return { method: "addShape", args: [shape, options] };
    }
    case "image":
      if (typeof options.path === "string") requireAbsolutePath(options.path, `${field}.options.path`);
      return { method: "addImage", args: [options] };
    case "table":
      if (!Array.isArray(element.rows) || element.rows.length === 0) throw new Error(`${field}.rows must be a non-empty array`);
      return { method: "addTable", args: [element.rows, options] };
    case "chart": {
      const chart = presentation.ChartType?.[requiredString(element.chart, `${field}.chart`)];
      if (typeof chart !== "string") throw new Error(`${field}.chart must name a public presentation.ChartType entry`);
      if (!Array.isArray(element.data) || element.data.length === 0) throw new Error(`${field}.data must be a non-empty array`);
      return { method: "addChart", args: [chart, element.data, options] };
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
  rejectUnsafeKeys(Object.fromEntries(Object.entries(spec).filter(([key]) => key !== "slides")), "deck spec");
  if (spec.schema !== SPEC_SCHEMA) throw new Error(`deck spec schema must be ${SPEC_SCHEMA}`);
  if (typeof spec.layout !== "string" || spec.layout.trim().length === 0) {
    throw new Error('deck spec layout is required; choose "16:9", "wide", or "4:3" explicitly');
  }
  if (!CANVASES.has(spec.layout) || !LAYOUTS.has(spec.layout)) throw new Error("deck spec layout is unsupported");
  if (!Array.isArray(spec.slides) || spec.slides.length === 0 || spec.slides.length > 200) {
    throw new Error("deck spec slides must contain 1-200 entries");
  }
  return CANVASES.get(spec.layout);
}

function geometryDiagnostics(options, field, canvas) {
  if (!isPlainObject(options)) return [{ code: "invalid_options", field: "", actual: options ?? null, message: `${field} must be an object` }];
  const issues = [];
  for (const key of ["x", "y", "w", "h"]) {
    if (typeof options[key] !== "number" || !Number.isFinite(options[key])) {
      issues.push({ code: "non_finite_geometry", field: key, actual: options[key] ?? null, constraint: "finite number", message: `${field}.${key} must be a finite number` });
    } else if ((key === "w" || key === "h") && options[key] <= 0) {
      issues.push({ code: "non_positive_size", field: key, actual: options[key], constraint: "> 0", message: `${field}.${key} must be greater than zero` });
    }
  }
  if (canvas !== undefined) {
    for (const [position, size, maximum] of [["x", "w", canvas.width], ["y", "h", canvas.height]]) {
      if (!Number.isFinite(options[position])) continue;
      if (options[position] < -GEOMETRY_EPSILON || (Number.isFinite(options[size]) && options[position] + options[size] > maximum + GEOMETRY_EPSILON)) {
        issues.push({ code: "out_of_canvas", field: position, actual: { position: options[position], size: options[size] ?? null }, constraint: { minimum: 0, maximum }, message: `${field} is outside the ${canvas.name} canvas (${canvas.width} x ${canvas.height} in); check ${position}/${size}` });
      }
    }
  }
  return issues;
}

function validateGeometry(options, field, canvas) {
  const issues = geometryDiagnostics(options, field, canvas);
  if (issues.length > 0) throw new Error(issues.map(item => item.message).join("; "));
}

function objectKey(element) {
  if (typeof element?.id === "string" && element.id.trim()) return `id:${element.id}`;
  // A geometry edit preserves identity; identical anonymous objects remain
  // ambiguous rather than being matched by a potentially shifted array index.
  const content = isPlainObject(element) ? { ...element, options: isPlainObject(element.options)
    ? Object.fromEntries(Object.entries(element.options).filter(([key]) => !["x", "y", "w", "h"].includes(key))) : element.options } : element;
  return `content:${sha256(JSON.stringify(content))}`;
}

function validateSpec(spec, specPath, content) {
  const diagnostics = [], objects = [];
  let canvas;
  const problem = (pointer, message, extra = {}) => diagnostics.push({ code: "invalid_spec", pointer, message, ...extra });
  try { canvas = validateDeckSpec(spec); } catch (error) { problem("", error.message); }
  const presentation = new PptxGenJS();
  if (Array.isArray(spec?.slides) && spec.slides.length <= 200) {
    for (const [si, slide] of spec.slides.entries()) {
      const pointer = `/slides/${si}`;
      if (!isPlainObject(slide)) { problem(pointer, `slides[${si}] must be an object`); continue; }
      try {
        rejectUnsafeKeys(Object.fromEntries(Object.entries(slide).filter(([key]) => key !== "elements")), `slides[${si}]`);
        if (slide.background !== undefined) hexColor(slide.background, `slides[${si}].background`);
        if (slide.notes !== undefined) (Array.isArray(slide.notes) ? slide.notes : [slide.notes]).forEach((note, ni) => requiredString(note, `slides[${si}].notes[${ni}]`));
      } catch (error) { problem(pointer, error.message); }
      if (!Array.isArray(slide.elements) || slide.elements.length > 500) { problem(`${pointer}/elements`, `slides[${si}].elements must be an array of at most 500 entries`); continue; }
      for (const [ei, element] of slide.elements.entries()) {
        const ep = `${pointer}/elements/${ei}`, key = objectKey(element), field = `slides[${si}].elements[${ei}]`;
        objects.push({ key, pointer: ep });
        const geometry = geometryDiagnostics(element?.options, `${field}.options`, canvas);
        diagnostics.push(...geometry.map(issue => ({ ...issue, pointer: `${ep}/options${issue.field ? `/${issue.field}` : ""}`, objectKey: key })));
        try { elementArguments(presentation, element, field); } catch (error) { problem(ep, error.message, { objectKey: key }); }
      }
    }
  }
  return { schema: VALIDATION_SCHEMA, source: { path: specPath, sha256: sha256(content), bytes: content.length },
    valid: diagnostics.length === 0, diagnostics, objects };
}

function compareValidation(previous, current) {
  if (previous.schema !== VALIDATION_SCHEMA || !Array.isArray(previous.objects) || !Array.isArray(previous.diagnostics)
    || typeof previous.source?.sha256 !== "string") throw new Error("Previous report must be a version-bound PPTX spec validation report");
  const count = (report, key) => report.objects.filter(object => object.key === key).length;
  const identity = issue => `${issue.objectKey}|${issue.code}|${issue.field ?? ""}`;
  const resolved = [], remaining = [], unverifiable = [];
  for (const issue of previous.diagnostics) {
    const unique = issue.objectKey !== undefined && count(previous, issue.objectKey) === 1 && count(current, issue.objectKey) === 1;
    if (!unique) { unverifiable.push({ ...issue, reason: "object_missing_or_ambiguous; array indices alone do not establish identity" }); continue; }
    if (current.diagnostics.some(next => identity(next) === identity(issue))) remaining.push(issue);
    else resolved.push(issue);
  }
  const introduced = current.diagnostics.filter(issue => !previous.diagnostics.some(old => identity(old) === identity(issue)));
  return { previousSource: previous.source, currentSource: current.source, resolved, remaining, introduced, unverifiable };
}

function validateSpecFile(specPath, reportPath, previousPath) {
  requireAbsolutePath(specPath, "spec path"); requireAbsolutePath(reportPath, "report path");
  if (previousPath !== undefined) requireAbsolutePath(previousPath, "previous report path");
  if (specPath === reportPath || specPath === previousPath || reportPath === previousPath) throw new Error("Spec, report, and previous report must use distinct paths");
  const content = fs.readFileSync(specPath);
  const report = validateSpec(JSON.parse(content.toString("utf8")), specPath, content);
  if (previousPath !== undefined) report.repairComparison = compareValidation(parseJsonFile(previousPath), report);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
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
