import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const RENDERER = resolve(PACKAGE_ROOT, "skills", "canvas-design", "scripts", "render_static_canvas.py");

test("canvas-design renderer exposes layout families without domain-specific example leakage", () => {
  const result = spawnSync("python3", [RENDERER, "--schema"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const schema = JSON.parse(result.stdout) as {
    fields: Record<string, unknown>;
    layoutFamilies: string[];
    example: { title: string; layoutFamily: string };
  };
  assert.deepEqual(schema.layoutFamilies, [
    "signal-field",
    "monument-axis",
    "editorial-blocks",
    "kinetic-ribbons",
    "emblem-grid",
  ]);
  assert.equal(typeof schema.fields.layoutFamily, "string");
  assert.equal(schema.example.layoutFamily, "editorial-blocks");
  assert.doesNotMatch(JSON.stringify(schema.example), /数据资产管理中心|智能体平台/);
});

test("canvas-design layoutFamily changes composition, not just copy or color", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agentloop-canvas-design-"));
  try {
    const baseSpec = {
      title: "Public Systems Forum",
      subtitle: "Evidence, design, and shared infrastructure",
      movement: "Civic Pulse",
      palette: {
        backgroundTop: "#101820",
        backgroundBottom: "#f2efe6",
        primary: "#1d4e89",
        secondary: "#e76f51",
        tertiary: "#2a9d8f",
        text: "#111827",
        mutedText: "#52616b",
      },
      labels: ["Opening", "Field Notes", "Policy", "Studio", "Prototype", "Review"],
      texture: 0.0,
      density: 0.55,
      seed: 714,
      canvas: { width: 900, height: 1200 },
    };

    const first = render(workspace, { ...baseSpec, output: "monument.png", layoutFamily: "monument-axis" });
    const second = render(workspace, { ...baseSpec, output: "blocks.png", layoutFamily: "editorial-blocks" });

    assert.equal(first.layoutFamily, "monument-axis");
    assert.equal(second.layoutFamily, "editorial-blocks");
    assert.notEqual(sha256(join(workspace, "monument.png")), sha256(join(workspace, "blocks.png")));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("canvas-design renderer chooses a non-singleton layout when layoutFamily is omitted", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agentloop-canvas-design-auto-"));
  try {
    const memorial = render(workspace, {
      output: "memorial.png",
      title: "Victory Memorial Anniversary",
      subtitle: "Memory, history, and public ceremony",
      movement: "Eternal Dawn",
      labels: ["1945", "Peace", "History", "Commemoration"],
      seed: 81,
      canvas: { width: 900, height: 1200 },
    });
    const campaign = render(workspace, {
      output: "campaign.png",
      title: "Festival Launch Campaign",
      subtitle: "Movement, gathering, and public energy",
      movement: "Civic Motion",
      labels: ["Opening", "Live", "Studio", "Program"],
      seed: 81,
      canvas: { width: 900, height: 1200 },
    });

    assert.equal(memorial.layoutFamily, "monument-axis");
    assert.equal(campaign.layoutFamily, "kinetic-ribbons");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function render(workspace: string, spec: Record<string, unknown>): { layoutFamily: string } {
  const specPath = join(workspace, `${spec.layoutFamily}.json`);
  writeFileSync(specPath, JSON.stringify(spec), "utf8");
  const result = spawnSync("python3", [RENDERER, specPath], {
    cwd: workspace,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { layoutFamily: string };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
