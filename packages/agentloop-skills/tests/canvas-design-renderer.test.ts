import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const RENDERER = resolve(PACKAGE_ROOT, "skills", "canvas-design", "scripts", "render_static_canvas.py");
const SKILL = resolve(PACKAGE_ROOT, "skills", "canvas-design", "SKILL.md");

const NETWORK_DIRECTION = {
  concept: "Shared services appear as a constellation of accountable signals",
  emotionalRegister: "restrained",
  materialLanguage: "luminous-glass",
  compositionTopology: "networked-field",
  typographicVoice: "quiet-technical",
  colorStrategy: "nocturne-electric",
  imageMode: "abstract-system",
  avoid: ["commemorative monument"],
};

const EDITORIAL_DIRECTION = {
  concept: "Digital services appear as public notices gathered across a city",
  emotionalRegister: "humanist",
  materialLanguage: "ink-paper",
  compositionTopology: "modular-editorial",
  typographicVoice: "editorial-contrast",
  colorStrategy: "warm-editorial",
  imageMode: "collaged-fragments",
  avoid: ["dark network field", "glowing central orb"],
};

test("canvas-design renderer exposes layout families without domain-specific example leakage", () => {
  const result = spawnSync("python3", [RENDERER, "--schema"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const schema = JSON.parse(result.stdout) as {
    schema: string;
    fields: Record<string, unknown>;
    layoutFamilies: string[];
    designIntents: string[];
    artDirectionValues: Record<string, string[]>;
    compositionTopologyFamilies: Record<string, string>;
    example: { title: string; layoutFamily: string };
  };
  assert.equal(schema.schema, "agentloop.canvasDesignSpec/v2");
  assert.deepEqual(schema.layoutFamilies, [
    "signal-field",
    "monument-axis",
    "editorial-blocks",
    "kinetic-ribbons",
    "emblem-grid",
  ]);
  assert.equal(typeof schema.fields.layoutFamily, "string");
  assert.ok(schema.designIntents.includes("technology-system"));
  assert.equal(schema.compositionTopologyFamilies["modular-editorial"], "editorial-blocks");
  assert.ok(schema.artDirectionValues.materialLanguage.includes("ink-paper"));
  assert.equal(schema.example.layoutFamily, "editorial-blocks");
  assert.equal((schema.example as { artDirection?: { compositionTopology?: string } }).artDirection?.compositionTopology, "modular-editorial");
  assert.doesNotMatch(JSON.stringify(schema.example), /数据资产管理中心|智能体平台/);

  const compactedPreview = result.stdout.slice(0, 2_000);
  assert.match(compactedPreview, /"artDirectionValues"/u);
  assert.match(compactedPreview, /"polished-metal"/u);
  assert.match(compactedPreview, /"radiant-spire"/u);
});

test("canvas-design treats category and mood-only briefs as unresolved visual direction", () => {
  const skill = readFileSync(SKILL, "utf8");
  assert.match(skill, /Sector, audience, purpose, topic, event type, and mood adjectives never satisfy this bypass by themselves\./u);
  assert.match(skill, /This is a stop gate: do not write the philosophy, create the spec, render the artwork, or call an artifact-writing tool before the HIL response\./u);
  assert.match(skill, /an enterprise technology launch and asks for a solemn, grand, technological tone must present three directions through HIL/u);
  assert.doesNotMatch(skill, /one candidate has substantially stronger subject or audience evidence/u);
});

test("canvas-design keeps subject intent independent from visual form", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agentloop-canvas-design-intent-"));
  try {
    const technology = render(workspace, {
      output: "technology.png",
      title: "治理智能体发布",
      subtitle: "系统、数据与协同",
      movement: "System Signal",
      designIntent: "technology-system",
      artDirection: NETWORK_DIRECTION,
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

    const editorialTechnology = render(workspace, {
      output: "editorial-technology.png",
      title: "治理智能体发布",
      subtitle: "系统、数据与协同",
      movement: "Public Patchwork",
      designIntent: "technology-system",
      artDirection: EDITORIAL_DIRECTION,
      compositionVariant: "split-spread",
      labels: ["感知", "推理", "协同"],
      texture: 0,
      density: 0.55,
      seed: 910,
      canvas: { width: 900, height: 1200 },
    });
    assert.equal(editorialTechnology.layoutFamily, "editorial-blocks");
    assert.equal(editorialTechnology.designIntent, "technology-system");
    assert.notEqual(editorialTechnology.artDirectionFingerprint, technology.artDirectionFingerprint);

    const invalidPath = join(workspace, "invalid.json");
    writeFileSync(invalidPath, JSON.stringify({
      output: "invalid.png",
      title: "治理智能体发布",
      designIntent: "technology-system",
      artDirection: EDITORIAL_DIRECTION,
      layoutFamily: "monument-axis",
    }), "utf8");
    const invalid = spawnSync("python3", [RENDERER, invalidPath], { cwd: workspace, encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /compositionTopology=modular-editorial requires layoutFamily=editorial-blocks/u);
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
    assert.ok(meanAbsoluteDifference(coarseLuminance(join(workspace, "radiant.png")), coarseLuminance(join(workspace, "procession.png"))) > 6);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("canvas-design variants alter the primary composition in every non-monument grammar", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agentloop-canvas-design-primary-variants-"));
  try {
    const cases = [
      ["signal-field", "constellation", "cartographic"],
      ["editorial-blocks", "overlap", "split-spread"],
      ["kinetic-ribbons", "sweep", "cross-current"],
      ["emblem-grid", "radial", "stamp-sheet"],
    ] as const;
    for (const [family, firstVariant, secondVariant] of cases) {
      const base = {
        title: "Visible Systems",
        subtitle: "One subject, different spatial decisions",
        movement: "Divergent Form",
        layoutFamily: family,
        palette: {
          backgroundTop: "#efe9dc",
          backgroundBottom: "#c9bfae",
          primary: "#b62f28",
          secondary: "#174f5b",
          tertiary: "#d49b2b",
          text: "#171917",
          mutedText: "#5f5c54",
        },
        labels: ["Context", "People", "Action", "Memory"],
        texture: 0,
        density: 0.62,
        seed: 410,
        canvas: { width: 900, height: 1200 },
      };
      render(workspace, { ...base, output: `${family}-a.png`, compositionVariant: firstVariant });
      render(workspace, { ...base, output: `${family}-b.png`, compositionVariant: secondVariant });
      const first = coarseLuminance(join(workspace, `${family}-a.png`));
      const second = coarseLuminance(join(workspace, `${family}-b.png`));
      const difference = meanAbsoluteDifference(first, second);
      assert.ok(difference > 2.0, `${family} variants should change the thumbnail silhouette; difference=${difference.toFixed(2)}`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("canvas-design rejects unsupported variants instead of silently replacing them", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agentloop-canvas-design-invalid-variant-"));
  try {
    const specPath = join(workspace, "invalid.json");
    writeFileSync(specPath, JSON.stringify({
      output: "invalid.png",
      title: "AI System",
      designIntent: "technology-system",
      artDirection: NETWORK_DIRECTION,
      compositionVariant: "orbit-core",
    }), "utf8");
    const result = spawnSync("python3", [RENDERER, specPath], { cwd: workspace, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported compositionVariant=orbit-core/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("canvas-design requires an art direction for new subject-intent specs", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agentloop-canvas-design-missing-direction-"));
  try {
    const specPath = join(workspace, "missing.json");
    writeFileSync(specPath, JSON.stringify({
      output: "missing.png",
      title: "AI System",
      designIntent: "technology-system",
    }), "utf8");
    const result = spawnSync("python3", [RENDERER, specPath], { cwd: workspace, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /artDirection is required/u);
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
  artDirection: Record<string, unknown> | null;
  artDirectionFingerprint: string | null;
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

function coarseLuminance(path: string): number[] {
  const script = [
    "import json, sys",
    "from PIL import Image",
    "image = Image.open(sys.argv[1]).convert('L').resize((12, 16))",
    "print(json.dumps(list(image.getdata())))",
  ].join("\n");
  const result = spawnSync("python3", ["-c", script, path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as number[];
}

function meanAbsoluteDifference(first: number[], second: number[]): number {
  assert.equal(first.length, second.length);
  return first.reduce((total, value, index) => total + Math.abs(value - second[index]), 0) / first.length;
}
