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
    designIntentFamilies: Record<string, string>;
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
  assert.equal(schema.designIntentFamilies["technology-system"], "signal-field");
  assert.equal(schema.example.layoutFamily, "editorial-blocks");
  assert.doesNotMatch(JSON.stringify(schema.example), /数据资产管理中心|智能体平台/);
});

test("canvas-design enforces explicit design intent before an incompatible layout can render", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agentloop-canvas-design-intent-"));
  try {
    const technology = render(workspace, {
      output: "technology.png",
      title: "治理智能体发布",
      subtitle: "系统、数据与协同",
      movement: "System Signal",
      designIntent: "technology-system",
      compositionVariant: "cartographic",
      labels: ["感知", "推理", "协同"],
      visualMotifs: [{ kind: "orb", label: "智能体" }, { kind: "building", label: "产业" }],
      texture: 0,
      density: 0.55,
      seed: 910,
      canvas: { width: 900, height: 1200 },
    });
    assert.equal(technology.layoutFamily, "signal-field");
    assert.equal(technology.designIntent, "technology-system");

    const invalidPath = join(workspace, "invalid.json");
    writeFileSync(invalidPath, JSON.stringify({
      output: "invalid.png",
      title: "治理智能体发布",
      designIntent: "technology-system",
      layoutFamily: "monument-axis",
    }), "utf8");
    const invalid = spawnSync("python3", [RENDERER, invalidPath], { cwd: workspace, encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /technology-system requires layoutFamily=signal-field/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
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

test("canvas-design composition variants and visible motifs change a shared grammar", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agentloop-canvas-design-variants-"));
  try {
    const baseSpec = {
      title: "共同体纪念日",
      subtitle: "看得见的人与城市",
      movement: "Civic Memory",
      layoutFamily: "monument-axis",
      palette: {
        backgroundTop: "#5c0a14",
        backgroundBottom: "#a80f1e",
        primary: "#f0b429",
        secondary: "#d92332",
        tertiary: "#e8d9a0",
        text: "#fdf3e3",
        mutedText: "#c9a05c",
      },
      labels: ["公共生活", "共同记忆", "城市", "人群"],
      texture: 0,
      density: 0.55,
      seed: 1001,
      canvas: { width: 900, height: 1200 },
    };

    const radiant = render(workspace, {
      ...baseSpec,
      output: "radiant.png",
      compositionVariant: "radiant-spire",
      visualMotifs: [{ kind: "star", label: "纪念" }],
    });
    const procession = render(workspace, {
      ...baseSpec,
      output: "procession.png",
      compositionVariant: "procession",
      visualMotifs: [{ kind: "figure", label: "人群" }, { kind: "building", label: "城市" }],
    });

    assert.equal(radiant.compositionVariant, "radiant-spire");
    assert.equal(procession.compositionVariant, "procession");
    assert.deepEqual(procession.visualMotifs, [{ kind: "figure", label: "人群" }, { kind: "building", label: "城市" }]);
    assert.notEqual(sha256(join(workspace, "radiant.png")), sha256(join(workspace, "procession.png")));
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

test("canvas-design renderer accepts the documented low texture range", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agentloop-canvas-design-low-texture-"));
  try {
    const result = render(workspace, {
      output: "low-texture.png",
      title: "National Day",
      subtitle: "Public ceremony and shared memory",
      movement: "Monumental Festival",
      layoutFamily: "monument-axis",
      labels: ["1949", "2026", "77", "Celebration"],
      texture: 0.18,
      density: 0.58,
      seed: 77,
      canvas: { width: 900, height: 1200 },
    });

    assert.equal(result.layoutFamily, "monument-axis");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

type RenderReceipt = {
  layoutFamily: string;
  compositionVariant: string;
  visualMotifs: Array<{ kind: string; label: string }>;
  designIntent: string | null;
};

function render(workspace: string, spec: Record<string, unknown>): RenderReceipt {
  const specPath = join(workspace, `${spec.output}.json`);
  writeFileSync(specPath, JSON.stringify(spec), "utf8");
  const result = spawnSync("python3", [RENDERER, specPath], {
    cwd: workspace,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as RenderReceipt;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
