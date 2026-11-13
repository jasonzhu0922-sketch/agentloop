import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readSkillExecutionManifest } from "../src/skills/skill-execution-manifest.ts";

const executeFile = promisify(execFile);
const PPTX_SKILL_ROOT = resolve(import.meta.dirname, "..", "..", "agentloop-skills", "skills", "pptx");
const PPTX_RUNTIME = join(PPTX_SKILL_ROOT, "scripts", "pptx_runtime.cjs");

test("PPTX validation reports all defects and verifies the repaired object across reordering", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "pptx-repair-identity-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const specPath = join(workspace, "spec.json"), outputPath = join(workspace, "deck.pptx");
  const options = { x: 0.6, y: 1, w: 8, h: 1 };
  const firstTable: any = { id: "domain-table", type: "table", rows: [["domain"]], options: { ...options } };
  const brokenTable: any = { id: "levels-table", type: "table", rows: [["level"]], options: { ...options } };
  delete brokenTable.options.h;
  const decoration = { id: "cover-decoration", type: "shape", shape: "OVAL", options: { ...options, x: -1, y: 7 } };
  const spec: any = { schema: "agentloop.pptxDeckSpec/v1", layout: "wide",
    slides: [{ elements: [decoration, firstTable] }, { elements: [brokenTable] }] };
  const validate = async (name: string, previous?: string) => {
    await writeFile(specPath, JSON.stringify(spec));
    const reportPath = join(workspace, name);
    let stdout = "";
    try { stdout = (await executeFile(process.execPath, [PPTX_RUNTIME, "validate", specPath, reportPath, ...(previous ? [join(workspace, previous)] : [])])).stdout; }
    catch (error) { stdout = (error as { stdout: string }).stdout; }
    const report = JSON.parse(stdout);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), report);
    return report;
  };
  const initial = await validate("before.json");
  assert.equal(initial.valid, false);
  assert.equal(initial.diagnostics.length, 3);
  assert.ok(initial.diagnostics.some((issue: any) => issue.pointer === "/slides/1/elements/0/options/h"));
  await assert.rejects(() => executeFile(process.execPath, [PPTX_RUNTIME, "build", specPath, outputPath]), error => {
    const report = JSON.parse((error as { stdout: string }).stdout);
    assert.deepEqual(report.diagnostics, initial.diagnostics);
    assert.equal(report.source.sha256, initial.source.sha256);
    return true;
  });
  await assert.rejects(() => readFile(outputPath), { code: "ENOENT" });
  firstTable.options.h = 2; // Reproduce run 965666a9: the other table was edited.
  const wrongRepair = await validate("wrong.json", "before.json");
  assert.notEqual(wrongRepair.source.sha256, initial.source.sha256);
  assert.equal(wrongRepair.repairComparison.resolved.length, 0);
  assert.equal(wrongRepair.repairComparison.remaining.length, 3);
  brokenTable.options.h = 1;
  decoration.options.x = 0;
  decoration.options.y = 1;
  spec.slides.reverse(); // Array pointers change, object identity does not.
  const repaired = await validate("after.json", "before.json");
  assert.equal(repaired.valid, true);
  assert.equal(repaired.repairComparison.resolved.length, 3);
  assert.equal(repaired.repairComparison.remaining.length, 0);
  assert.equal(repaired.repairComparison.unverifiable.length, 0);
  const built = JSON.parse((await executeFile(process.execPath, [PPTX_RUNTIME, "build", specPath, outputPath])).stdout);
  assert.equal(built.source.sha256, repaired.source.sha256);
  assert.equal(built.output.slideCount, 2);
});

test("PPTX repair comparison never treats removed or ambiguous anonymous objects as fixed", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "pptx-repair-ambiguous-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const specPath = join(workspace, "spec.json"), beforePath = join(workspace, "before.json"), afterPath = join(workspace, "after.json");
  const element = { type: "shape", shape: "OVAL", options: { x: -1, y: 1, w: 1, h: 1 } };
  await writeFile(specPath, JSON.stringify({ schema: "agentloop.pptxDeckSpec/v1", layout: "wide", slides: [{ elements: [element, element] }] }));
  await assert.rejects(() => executeFile(process.execPath, [PPTX_RUNTIME, "validate", specPath, beforePath]));
  await writeFile(specPath, JSON.stringify({ schema: "agentloop.pptxDeckSpec/v1", layout: "wide", slides: [{ elements: [] }] }));
  const report = JSON.parse((await executeFile(process.execPath, [PPTX_RUNTIME, "validate", specPath, afterPath, beforePath])).stdout);
  assert.equal(report.valid, true, "The new spec is structurally valid, independent of repair identity");
  assert.equal(report.repairComparison.resolved.length, 0);
  assert.equal(report.repairComparison.unverifiable.length, 2);
});

test("PPTX executors publish deterministic native build, inspection, and unified-theme contracts", async () => {
  const entrypoints = await readSkillExecutionManifest(PPTX_SKILL_ROOT);
  assert.deepEqual(entrypoints.map((entrypoint) => entrypoint.id), ["native-pptx", "unified-theme"]);
  assert.deepEqual(entrypoints[0].actions.find(action => action.id === "assemble")?.args,
    ["assemble", "{{assembly-path}}", "{{spec-path}}", "{{report-path}}"]);
  assert.deepEqual({ ...entrypoints[0], actions: entrypoints[0].actions.filter(action => action.id !== "assemble") }, {
    id: "native-pptx",
    description: "Build and inspect editable PPTX files through a versioned package-owned pptxgenjs API contract instead of runtime API probing.",
    command: "node",
    script: "scripts/pptx_runtime.cjs",
    actions: [
      {
        id: "preflight",
        description: "Verify the installed pptxgenjs CommonJS module, public presentation and slide methods, and public shape and chart enumerations before building.",
        inputs: [],
        args: ["preflight"],
        result: "An agentloop.pptxGenJsApiContract/v1 readiness receipt.",
        producesEvidenceKinds: [],
      },
      {
        id: "validate",
        description: "Validate the whole deck spec and compare repaired objects with a previous version-bound report when supplied.",
        inputs: [
                {
                        name: "spec-path",
                        description: "Absolute workspace path of the agentloop.pptxDeckSpec/v1 JSON input.",
                        required: true
                },
                {
                        name: "report-path",
                        description: "Absolute workspace path for the full validation JSON report.",
                        required: true
                },
                {
                        name: "previous-report-path",
                        description: "Optional absolute workspace path of the previous validation report for repair comparison; omit this argument on first validation.",
                        required: false
                }
        ],
        args: [
                "validate",
                "{{spec-path}}",
                "{{report-path}}",
                "{{previous-report-path}}"
        ],
        result: "An agentloop.pptxSpecValidation/v1 report with source hash, all diagnostics, and resolved/remaining/introduced/unverifiable repair issues. Invalid specs exit nonzero after writing the report.",
        producesEvidenceKinds: []
},
      {
        id: "build",
        description: "Build an editable PPTX from an agentloop.pptxDeckSpec/v1 JSON document using only the package-owned public API adapter.",
        inputs: [
          { name: "spec-path", description: "Absolute workspace path of the agentloop.pptxDeckSpec/v1 JSON input.", required: true },
          { name: "output-path", description: "Absolute workspace path for the generated editable .pptx file.", required: true },
        ],
        args: ["build", "{{spec-path}}", "{{output-path}}"],
        result: "An agentloop.pptxBuildReceipt/v1 receipt with output path, byte size, SHA-256, slide count, and resolved canvas dimensions.",
        producesEvidenceKinds: [],
      },
      {
        id: "inspect",
        description: "Inspect a PPTX package and extract ordered slide text and structural facts without shell composition or markitdown argument guessing.",
        inputs: [
          { name: "input-path", description: "Absolute workspace path of the .pptx file to inspect.", required: true },
          { name: "report-path", description: "Absolute workspace path for the generated inspection JSON.", required: true },
        ],
        args: ["inspect", "{{input-path}}", "{{report-path}}"],
        result: "An agentloop.pptxInspection/v1 report with package facts and ordered slide text.",
        producesEvidenceKinds: [],
      },
    ],
  });
  assert.equal(entrypoints[1]?.id, "unified-theme");
});

test("PPTX assembly preserves ordered slide parts and never replaces a valid spec with a broken repair", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "pptx-assembly-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const manifestPath = join(workspace, "assembly.json"), specPath = join(workspace, "deck.json");
  const reportPath = join(workspace, "assembly-report.json"), outputPath = join(workspace, "deck.pptx");
  const slide = (number: number) => ({ notes: `来源与待确认 ${number}`, elements: [
    { id: `title-${number}`, type: "text", text: `培训第 ${number} 页`, options: { x: 0.5, y: 0.5, w: 11, h: 1 } },
  ] });
  const first = { schema: "agentloop.pptxSlidePart/v1", slides: Array.from({ length: 4 }, (_, i) => slide(i + 1)) };
  const second = { schema: "agentloop.pptxSlidePart/v1", slides: Array.from({ length: 19 }, (_, i) => slide(i + 5)) };
  await writeFile(join(workspace, "first.json"), JSON.stringify(first));
  await writeFile(join(workspace, "second.json"), JSON.stringify(second));
  const manifest = { schema: "agentloop.pptxAssembly/v1", deck: { schema: "agentloop.pptxDeckSpec/v1", layout: "wide", title: "培训" },
    parts: ["first.json", "second.json"] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const assemble = () => executeFile(process.execPath, [PPTX_RUNTIME, "assemble", manifestPath, specPath, reportPath]);
  const receipt = JSON.parse((await assemble()).stdout);
  assert.equal(receipt.output.written, true);
  assert.equal(receipt.output.slideCount, 23);
  assert.deepEqual(receipt.parts.map((part: any) => [part.firstSlide, part.slideCount]), [[1, 4], [5, 19]]);
  assert.match(receipt.parts[0].sha256, /^[a-f\d]{64}$/u);
  const validSpec = await readFile(specPath, "utf8");
  assert.deepEqual(JSON.parse(validSpec).slides, [...first.slides, ...second.slides]);
  await executeFile(process.execPath, [PPTX_RUNTIME, "build", specPath, outputPath]);
  const inspection = JSON.parse((await executeFile(process.execPath, [PPTX_RUNTIME, "inspect", outputPath, join(workspace, "inspect.json")])).stdout);
  assert.equal(inspection.slides.length, 23);
  assert.match(inspection.slides[22].text, /培训第 23 页/);

  second.slides[8]!.elements[0]!.options.h = -0.05;
  second.slides[15]!.elements[0]!.options.h = 0;
  await writeFile(join(workspace, "second.json"), JSON.stringify(second));
  await assert.rejects(assemble, (error: any) => {
    const failed = JSON.parse(error.stdout);
    assert.equal(failed.output.written, false);
    assert.equal(failed.validation.diagnostics.length, 2);
    assert.deepEqual(failed.validation.diagnostics.map((issue: any) => issue.objectKey), ["id:title-13", "id:title-20"]);
    return true;
  });
  assert.equal(await readFile(specPath, "utf8"), validSpec);
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).validation.valid, false);
  // Reproduce the Run's first bad boundary: appending slides after a closed root.
  await writeFile(join(workspace, "second.json"), `${JSON.stringify(second)}, {"slides":[]}`);
  await assert.rejects(assemble, /Invalid slide part second.json/);
  assert.equal(await readFile(specPath, "utf8"), validSpec);
});

test("PPTX assembly rejects duplicate, escaping, and overwritten inputs", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "pptx-assembly-boundary-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const manifestPath = join(workspace, "assembly.json"), partPath = join(workspace, "part.json");
  const part = JSON.stringify({ schema: "agentloop.pptxSlidePart/v1", slides: [{ elements: [] }] });
  await writeFile(partPath, part);
  const manifest = { schema: "agentloop.pptxAssembly/v1", deck: { schema: "agentloop.pptxDeckSpec/v1", layout: "wide" }, parts: ["part.json", "./part.json"] };
  const run = (output: string) => executeFile(process.execPath, [PPTX_RUNTIME, "assemble", manifestPath, output, join(workspace, "report.json")]);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(() => run(join(workspace, "spec.json")), /duplicates an assembly input/);
  manifest.parts = ["part.json"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(() => run(partPath), /must use distinct paths/);
  assert.equal(await readFile(partPath, "utf8"), part);
  manifest.parts = [partPath];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(() => run(join(workspace, "spec.json")), /must be relative/);
});

test("PPTX native runtime preflights, builds, and inspects a Unicode deck without API probing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agentloop-pptx-runtime-"));
  try {
    const preflight = JSON.parse((await executeFile(process.execPath, [PPTX_RUNTIME, "preflight"], { cwd: PPTX_SKILL_ROOT })).stdout);
    assert.equal(preflight.schema, "agentloop.pptxGenJsApiContract/v1");
    assert.equal(preflight.status, "ready");
    assert.equal(preflight.moduleFormat, "commonjs");
    assert.deepEqual(preflight.forbiddenPrivateApi, ["_shapeType", "_chartType", "_shapes"]);

    const specPath = join(workspace, "山猪祭墟-deck.json");
    const outputPath = join(workspace, "山猪祭墟-游戏介绍.pptx");
    const reportPath = join(workspace, "山猪祭墟-inspection.json");
    await writeFile(specPath, JSON.stringify({
      schema: "agentloop.pptxDeckSpec/v1",
      layout: "16:9",
      title: "山猪祭墟",
      slides: [
        {
          background: "2B1D1A",
          notes: "封面说明",
          elements: [
            { type: "shape", shape: "OVAL", options: { x: 7, y: 0.2, w: 2.5, h: 2.5, fill: { color: "8B3A2A", transparency: 70 } } },
            { type: "text", text: "山猪祭墟", options: { x: 0.8, y: 1.2, w: 7, h: 0.8, fontSize: 36, color: "FFFFFF", margin: 0 } },
          ],
        },
        {
          elements: [
            { type: "text", text: "五幕五地图 · 零随机", options: { x: 0.8, y: 0.6, w: 8, h: 0.6, fontSize: 24, color: "2B1D1A" } },
            { type: "shape", shape: "ROUNDED_RECTANGLE", options: { x: 0.8, y: 1.6, w: 3, h: 2, fill: { color: "EDE4DC" } } },
          ],
        },
      ],
    }));

    const build = JSON.parse((await executeFile(process.execPath, [PPTX_RUNTIME, "build", specPath, outputPath], { cwd: PPTX_SKILL_ROOT })).stdout);
    assert.equal(build.schema, "agentloop.pptxBuildReceipt/v1");
    assert.equal(build.output.path, outputPath);
    assert.equal(build.output.kind, "pptx");
    assert.equal(build.output.slideCount, 2);
    assert.deepEqual(build.output.canvas, { layout: "16:9", width: 10, height: 5.625 });
    assert.ok(build.output.bytes > 0);
    assert.match(build.output.sha256, /^[a-f\d]{64}$/u);

    const inspection = JSON.parse((await executeFile(process.execPath, [PPTX_RUNTIME, "inspect", outputPath, reportPath], { cwd: PPTX_SKILL_ROOT })).stdout);
    assert.equal(inspection.schema, "agentloop.pptxInspection/v1");
    assert.equal(inspection.artifact.slideCount, 2);
    assert.deepEqual(inspection.artifact.requiredEntriesMissing, []);
    assert.match(inspection.slides[0].text, /山猪祭墟/u);
    assert.match(inspection.slides[1].text, /五幕五地图 · 零随机/u);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), inspection);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("PPTX native runtime rejects private API fields and unknown public shape keys", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agentloop-pptx-runtime-invalid-"));
  try {
    const outputPath = join(workspace, "invalid.pptx");
    for (const [name, element, message] of [
      ["private.json", { type: "shape", shape: "OVAL", options: { x: 1, y: 1, w: 1, h: 1, _shapeType: "ellipse" } }, "not part of the public contract"],
      ["unknown.json", { type: "shape", shape: "oval", options: { x: 1, y: 1, w: 1, h: 1 } }, "public presentation.shapes entry"],
    ] as const) {
      const specPath = join(workspace, name);
      await writeFile(specPath, JSON.stringify({
        schema: "agentloop.pptxDeckSpec/v1",
        layout: "16:9",
        slides: [{ elements: [element] }],
      }));
      await assert.rejects(
        () => executeFile(process.execPath, [PPTX_RUNTIME, "build", specPath, outputPath], { cwd: PPTX_SKILL_ROOT }),
        (error: unknown) => error instanceof Error && error.message.includes(message),
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("PPTX native runtime requires an explicit canvas and rejects out-of-bounds geometry", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agentloop-pptx-runtime-geometry-"));
  try {
    const outputPath = join(workspace, "invalid.pptx");
    const cases = [
      {
        name: "missing-layout.json",
        spec: { schema: "agentloop.pptxDeckSpec/v1", slides: [{ elements: [{ type: "text", text: "x", options: { x: 0, y: 0, w: 1, h: 1 } }] }] },
        message: "layout is required",
      },
      {
        name: "wide-coordinate-on-16x9.json",
        spec: { schema: "agentloop.pptxDeckSpec/v1", layout: "16:9", slides: [{ elements: [{ type: "shape", shape: "RECTANGLE", options: { x: 10.1, y: 1, w: 1, h: 1 } }] }] },
        message: "outside the 16:9 canvas",
      },
      {
        name: "negative-coordinate.json",
        spec: { schema: "agentloop.pptxDeckSpec/v1", layout: "wide", slides: [{ elements: [{ type: "shape", shape: "OVAL", options: { x: -0.01, y: 1, w: 1, h: 1 } }] }] },
        message: "outside the wide canvas",
      },
    ] as const;
    for (const testCase of cases) {
      const specPath = join(workspace, testCase.name);
      await writeFile(specPath, JSON.stringify(testCase.spec));
      await assert.rejects(
        () => executeFile(process.execPath, [PPTX_RUNTIME, "build", specPath, outputPath], { cwd: PPTX_SKILL_ROOT }),
        (error: unknown) => error instanceof Error && error.message.includes(testCase.message),
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("PPTX native runtime preserves the 13.333 x 7.5 inch wide canvas", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agentloop-pptx-runtime-wide-"));
  try {
    const specPath = join(workspace, "wide.json");
    const outputPath = join(workspace, "wide.pptx");
    await writeFile(specPath, JSON.stringify({
      schema: "agentloop.pptxDeckSpec/v1",
      layout: "wide",
      slides: [{ elements: [{ type: "shape", shape: "RECTANGLE", options: { x: 0, y: 0, w: 13.333333333333334, h: 7.5 } }] }],
    }));
    const build = JSON.parse((await executeFile(process.execPath, [PPTX_RUNTIME, "build", specPath, outputPath], { cwd: PPTX_SKILL_ROOT })).stdout);
    assert.equal(build.output.canvas.layout, "wide");
    assert.equal(build.output.canvas.width, 13.333333333333334);
    assert.equal(build.output.canvas.height, 7.5);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
