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

test("PPTX executors publish deterministic native build, inspection, and unified-theme contracts", async () => {
  const entrypoints = await readSkillExecutionManifest(PPTX_SKILL_ROOT);
  assert.deepEqual(entrypoints.map((entrypoint) => entrypoint.id), ["native-pptx", "unified-theme"]);
  assert.deepEqual(entrypoints[0], {
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
