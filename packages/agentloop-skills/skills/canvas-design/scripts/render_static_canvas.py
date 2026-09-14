#!/usr/bin/env python3
"""Render a static poster/key-art canvas from a compact JSON spec.

This script is intentionally generic: the model supplies the visual direction
as data, while the Skill owns bounded rendering, CJK font selection, and export.
"""

from __future__ import annotations

import json
import hashlib
import math
import os
import random
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


DEFAULT_CANVAS = {"width": 1800, "height": 2700}
DEFAULT_PALETTE = {
    "backgroundTop": "#08111f",
    "backgroundBottom": "#030711",
    "primary": "#16d9ff",
    "secondary": "#f4c95d",
    "tertiary": "#8ee8b7",
    "text": "#eff7ff",
    "mutedText": "#9db5c8",
}

LAYOUT_FAMILIES = [
    "signal-field",
    "monument-axis",
    "editorial-blocks",
    "kinetic-ribbons",
    "emblem-grid",
]

# A family names the visual grammar; a variant names the actual composition.
# Keeping those separate prevents a topic such as a public anniversary from
# repeatedly collapsing into one silhouette just because the grammar is apt.
LAYOUT_VARIANTS = {
    "signal-field": ["constellation", "cartographic", "orbital"],
    "monument-axis": ["radiant-spire", "procession", "archive-seal"],
    "editorial-blocks": ["overlap", "index", "split-spread"],
    "kinetic-ribbons": ["sweep", "streamers", "cross-current"],
    "emblem-grid": ["radial", "totem", "stamp-sheet"],
}

MOTIF_KINDS = {"star", "banner", "figure", "building", "leaf", "orb", "peak", "flight"}

DESIGN_INTENTS = [
    "technology-system",
    "campaign-launch",
    "commemoration",
    "editorial-publication",
    "identity-recognition",
]

# Subject purpose and visual form are independent. The topology selected in the
# art direction owns layout selection; a technology brief can therefore become
# editorial, kinetic, symbolic, axial, or networked.
COMPOSITION_TOPOLOGY_FAMILIES = {
    "networked-field": "signal-field",
    "axial-monument": "monument-axis",
    "modular-editorial": "editorial-blocks",
    "directional-flow": "kinetic-ribbons",
    "symbolic-grid": "emblem-grid",
}

ART_DIRECTION_VALUES = {
    "emotionalRegister": ["restrained", "solemn", "exuberant", "humanist", "playful"],
    "materialLanguage": ["luminous-glass", "ink-paper", "cut-paper", "raw-print", "polished-metal"],
    "compositionTopology": list(COMPOSITION_TOPOLOGY_FAMILIES),
    "typographicVoice": ["quiet-technical", "monumental-display", "editorial-contrast", "compressed-impact", "humanist-poetic"],
    "colorStrategy": ["nocturne-electric", "warm-editorial", "monochrome-accent", "saturated-pop", "earth-paper"],
    "imageMode": ["abstract-system", "symbolic-object", "narrative-scene", "type-as-image", "collaged-fragments"],
}

COLOR_STRATEGY_PALETTES = {
    "nocturne-electric": DEFAULT_PALETTE,
    "warm-editorial": {
        "backgroundTop": "#f3ead8", "backgroundBottom": "#d9c8aa", "primary": "#c84a32",
        "secondary": "#1d4f5f", "tertiary": "#e2a93b", "text": "#202522", "mutedText": "#645f55",
    },
    "monochrome-accent": {
        "backgroundTop": "#eeeeea", "backgroundBottom": "#c9cbc7", "primary": "#171918",
        "secondary": "#e13b2c", "tertiary": "#696d69", "text": "#111211", "mutedText": "#5a5d59",
    },
    "saturated-pop": {
        "backgroundTop": "#f7d83d", "backgroundBottom": "#f05a7e", "primary": "#2446e8",
        "secondary": "#f23324", "tertiary": "#28b87a", "text": "#171238", "mutedText": "#543f5f",
    },
    "earth-paper": {
        "backgroundTop": "#e5d3ad", "backgroundBottom": "#b88f68", "primary": "#345b3e",
        "secondary": "#9b3f2d", "tertiary": "#d29d3d", "text": "#2c241d", "mutedText": "#6f5948",
    },
}

MATERIAL_TEXTURE_DEFAULTS = {
    "luminous-glass": 0.12,
    "ink-paper": 0.34,
    "cut-paper": 0.18,
    "raw-print": 0.48,
    "polished-metal": 0.16,
}

EMOTIONAL_DENSITY_FACTORS = {
    "restrained": 0.78,
    "solemn": 0.90,
    "exuberant": 1.24,
    "humanist": 1.0,
    "playful": 1.14,
}

TYPOGRAPHIC_SCALE_FACTORS = {
    "quiet-technical": 0.80,
    "monumental-display": 1.24,
    "editorial-contrast": 1.04,
    "compressed-impact": 1.16,
    "humanist-poetic": 0.92,
}

IMAGE_MODE_TITLE_FACTORS = {
    "abstract-system": 0.94,
    "symbolic-object": 1.0,
    "narrative-scene": 0.88,
    "type-as-image": 1.30,
    "collaged-fragments": 1.04,
}

SPEC_SCHEMA = {
    "schema": "agentloop.canvasDesignSpec/v2",
    # Keep executable choices before prose and examples. Runtime tool-result
    # previews preserve the beginning of large schema output, so contract
    # values must survive even when later descriptive content is compacted.
    "artDirectionValues": ART_DIRECTION_VALUES,
    "compositionTopologyFamilies": COMPOSITION_TOPOLOGY_FAMILIES,
    "layoutVariants": LAYOUT_VARIANTS,
    "motifKinds": sorted(MOTIF_KINDS),
    "designIntents": DESIGN_INTENTS,
    "layoutFamilies": LAYOUT_FAMILIES,
    "fields": {
        "output": "Relative PNG output path under the workspace.",
        "title": "Visible primary title, CJK-safe.",
        "subtitle": "Visible secondary phrase, CJK-safe.",
        "movement": "Short Latin style marker for the upper-left label.",
        "designIntent": "Subject purpose: technology-system, campaign-launch, commemoration, editorial-publication, or identity-recognition. It does not determine visual form.",
        "artDirection": "Required when designIntent is present. Contains concept, emotionalRegister, materialLanguage, compositionTopology, typographicVoice, colorStrategy, imageMode, and optional avoid.",
        "layoutFamily": "Optional composition grammar: signal-field, monument-axis, editorial-blocks, kinetic-ribbons, or emblem-grid.",
        "compositionVariant": "Optional named composition within the chosen grammar. Use one returned by --schema; omit or use auto only when the subject has no specific spatial direction.",
        "palette": {
            "backgroundTop": "#08111f",
            "backgroundBottom": "#030711",
            "primary": "#16d9ff",
            "secondary": "#f4c95d",
            "tertiary": "#8ee8b7",
            "text": "#eff7ff",
            "mutedText": "#9db5c8",
        },
        "labels": "Up to 8 compact labels rendered near the lower field.",
        "visualMotifs": "Up to 6 visible subject motifs. Each item is {kind: star|banner|figure|building|leaf|orb|peak|flight, label?: string}; motifs are drawn as graphic elements, not converted into footer labels.",
        "texture": "0.0-1.0 grain intensity.",
        "density": "0.1-1.0 field density.",
        "seed": "Integer deterministic composition seed.",
        "canvas": {"width": "900-3600", "height": "1200-5400"},
    },
    "example": {
        "output": "poster.png",
        "title": "城市更新论坛",
        "subtitle": "连接空间 · 技术 · 公共生活",
        "movement": "Civic Pulse",
        "designIntent": "technology-system",
        "artDirection": {
            "concept": "Digital services behave like layered notices gathered across a city",
            "emotionalRegister": "humanist",
            "materialLanguage": "ink-paper",
            "compositionTopology": "modular-editorial",
            "typographicVoice": "editorial-contrast",
            "colorStrategy": "warm-editorial",
            "imageMode": "collaged-fragments",
            "avoid": ["dark network field", "glowing central orb"],
        },
        "layoutFamily": "editorial-blocks",
        "compositionVariant": "split-spread",
        "palette": {
            "backgroundTop": "#f2eee6",
            "backgroundBottom": "#d8e4df",
            "primary": "#1d3557",
            "secondary": "#e76f51",
            "tertiary": "#2a9d8f",
            "text": "#172026",
            "mutedText": "#5f6f73",
        },
        "labels": ["主旨演讲", "城市实验", "公共数据", "设计工作坊", "治理创新", "开放展陈"],
        "visualMotifs": [{"kind": "building", "label": "公共空间"}, {"kind": "orb", "label": "数据流"}],
        "texture": 0.18,
        "density": 0.62,
        "seed": 311,
        "canvas": {"width": 1800, "height": 2700},
    },
}


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--schema":
        print(json.dumps(SPEC_SCHEMA, ensure_ascii=False, indent=2))
        return 0
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: render_static_canvas.py [--schema|spec.json]"}), file=sys.stderr)
        return 2

    spec_path = Path(sys.argv[1])
    spec = json.loads(spec_path.read_text("utf-8"))
    output = Path(str(spec.get("output", "canvas-design.png")))
    if output.is_absolute() or ".." in output.parts:
        raise ValueError("output must be a relative workspace path")
    output.parent.mkdir(parents=True, exist_ok=True)

    image, layout_family, composition_variant, visual_motifs, design_intent, art_direction = render(spec)
    image.save(output, "PNG", optimize=True)
    print(json.dumps({
        "schema": "agentloop.canvasDesignRender/v2",
        "artifactPath": str(output),
        "width": image.width,
        "height": image.height,
        "layoutFamily": layout_family,
        "compositionVariant": composition_variant,
        "visualMotifs": visual_motifs,
        "designIntent": design_intent,
        "artDirection": art_direction,
        "artDirectionFingerprint": art_direction_fingerprint(art_direction),
    }, ensure_ascii=False))
    return 0


def render(spec: dict[str, Any]) -> tuple[Image.Image, str, str, list[dict[str, str]], str | None, dict[str, Any] | None]:
    seed = int(spec.get("seed", 42))
    rng = random.Random(seed)
    canvas = spec.get("canvas") if isinstance(spec.get("canvas"), dict) else {}
    width = int(canvas.get("width", DEFAULT_CANVAS["width"]))
    height = int(canvas.get("height", DEFAULT_CANVAS["height"]))
    width = max(900, min(width, 3600))
    height = max(1200, min(height, 5400))

    raw_design_intent = spec.get("designIntent") or spec.get("design_intent")
    design_intent = normalize_design_intent(raw_design_intent)
    if raw_design_intent and design_intent is None:
        raise ValueError(f"unsupported designIntent={raw_design_intent}")
    art_direction = normalize_art_direction(spec.get("artDirection") or spec.get("art_direction"))
    if design_intent and art_direction is None:
        raise ValueError("artDirection is required when designIntent is present")

    color_strategy = art_direction.get("colorStrategy") if art_direction else "nocturne-electric"
    palette = dict(COLOR_STRATEGY_PALETTES[color_strategy])
    if isinstance(spec.get("palette"), dict):
        palette.update({k: v for k, v in spec["palette"].items() if isinstance(v, str)})

    layout_family = resolve_layout_family(spec, art_direction)
    composition_variant = resolve_composition_variant(spec, layout_family, art_direction)
    visual_motifs = normalize_visual_motifs(spec.get("visualMotifs") or spec.get("visual_motifs"))

    img = Image.new("RGB", (width, height), hex_color(palette["backgroundTop"]))
    draw_gradient(img, hex_color(palette["backgroundTop"]), hex_color(palette["backgroundBottom"]))
    draw = ImageDraw.Draw(img, "RGBA")

    material_language = art_direction.get("materialLanguage") if art_direction else "luminous-glass"
    emotional_register = art_direction.get("emotionalRegister") if art_direction else "restrained"
    typographic_voice = art_direction.get("typographicVoice") if art_direction else "quiet-technical"
    image_mode = art_direction.get("imageMode") if art_direction else "abstract-system"
    texture = float(spec.get("texture", MATERIAL_TEXTURE_DEFAULTS[material_language]))
    density = float(spec.get("density", 0.66)) * EMOTIONAL_DENSITY_FACTORS[emotional_register]
    density = max(0.1, min(density, 1.0))

    title = clean_text(spec.get("title", "Untitled"))
    subtitle = clean_text(spec.get("subtitle", ""))
    movement = clean_text(spec.get("movement", "Visual System"))
    labels = [clean_text(item) for item in spec.get("labels", []) if clean_text(item)][:8]

    title_scale = TYPOGRAPHIC_SCALE_FACTORS[typographic_voice] * IMAGE_MODE_TITLE_FACTORS[image_mode]
    title_font = fit_font_for_text(title, int(width * 0.86), max(58, int(width // 15 * title_scale)), prefer_cjk=True)
    subtitle_font = fit_font_for_text(subtitle or title, int(width * 0.72), max(24, width // 38), prefer_cjk=contains_cjk(subtitle))
    latin_font = packaged_font("Jura-Light.ttf", max(22, width // 70))
    mono_font = packaged_font("GeistMono-Regular.ttf", max(16, width // 110))
    label_font = fit_font_for_text(max(labels, key=len) if labels else title, int(width * 0.24), max(24, width // 40), prefer_cjk=True)

    if layout_family == "monument-axis":
        draw_monument_axis(draw, width, height, palette, rng, density, title, subtitle, movement, labels, title_font, subtitle_font, label_font, latin_font, mono_font, composition_variant)
    elif layout_family == "editorial-blocks":
        draw_editorial_blocks(draw, width, height, palette, rng, density, title, subtitle, movement, labels, title_font, subtitle_font, label_font, latin_font, mono_font, composition_variant)
    elif layout_family == "kinetic-ribbons":
        draw_kinetic_ribbons(draw, width, height, palette, rng, density, title, subtitle, movement, labels, title_font, subtitle_font, label_font, latin_font, mono_font, composition_variant)
    elif layout_family == "emblem-grid":
        draw_emblem_grid(draw, width, height, palette, rng, density, title, subtitle, movement, labels, title_font, subtitle_font, label_font, latin_font, mono_font, composition_variant)
    else:
        draw_signal_field(draw, width, height, palette, rng, density, title, subtitle, movement, labels, title_font, subtitle_font, label_font, latin_font, mono_font, composition_variant)

    draw_visual_motifs(draw, width, height, palette, visual_motifs, composition_variant, image_mode)
    apply_material_finish(draw, width, height, palette, rng, material_language, texture)
    add_grain(img, rng, texture)
    draw_variant_frame(draw, width, height, palette, composition_variant, material_language)
    return img, layout_family, composition_variant, visual_motifs, design_intent, art_direction


def normalize_layout_family(value: Any) -> str | None:
    raw = str(value or "").strip().lower().replace("_", "-").replace(" ", "-")
    aliases = {
        "field": "signal-field",
        "network": "signal-field",
        "signal": "signal-field",
        "monument": "monument-axis",
        "memorial": "monument-axis",
        "editorial": "editorial-blocks",
        "blocks": "editorial-blocks",
        "kinetic": "kinetic-ribbons",
        "ribbons": "kinetic-ribbons",
        "emblem": "emblem-grid",
        "grid": "emblem-grid",
    }
    candidate = aliases.get(raw, raw)
    return candidate if candidate in LAYOUT_FAMILIES else None


def normalize_design_intent(value: Any) -> str | None:
    raw = str(value or "").strip().lower().replace("_", "-").replace(" ", "-")
    aliases = {
        "technology": "technology-system",
        "system": "technology-system",
        "tech": "technology-system",
        "campaign": "campaign-launch",
        "launch": "campaign-launch",
        "memorial": "commemoration",
        "ceremony": "commemoration",
        "editorial": "editorial-publication",
        "publication": "editorial-publication",
        "identity": "identity-recognition",
        "recognition": "identity-recognition",
    }
    candidate = aliases.get(raw, raw)
    return candidate if candidate in DESIGN_INTENTS else None


def normalize_art_direction(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("artDirection must be an object")

    concept = clean_text(value.get("concept", ""))
    if not concept:
        raise ValueError("artDirection.concept is required")

    normalized: dict[str, Any] = {"concept": concept}
    for field, allowed in ART_DIRECTION_VALUES.items():
        raw = value.get(field)
        candidate = str(raw or "").strip().lower().replace("_", "-").replace(" ", "-")
        if candidate not in allowed:
            raise ValueError(f"artDirection.{field} must be one of: {', '.join(allowed)}")
        normalized[field] = candidate

    avoid = value.get("avoid", [])
    if avoid is not None and not isinstance(avoid, list):
        raise ValueError("artDirection.avoid must be an array")
    normalized["avoid"] = [clean_text(item)[:80] for item in (avoid or []) if clean_text(item)][:6]
    return normalized


def art_direction_fingerprint(art_direction: dict[str, Any] | None) -> str | None:
    if art_direction is None:
        return None
    canonical = json.dumps(art_direction, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def resolve_layout_family(spec: dict[str, Any], art_direction: dict[str, Any] | None) -> str:
    requested = spec.get("layoutFamily") or spec.get("layout_family")
    normalized_requested = normalize_layout_family(requested) if requested else None
    if requested and normalized_requested is None:
        raise ValueError(f"unsupported layoutFamily={requested}")
    if art_direction:
        topology = art_direction["compositionTopology"]
        expected = COMPOSITION_TOPOLOGY_FAMILIES[topology]
        if normalized_requested and normalized_requested != expected:
            raise ValueError(f"artDirection.compositionTopology={topology} requires layoutFamily={expected}")
        return expected
    return normalized_requested or auto_layout_family(spec)


def resolve_composition_variant(spec: dict[str, Any], layout_family: str, art_direction: dict[str, Any] | None) -> str:
    variants = LAYOUT_VARIANTS[layout_family]
    requested = str(spec.get("compositionVariant") or spec.get("composition_variant") or "").strip().lower().replace("_", "-")
    if requested and requested != "auto":
        if requested not in variants:
            raise ValueError(f"unsupported compositionVariant={requested} for layoutFamily={layout_family}")
        return requested

    # Use all authored direction, not just a generic family or a fixed default
    # seed. Two different briefs in the same grammar therefore do not inherit
    # the same silhouette by accident, while an explicit variant stays stable.
    signature = json.dumps({
        "layout": layout_family,
        "title": clean_text(spec.get("title", "")),
        "subtitle": clean_text(spec.get("subtitle", "")),
        "movement": clean_text(spec.get("movement", "")),
        "labels": [clean_text(item) for item in spec.get("labels", []) if clean_text(item)],
        "motifs": spec.get("visualMotifs") or spec.get("visual_motifs") or [],
        "artDirection": art_direction or {},
        "seed": spec.get("seed", 42),
    }, ensure_ascii=False, sort_keys=True)
    digest = hashlib.sha256(signature.encode("utf-8")).digest()
    return variants[digest[0] % len(variants)]


def normalize_visual_motifs(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    motifs: list[dict[str, str]] = []
    for item in value[:6]:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind", "")).strip().lower().replace("_", "-")
        if kind not in MOTIF_KINDS:
            continue
        label = clean_text(item.get("label", ""))[:40]
        motifs.append({"kind": kind, "label": label})
    return motifs


def auto_layout_family(spec: dict[str, Any]) -> str:
    text_parts = [
        clean_text(spec.get("title", "")),
        clean_text(spec.get("subtitle", "")),
        clean_text(spec.get("movement", "")),
        " ".join(clean_text(item) for item in spec.get("labels", []) if clean_text(item)),
    ]
    text = " ".join(text_parts).lower()
    semantic_hints = [
        (("纪念", "周年", "历史", "胜利", "memorial", "anniversary", "heritage"), "monument-axis"),
        (("数据", "智能", "平台", "ai", "network", "system", "technology"), "signal-field"),
        (("活动", "发布", "开幕", "节", "festival", "launch", "campaign"), "kinetic-ribbons"),
        (("论坛", "展览", "报告", "publication", "editorial", "forum", "exhibit"), "editorial-blocks"),
        (("品牌", "徽章", "奖项", "logo", "identity", "award"), "emblem-grid"),
    ]
    for tokens, family in semantic_hints:
        if any(hint_matches(text, token) for token in tokens):
            return family
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return LAYOUT_FAMILIES[digest[0] % len(LAYOUT_FAMILIES)]


def hint_matches(text: str, token: str) -> bool:
    if any("\u3400" <= char <= "\u9fff" for char in token):
        return token in text
    return re.search(rf"\b{re.escape(token)}\b", text) is not None


def draw_signal_field(
    draw: ImageDraw.ImageDraw,
    width: int,
    height: int,
    palette: dict[str, str],
    rng: random.Random,
    density: float,
    title: str,
    subtitle: str,
    movement: str,
    labels: list[str],
    title_font: ImageFont.ImageFont,
    subtitle_font: ImageFont.ImageFont,
    label_font: ImageFont.ImageFont,
    latin_font: ImageFont.ImageFont,
    mono_font: ImageFont.ImageFont,
    composition_variant: str,
) -> None:
    primary, secondary, tertiary = (hex_color(palette[key]) for key in ("primary", "secondary", "tertiary"))
    text, muted = hex_color(palette["text"]), hex_color(palette["mutedText"])
    if composition_variant == "cartographic":
        draw_metadata(draw, width, height, palette, movement, "CARTOGRAPHIC SIGNAL", latin_font, mono_font)
        for x in range(int(width * 0.10), int(width * 0.94), max(36, width // 12)):
            draw.line((x, int(height * 0.22), x, int(height * 0.86)), fill=muted + (42,), width=1)
        for y in range(int(height * 0.22), int(height * 0.87), max(44, height // 18)):
            draw.line((int(width * 0.10), y, int(width * 0.94), y), fill=muted + (36,), width=1)
        for index in range(int(8 + density * 14)):
            x0 = int(width * (0.12 + rng.random() * 0.48))
            y0 = int(height * (0.31 + rng.random() * 0.42))
            points = [(x0, y0)]
            for step in range(1, 5):
                points.append((x0 + int(width * 0.08 * step), y0 + rng.randint(-height // 14, height // 14)))
            draw.line(points, fill=[primary, secondary, tertiary][index % 3] + (115,), width=max(2, width // 620))
            draw.ellipse((x0 - 7, y0 - 7, x0 + 7, y0 + 7), fill=secondary + (175,))
        draw.text((int(width * 0.10), int(height * 0.13)), title, font=title_font, fill=text + (248,))
        if subtitle:
            draw.text((int(width * 0.105), int(height * 0.13) + font_height(title_font) + int(height * 0.016)), subtitle, font=subtitle_font, fill=muted + (225,))
        draw_label_column(draw, int(width * 0.68), int(height * 0.68), palette, labels, label_font, 0)
        return

    if composition_variant == "orbital":
        draw_metadata(draw, width, height, palette, movement, "ORBITAL SYSTEM", latin_font, mono_font)
        cx, cy = int(width * 0.60), int(height * 0.52)
        for index in range(7):
            rx = int(width * (0.09 + index * 0.040))
            ry = int(height * (0.07 + index * 0.035))
            color = [primary, tertiary, secondary][index % 3]
            draw.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), outline=color + (125 - index * 8,), width=max(2, width // 700))
        for index in range(int(16 + density * 24)):
            angle = rng.random() * math.tau
            radius = width * (0.11 + rng.random() * 0.30)
            x, y = cx + math.cos(angle) * radius, cy + math.sin(angle) * radius * 1.25
            size = max(3, int(width * (0.003 + rng.random() * 0.006)))
            draw.ellipse((x - size, y - size, x + size, y + size), fill=[primary, secondary, tertiary][index % 3] + (170,))
        draw.text((int(width * 0.09), int(height * 0.15)), title, font=title_font, fill=text + (248,))
        if subtitle:
            draw.text((int(width * 0.095), int(height * 0.15) + font_height(title_font) + int(height * 0.016)), subtitle, font=subtitle_font, fill=muted + (225,))
        draw_label_column(draw, int(width * 0.10), int(height * 0.66), palette, labels, label_font, 0)
        return

    draw_field(draw, width, height, palette, rng, density)
    draw_meridians(draw, width, height, palette, rng, density)
    draw_metadata(draw, width, height, palette, movement, "CONSTELLATION FIELD", latin_font, mono_font)
    title_y = int(height * 0.125)
    draw_centered(draw, (width // 2, title_y), title, title_font, text + (245,))
    if subtitle:
        draw_centered(draw, (width // 2, title_y + int(width * 0.07)), subtitle, subtitle_font, muted + (220,))
    draw_label_grid(draw, width, height, palette, labels, label_font, int(height * 0.72), 3)


def draw_monument_axis(
    draw: ImageDraw.ImageDraw,
    width: int,
    height: int,
    palette: dict[str, str],
    rng: random.Random,
    density: float,
    title: str,
    subtitle: str,
    movement: str,
    labels: list[str],
    title_font: ImageFont.ImageFont,
    subtitle_font: ImageFont.ImageFont,
    label_font: ImageFont.ImageFont,
    latin_font: ImageFont.ImageFont,
    mono_font: ImageFont.ImageFont,
    composition_variant: str,
) -> None:
    primary = hex_color(palette["primary"])
    secondary = hex_color(palette["secondary"])
    tertiary = hex_color(palette["tertiary"])
    text = hex_color(palette["text"])
    muted = hex_color(palette["mutedText"])
    if composition_variant == "procession":
        draw_monument_procession(draw, width, height, palette, rng, density, title, subtitle, movement, labels, title_font, subtitle_font, label_font, latin_font, mono_font)
        return
    if composition_variant == "archive-seal":
        draw_monument_archive_seal(draw, width, height, palette, rng, density, title, subtitle, movement, labels, title_font, subtitle_font, label_font, latin_font, mono_font)
        return

    draw_metadata(draw, width, height, palette, movement, "RADIANT SPIRE", latin_font, mono_font)

    base_y = int(height * 0.68)
    center_x = width // 2
    for i in range(int(16 + 28 * density)):
        angle = -math.pi / 2 + (rng.random() - 0.5) * 1.15
        length = rng.randint(int(height * 0.24), int(height * 0.56))
        end = (center_x + math.cos(angle) * length, base_y + math.sin(angle) * length)
        color = primary if i % 3 else secondary
        draw.line((center_x, base_y, end[0], end[1]), fill=color + (rng.randint(36, 105),), width=max(1, width // 650))

    for i in range(9):
        y = base_y + i * int(height * 0.018)
        draw.line((int(width * 0.15), y, int(width * 0.85), y), fill=secondary + (95 - i * 7,), width=max(1, width // 700))

    monument = [
        (center_x, int(height * 0.31)),
        (int(width * 0.58), int(height * 0.72)),
        (int(width * 0.42), int(height * 0.72)),
    ]
    draw.polygon(monument, fill=primary + (34,), outline=primary + (135,))
    draw.line((center_x, int(height * 0.33), center_x, int(height * 0.71)), fill=tertiary + (95,), width=max(2, width // 420))
    draw.ellipse((center_x - width * 0.045, base_y - width * 0.045, center_x + width * 0.045, base_y + width * 0.045), outline=secondary + (150,), width=max(2, width // 480))

    draw_centered(draw, (center_x, int(height * 0.16)), title, title_font, text + (248,))
    if subtitle:
        draw_centered(draw, (center_x, int(height * 0.215)), subtitle, subtitle_font, muted + (225,))
    draw_label_column(draw, int(width * 0.12), int(height * 0.77), palette, labels[::2], label_font, 0)
    draw_label_column(draw, int(width * 0.64), int(height * 0.77), palette, labels[1::2], label_font, 1)


def draw_monument_procession(
    draw: ImageDraw.ImageDraw,
    width: int,
    height: int,
    palette: dict[str, str],
    rng: random.Random,
    density: float,
    title: str,
    subtitle: str,
    movement: str,
    labels: list[str],
    title_font: ImageFont.ImageFont,
    subtitle_font: ImageFont.ImageFont,
    label_font: ImageFont.ImageFont,
    latin_font: ImageFont.ImageFont,
    mono_font: ImageFont.ImageFont,
) -> None:
    primary, secondary, tertiary = (hex_color(palette[key]) for key in ("primary", "secondary", "tertiary"))
    text, muted = hex_color(palette["text"]), hex_color(palette["mutedText"])
    draw_metadata(draw, width, height, palette, movement, "CIVIC PROCESSION", latin_font, mono_font)
    sun_x, sun_y, radius = int(width * 0.74), int(height * 0.33), int(width * 0.16)
    draw.ellipse((sun_x - radius, sun_y - radius, sun_x + radius, sun_y + radius), fill=primary + (52,), outline=primary + (170,), width=max(2, width // 480))
    for index in range(int(14 + density * 16)):
        angle = math.tau * index / int(14 + density * 16)
        inner, outer = radius * 1.08, radius * (1.28 + rng.random() * 0.42)
        draw.line((sun_x + math.cos(angle) * inner, sun_y + math.sin(angle) * inner, sun_x + math.cos(angle) * outer, sun_y + math.sin(angle) * outer), fill=secondary + (110,), width=max(2, width // 520))
    horizon = int(height * 0.69)
    for index in range(5):
        x0 = int(width * (0.08 + index * 0.18))
        x1 = x0 + int(width * (0.13 + rng.random() * 0.08))
        building_top = horizon - int(height * (0.06 + rng.random() * 0.13))
        draw.rectangle((x0, building_top, x1, horizon), fill=tertiary + (60 + index * 15,), outline=primary + (105,))
    for index in range(4):
        x = int(width * (0.18 + index * 0.19))
        y = horizon - int(height * (0.04 + (index % 2) * 0.025))
        head = max(10, width // 95)
        draw.ellipse((x - head, y - head * 3, x + head, y - head), fill=text + (180,))
        draw.line((x, y - head, x, y + head * 3), fill=text + (170,), width=max(3, width // 320))
        draw.line((x - head * 2, y + head, x + head * 2, y + head), fill=text + (150,), width=max(2, width // 460))
    for index in range(3):
        x = int(width * (0.08 + index * 0.29))
        points = [(x, int(height * 0.55)), (x + int(width * 0.20), int(height * 0.49)), (x + int(width * 0.12), int(height * 0.63))]
        draw.polygon(points, fill=[primary, secondary, tertiary][index] + (58,), outline=[primary, secondary, tertiary][index] + (150,))
    draw.text((int(width * 0.10), int(height * 0.14)), title, font=title_font, fill=text + (248,))
    if subtitle:
        draw.text((int(width * 0.105), int(height * 0.14) + font_height(title_font) + int(height * 0.018)), subtitle, font=subtitle_font, fill=muted + (225,))
    draw_label_grid(draw, width, height, palette, labels, label_font, int(height * 0.80), 3)


def draw_monument_archive_seal(
    draw: ImageDraw.ImageDraw,
    width: int,
    height: int,
    palette: dict[str, str],
    rng: random.Random,
    density: float,
    title: str,
    subtitle: str,
    movement: str,
    labels: list[str],
    title_font: ImageFont.ImageFont,
    subtitle_font: ImageFont.ImageFont,
    label_font: ImageFont.ImageFont,
    latin_font: ImageFont.ImageFont,
    mono_font: ImageFont.ImageFont,
) -> None:
    primary, secondary, tertiary = (hex_color(palette[key]) for key in ("primary", "secondary", "tertiary"))
    text, muted = hex_color(palette["text"]), hex_color(palette["mutedText"])
    draw_metadata(draw, width, height, palette, movement, "ARCHIVE SEAL", latin_font, mono_font)
    cx, cy = int(width * 0.67), int(height * 0.48)
    outer = int(width * 0.27)
    for index in range(5):
        inset = index * int(outer * 0.13)
        color = [primary, secondary, tertiary, text, primary][index]
        draw.ellipse((cx - outer + inset, cy - outer + inset, cx + outer - inset, cy + outer - inset), outline=color + (175 - index * 22,), width=max(2, width // 410))
    for index in range(12):
        angle = math.tau * index / 12
        x = cx + math.cos(angle) * outer * 0.78
        y = cy + math.sin(angle) * outer * 0.78
        draw.ellipse((x - width * 0.008, y - width * 0.008, x + width * 0.008, y + width * 0.008), fill=secondary + (160,))
    draw.rectangle((int(width * 0.10), int(height * 0.28), int(width * 0.16), int(height * 0.73)), fill=primary + (75,), outline=primary + (150,))
    for index in range(int(8 + density * 10)):
        y = int(height * (0.24 + index * 0.035))
        draw.line((int(width * 0.22), y, int(width * 0.48), y), fill=tertiary + (70 + (index % 3) * 24,), width=max(1, width // 650))
    draw.text((int(width * 0.11), int(height * 0.13)), title, font=title_font, fill=text + (248,))
    if subtitle:
        draw.text((int(width * 0.115), int(height * 0.13) + font_height(title_font) + int(height * 0.018)), subtitle, font=subtitle_font, fill=muted + (225,))
    draw_label_column(draw, int(width * 0.12), int(height * 0.79), palette, labels, label_font, 0)


def draw_editorial_blocks(
    draw: ImageDraw.ImageDraw,
    width: int,
    height: int,
    palette: dict[str, str],
    rng: random.Random,
    density: float,
    title: str,
    subtitle: str,
    movement: str,
    labels: list[str],
    title_font: ImageFont.ImageFont,
    subtitle_font: ImageFont.ImageFont,
    label_font: ImageFont.ImageFont,
    latin_font: ImageFont.ImageFont,
    mono_font: ImageFont.ImageFont,
    composition_variant: str,
) -> None:
    primary = hex_color(palette["primary"])
    secondary = hex_color(palette["secondary"])
    tertiary = hex_color(palette["tertiary"])
    text = hex_color(palette["text"])
    muted = hex_color(palette["mutedText"])
    if composition_variant == "index":
        draw_metadata(draw, width, height, palette, movement, "EDITORIAL INDEX", latin_font, mono_font)
        rail_x = int(width * 0.28)
        draw.rectangle((int(width * 0.08), int(height * 0.16), rail_x, int(height * 0.90)), fill=primary + (205,))
        for index in range(7):
            y = int(height * (0.22 + index * 0.085))
            draw.text((int(width * 0.11), y), f"{index + 1:02d}", font=mono_font, fill=text + (210,))
            draw.line((rail_x + int(width * 0.04), y + 12, int(width * (0.90 - index * 0.035)), y + 12), fill=[secondary, tertiary][index % 2] + (130,), width=max(2, width // 500))
        index_title_font = fit_font_for_text(title, int(width * 0.54), getattr(title_font, "size", max(58, width // 15)), prefer_cjk=contains_cjk(title))
        draw.text((int(width * 0.36), int(height * 0.18)), title, font=index_title_font, fill=text + (248,))
        if subtitle:
            draw.text((int(width * 0.365), int(height * 0.18) + font_height(index_title_font) + int(height * 0.02)), subtitle, font=subtitle_font, fill=muted + (225,))
        draw_label_column(draw, int(width * 0.56), int(height * 0.66), palette, labels, label_font, 0)
        return

    if composition_variant == "split-spread":
        draw_metadata(draw, width, height, palette, movement, "SPLIT SPREAD", latin_font, mono_font)
        gutter = width // 2
        draw.rectangle((int(width * 0.07), int(height * 0.19), gutter - int(width * 0.025), int(height * 0.78)), fill=primary + (205,))
        draw.rectangle((gutter + int(width * 0.025), int(height * 0.29), int(width * 0.93), int(height * 0.88)), fill=secondary + (175,))
        draw.rectangle((gutter + int(width * 0.025), int(height * 0.19), int(width * 0.74), int(height * 0.27)), fill=tertiary + (190,))
        draw.line((gutter, int(height * 0.13), gutter, int(height * 0.91)), fill=text + (70,), width=max(2, width // 700))
        draw.text((int(width * 0.10), int(height * 0.12)), title, font=title_font, fill=text + (248,))
        if subtitle:
            draw.text((int(width * 0.54), int(height * 0.34)), subtitle, font=subtitle_font, fill=text + (225,))
        draw_label_column(draw, int(width * 0.55), int(height * 0.62), palette, labels, label_font, 0)
        return

    draw_metadata(draw, width, height, palette, movement, "OVERLAP STUDY", latin_font, mono_font)

    blocks = [
        (0.10, 0.18, 0.55, 0.43, primary, 215),
        (0.55, 0.26, 0.88, 0.59, secondary, 180),
        (0.18, 0.53, 0.49, 0.80, tertiary, 145),
        (0.49, 0.62, 0.83, 0.78, primary, 120),
    ]
    for x0, y0, x1, y1, color, alpha in blocks:
        jitter = int(width * 0.012 * density)
        dx = rng.randint(-jitter, jitter)
        dy = rng.randint(-jitter, jitter)
        draw.rectangle((int(width * x0) + dx, int(height * y0) + dy, int(width * x1) + dx, int(height * y1) + dy), fill=color + (alpha,), outline=text + (30,))

    for i in range(22):
        x = int(width * (0.08 + rng.random() * 0.84))
        y = int(height * (0.20 + rng.random() * 0.62))
        length = int(width * (0.04 + rng.random() * 0.16))
        color = [primary, secondary, tertiary][i % 3]
        draw.line((x, y, x + length, y), fill=color + (120,), width=max(2, width // 380))

    title_x = int(width * 0.105)
    draw.text((title_x, int(height * 0.105)), title, font=title_font, fill=text + (245,))
    if subtitle:
        draw.text((title_x, int(height * 0.105) + font_height(title_font) + int(height * 0.018)), subtitle, font=subtitle_font, fill=muted + (220,))
    draw_label_grid(draw, width, height, palette, labels, label_font, int(height * 0.835), 4)


def draw_kinetic_ribbons(
    draw: ImageDraw.ImageDraw,
    width: int,
    height: int,
    palette: dict[str, str],
    rng: random.Random,
    density: float,
    title: str,
    subtitle: str,
    movement: str,
    labels: list[str],
    title_font: ImageFont.ImageFont,
    subtitle_font: ImageFont.ImageFont,
    label_font: ImageFont.ImageFont,
    latin_font: ImageFont.ImageFont,
    mono_font: ImageFont.ImageFont,
    composition_variant: str,
) -> None:
    primary = hex_color(palette["primary"])
    secondary = hex_color(palette["secondary"])
    tertiary = hex_color(palette["tertiary"])
    text = hex_color(palette["text"])
    muted = hex_color(palette["mutedText"])
    if composition_variant == "streamers":
        draw_metadata(draw, width, height, palette, movement, "VERTICAL STREAMERS", latin_font, mono_font)
        for index in range(int(10 + density * 12)):
            x = int(width * (0.08 + index / max(1, int(10 + density * 12) - 1) * 0.84))
            points = []
            for step in range(34):
                y = int(height * (0.16 + step / 33 * 0.68))
                wave = math.sin(step * 0.32 + index * 0.65) * width * (0.018 + 0.015 * density)
                points.append((x + wave, y))
            draw.line(points, fill=[primary, secondary, tertiary][index % 3] + (145,), width=max(4, width // 170))
        draw.text((int(width * 0.10), int(height * 0.13)), title, font=title_font, fill=text + (248,))
        if subtitle:
            draw.text((int(width * 0.58), int(height * 0.73)), subtitle, font=subtitle_font, fill=muted + (230,))
        draw_label_column(draw, int(width * 0.10), int(height * 0.72), palette, labels, label_font, 0)
        return

    if composition_variant == "cross-current":
        draw_metadata(draw, width, height, palette, movement, "CROSS CURRENT", latin_font, mono_font)
        for index in range(int(8 + density * 10)):
            offset = index * int(height * 0.025)
            draw.line((-width * 0.08, height * 0.26 + offset, width * 1.08, height * 0.72 - offset * 0.25), fill=[primary, secondary, tertiary][index % 3] + (100 + index % 4 * 18,), width=max(5, width // 145))
            draw.line((-width * 0.08, height * 0.70 - offset * 0.3, width * 1.08, height * 0.30 + offset), fill=[tertiary, primary, secondary][index % 3] + (75 + index % 3 * 22,), width=max(3, width // 210))
        draw.text((int(width * 0.09), int(height * 0.12)), title, font=title_font, fill=text + (248,))
        if subtitle:
            draw.text((int(width * 0.095), int(height * 0.12) + font_height(title_font) + int(height * 0.018)), subtitle, font=subtitle_font, fill=muted + (225,))
        draw_label_grid(draw, width, height, palette, labels, label_font, int(height * 0.79), 4)
        return

    draw_metadata(draw, width, height, palette, movement, "KINETIC SWEEP", latin_font, mono_font)

    for i in range(int(9 + 12 * density)):
        y = int(height * (0.18 + rng.random() * 0.56))
        amplitude = int(height * (0.055 + rng.random() * 0.12))
        points = []
        for step in range(46):
            x = int(width * (-0.08 + step / 45 * 1.16))
            wave = math.sin(step * 0.34 + rng.random() * 0.08 + i)
            points.append((x, y + int(wave * amplitude) + i * int(height * 0.006)))
        color = [primary, secondary, tertiary][i % 3]
        draw.line(points, fill=color + (70 + (i % 4) * 24,), width=max(5, width // (135 + i * 4)))

    for i in range(10):
        x0 = int(width * (0.10 + rng.random() * 0.72))
        y0 = int(height * (0.28 + rng.random() * 0.45))
        x1 = x0 + int(width * (0.14 + rng.random() * 0.22))
        y1 = y0 + int(height * (0.025 + rng.random() * 0.09))
        color = [primary, secondary, tertiary][i % 3]
        draw.rectangle((x0, y0, x1, y1), fill=color + (45,), outline=color + (130,))

    draw_centered(draw, (width // 2, int(height * 0.145)), title, title_font, text + (248,))
    if subtitle:
        draw_centered(draw, (width // 2, int(height * 0.205)), subtitle, subtitle_font, muted + (225,))
    draw_label_grid(draw, width, height, palette, labels, label_font, int(height * 0.76), 2)


def draw_emblem_grid(
    draw: ImageDraw.ImageDraw,
    width: int,
    height: int,
    palette: dict[str, str],
    rng: random.Random,
    density: float,
    title: str,
    subtitle: str,
    movement: str,
    labels: list[str],
    title_font: ImageFont.ImageFont,
    subtitle_font: ImageFont.ImageFont,
    label_font: ImageFont.ImageFont,
    latin_font: ImageFont.ImageFont,
    mono_font: ImageFont.ImageFont,
    composition_variant: str,
) -> None:
    primary = hex_color(palette["primary"])
    secondary = hex_color(palette["secondary"])
    tertiary = hex_color(palette["tertiary"])
    text = hex_color(palette["text"])
    muted = hex_color(palette["mutedText"])
    if composition_variant == "totem":
        draw_metadata(draw, width, height, palette, movement, "VERTICAL TOTEM", latin_font, mono_font)
        cx = width // 2
        for index, scale in enumerate((0.28, 0.21, 0.15, 0.10)):
            size = int(width * scale)
            cy = int(height * (0.34 + index * 0.12))
            color = [primary, secondary, tertiary, text][index]
            if index % 2:
                draw.polygon([(cx, cy - size), (cx + size, cy), (cx, cy + size), (cx - size, cy)], fill=color + (65,), outline=color + (190,))
            else:
                draw.ellipse((cx - size, cy - size, cx + size, cy + size), outline=color + (190,), width=max(3, width // 330))
        draw.text((int(width * 0.09), int(height * 0.13)), title, font=title_font, fill=text + (248,))
        if subtitle:
            draw.text((int(width * 0.095), int(height * 0.13) + font_height(title_font) + int(height * 0.018)), subtitle, font=subtitle_font, fill=muted + (225,))
        draw_label_column(draw, int(width * 0.10), int(height * 0.70), palette, labels, label_font, 0)
        return

    if composition_variant == "stamp-sheet":
        draw_metadata(draw, width, height, palette, movement, "STAMP SHEET", latin_font, mono_font)
        cols, rows = 3, 3
        cell_w, cell_h = width * 0.24, height * 0.14
        start_x, start_y = width * 0.10, height * 0.29
        for row in range(rows):
            for col in range(cols):
                x0 = start_x + col * cell_w * 1.18
                y0 = start_y + row * cell_h * 1.12
                color = [primary, secondary, tertiary][(row + col) % 3]
                draw.rectangle((x0, y0, x0 + cell_w, y0 + cell_h), fill=color + (40 + (row + col) % 2 * 45,), outline=color + (175,), width=max(2, width // 650))
                inset = min(cell_w, cell_h) * 0.22
                draw.ellipse((x0 + inset, y0 + inset, x0 + cell_w - inset, y0 + cell_h - inset), outline=text + (115,), width=max(1, width // 850))
        draw.text((int(width * 0.10), int(height * 0.12)), title, font=title_font, fill=text + (248,))
        if subtitle:
            draw.text((int(width * 0.105), int(height * 0.12) + font_height(title_font) + int(height * 0.016)), subtitle, font=subtitle_font, fill=muted + (225,))
        draw_label_grid(draw, width, height, palette, labels, label_font, int(height * 0.80), 3)
        return

    draw_metadata(draw, width, height, palette, movement, "RADIAL EMBLEM", latin_font, mono_font)

    cell = max(54, width // 18)
    for x in range(int(width * 0.08), int(width * 0.92), cell):
        for y in range(int(height * 0.18), int(height * 0.79), cell):
            if rng.random() < 0.38 * density:
                color = [primary, secondary, tertiary][(x // cell + y // cell) % 3]
                pad = int(cell * 0.28)
                draw.rectangle((x + pad, y + pad, x + cell - pad, y + cell - pad), fill=color + (70,), outline=color + (125,))
            else:
                draw.point((x + cell // 2, y + cell // 2), fill=muted + (80,))

    cx, cy = width // 2, int(height * 0.46)
    outer = int(min(width, height) * 0.245)
    for i in range(4):
        inset = i * int(outer * 0.16)
        color = [primary, secondary, tertiary, text][i % 4]
        draw.ellipse((cx - outer + inset, cy - outer + inset, cx + outer - inset, cy + outer - inset), outline=color + (170 - i * 28,), width=max(2, width // 360))
    for i in range(24):
        angle = math.tau * i / 24
        r0 = outer * 0.62
        r1 = outer * (0.92 + rng.random() * 0.15)
        draw.line((cx + math.cos(angle) * r0, cy + math.sin(angle) * r0, cx + math.cos(angle) * r1, cy + math.sin(angle) * r1), fill=secondary + (120,), width=max(1, width // 720))

    draw_centered(draw, (width // 2, int(height * 0.135)), title, title_font, text + (248,))
    if subtitle:
        draw_centered(draw, (width // 2, int(height * 0.195)), subtitle, subtitle_font, muted + (225,))
    draw_label_grid(draw, width, height, palette, labels, label_font, int(height * 0.78), 4)


def draw_gradient(img: Image.Image, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> None:
    px = img.load()
    for y in range(img.height):
        ratio = y / max(1, img.height - 1)
        row = tuple(int(top[i] * (1 - ratio) + bottom[i] * ratio) for i in range(3))
        for x in range(img.width):
            px[x, y] = row


def draw_field(draw: ImageDraw.ImageDraw, width: int, height: int, palette: dict[str, str], rng: random.Random, density: float) -> None:
    primary = hex_color(palette["primary"])
    secondary = hex_color(palette["secondary"])
    count = int(80 + 170 * max(0.1, min(density, 1.0)))
    center = (width * 0.5, height * 0.46)
    for i in range(count):
        angle = rng.random() * math.tau
        radius = (rng.random() ** 0.62) * min(width, height) * 0.42
        x = center[0] + math.cos(angle) * radius * 0.82
        y = center[1] + math.sin(angle) * radius * 1.12
        size = rng.randint(max(2, width // 650), max(4, width // 240))
        color = primary if i % 5 else secondary
        alpha = rng.randint(45, 160)
        draw.ellipse((x - size, y - size, x + size, y + size), fill=color + (alpha,))


def draw_meridians(draw: ImageDraw.ImageDraw, width: int, height: int, palette: dict[str, str], rng: random.Random, density: float) -> None:
    primary = hex_color(palette["primary"])
    tertiary = hex_color(palette["tertiary"])
    secondary = hex_color(palette["secondary"])
    lines = int(26 + 34 * max(0.1, min(density, 1.0)))
    for i in range(lines):
        start_x = rng.randint(int(width * 0.06), int(width * 0.94))
        start_y = rng.randint(int(height * 0.22), int(height * 0.66))
        end_x = rng.randint(int(width * 0.06), int(width * 0.94))
        end_y = rng.randint(int(height * 0.28), int(height * 0.76))
        mid_x = (start_x + end_x) / 2 + rng.randint(-width // 7, width // 7)
        mid_y = (start_y + end_y) / 2 + rng.randint(-height // 10, height // 10)
        color = [primary, tertiary, secondary][i % 3]
        alpha = rng.randint(38, 110)
        points = bezier_points((start_x, start_y), (mid_x, mid_y), (end_x, end_y), 36)
        draw.line(points, fill=color + (alpha,), width=max(1, width // 900))


def draw_label(draw: ImageDraw.ImageDraw, x: int, y: int, text: str, font: ImageFont.ImageFont, palette: dict[str, str], index: int) -> None:
    primary = hex_color(palette["primary"])
    secondary = hex_color(palette["secondary"])
    text_color = hex_color(palette["text"])
    accent = primary if index % 2 == 0 else secondary
    draw.line((x, y - 18, x + 76, y - 18), fill=accent + (145,), width=2)
    draw.text((x, y), text, font=font, fill=text_color + (220,))


def draw_metadata(
    draw: ImageDraw.ImageDraw,
    width: int,
    height: int,
    palette: dict[str, str],
    movement: str,
    descriptor: str,
    latin_font: ImageFont.ImageFont,
    mono_font: ImageFont.ImageFont,
) -> None:
    draw.text((int(width * 0.075), int(height * 0.055)), movement.upper(), font=latin_font, fill=hex_color(palette["secondary"]) + (210,))
    draw.text((int(width * 0.075), int(height * 0.085)), descriptor, font=mono_font, fill=hex_color(palette["mutedText"]) + (150,))


def draw_label_grid(
    draw: ImageDraw.ImageDraw,
    width: int,
    height: int,
    palette: dict[str, str],
    labels: list[str],
    font: ImageFont.ImageFont,
    y: int,
    columns: int,
) -> None:
    if not labels:
        return
    columns = max(1, min(columns, 4))
    left = int(width * 0.12)
    right = int(width * 0.88)
    cell_w = (right - left) / columns
    row_h = int(height * 0.052)
    for index, label in enumerate(labels):
        col = index % columns
        row = index // columns
        x = int(left + col * cell_w)
        yy = y + row * row_h
        draw_label(draw, x, yy, label, font, palette, index)


def draw_label_column(
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    palette: dict[str, str],
    labels: list[str],
    font: ImageFont.ImageFont,
    offset: int,
) -> None:
    for index, label in enumerate(labels[:4]):
        draw_label(draw, x, y + index * 92, label, font, palette, index + offset)


def draw_visual_motifs(
    draw: ImageDraw.ImageDraw,
    width: int,
    height: int,
    palette: dict[str, str],
    motifs: list[dict[str, str]],
    composition_variant: str,
    image_mode: str,
) -> None:
    """Draw brief-owned visual subjects as marks, separate from footer labels."""
    if not motifs:
        return
    primary, secondary, tertiary = (hex_color(palette[key]) for key in ("primary", "secondary", "tertiary"))
    text = hex_color(palette["text"])
    positions = {
        "constellation": [(0.18, 0.52), (0.82, 0.50), (0.28, 0.66), (0.72, 0.65)],
        "cartographic": [(0.18, 0.52), (0.48, 0.43), (0.80, 0.58), (0.38, 0.70)],
        "orbital": [(0.64, 0.48), (0.80, 0.37), (0.55, 0.61), (0.25, 0.56)],
        "radiant-spire": [(0.16, 0.49), (0.84, 0.48), (0.20, 0.62), (0.80, 0.63)],
        "procession": [(0.16, 0.61), (0.83, 0.59), (0.23, 0.48), (0.75, 0.43)],
        "archive-seal": [(0.32, 0.66), (0.70, 0.72), (0.82, 0.31), (0.47, 0.54)],
        "overlap": [(0.23, 0.48), (0.72, 0.54), (0.35, 0.68), (0.79, 0.70)],
        "index": [(0.45, 0.42), (0.76, 0.50), (0.48, 0.62), (0.80, 0.70)],
        "split-spread": [(0.27, 0.48), (0.72, 0.48), (0.29, 0.67), (0.73, 0.68)],
        "sweep": [(0.18, 0.52), (0.82, 0.55), (0.34, 0.66), (0.68, 0.65)],
        "streamers": [(0.22, 0.45), (0.45, 0.55), (0.70, 0.44), (0.82, 0.65)],
        "cross-current": [(0.22, 0.38), (0.76, 0.40), (0.36, 0.65), (0.66, 0.68)],
        "radial": [(0.50, 0.46), (0.22, 0.55), (0.78, 0.55), (0.50, 0.66)],
        "totem": [(0.50, 0.35), (0.50, 0.49), (0.50, 0.63), (0.75, 0.55)],
        "stamp-sheet": [(0.20, 0.33), (0.50, 0.33), (0.80, 0.33), (0.20, 0.55)],
    }.get(composition_variant, [(0.16, 0.56), (0.84, 0.55), (0.23, 0.67), (0.77, 0.68)])
    size_factors = {
        "abstract-system": 0.78,
        "symbolic-object": 1.55,
        "narrative-scene": 1.05,
        "type-as-image": 0.68,
        "collaged-fragments": 1.18,
    }
    for index, motif in enumerate(motifs):
        x_ratio, y_ratio = positions[index % len(positions)]
        x, y = int(width * x_ratio), int(height * y_ratio)
        size = max(24, int(width // 34 * size_factors[image_mode]))
        color = [primary, secondary, tertiary][index % 3]
        draw_motif_symbol(draw, motif["kind"], x, y, size, color, text)
        if motif["label"]:
            font = fit_font_for_text(motif["label"], int(width * 0.18), max(16, width // 72), prefer_cjk=contains_cjk(motif["label"]))
            draw_centered(draw, (x, y + int(size * 1.65)), motif["label"], font, text + (205,))


def apply_material_finish(
    draw: ImageDraw.ImageDraw,
    width: int,
    height: int,
    palette: dict[str, str],
    rng: random.Random,
    material_language: str,
    amount: float,
) -> None:
    primary, secondary = hex_color(palette["primary"]), hex_color(palette["secondary"])
    muted = hex_color(palette["mutedText"])
    if material_language == "ink-paper":
        for _ in range(int(18 + amount * 42)):
            y = rng.randint(0, height - 1)
            draw.line((0, y, width, y + rng.randint(-3, 3)), fill=muted + (18,), width=1)
    elif material_language == "cut-paper":
        for index in range(5):
            inset = int(width * (0.018 + index * 0.012))
            draw.rectangle((inset, inset, width - inset, height - inset), outline=[primary, secondary][index % 2] + (28 + index * 7,), width=max(2, width // 650))
    elif material_language == "raw-print":
        for _ in range(int(35 + amount * 90)):
            x = rng.randint(0, width - 1)
            y = rng.randint(0, height - 1)
            radius = rng.randint(1, max(2, width // 260))
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=[primary, secondary][rng.randint(0, 1)] + (28,))
    elif material_language == "polished-metal":
        for index in range(8):
            y = int(height * (0.10 + index * 0.105))
            draw.line((0, y, width, y + int(height * 0.012)), fill=muted + (20 + index * 2,), width=max(2, height // 520))
    else:  # luminous-glass
        for index in range(4):
            inset = int(width * (0.09 + index * 0.045))
            draw.arc((inset, int(height * 0.18), width - inset, int(height * 0.78)), 195, 345, fill=[primary, secondary][index % 2] + (36,), width=max(1, width // 850))


def draw_motif_symbol(
    draw: ImageDraw.ImageDraw,
    kind: str,
    x: int,
    y: int,
    size: int,
    color: tuple[int, int, int],
    text: tuple[int, int, int],
) -> None:
    fill, outline = color + (105,), color + (220,)
    if kind == "star":
        points = []
        for index in range(10):
            angle = -math.pi / 2 + index * math.pi / 5
            radius = size if index % 2 == 0 else size * 0.42
            points.append((x + math.cos(angle) * radius, y + math.sin(angle) * radius))
        draw.polygon(points, fill=fill, outline=outline)
    elif kind == "banner":
        draw.line((x - size * 0.8, y - size, x - size * 0.8, y + size), fill=outline, width=max(2, size // 8))
        draw.polygon([(x - size * 0.72, y - size * 0.85), (x + size, y - size * 0.58), (x + size * 0.36, y + size * 0.18), (x - size * 0.72, y - size * 0.05)], fill=fill, outline=outline)
    elif kind == "figure":
        head = int(size * 0.31)
        draw.ellipse((x - head, y - size, x + head, y - size + head * 2), fill=fill, outline=outline)
        draw.line((x, y - size + head * 2, x, y + size * 0.72), fill=outline, width=max(3, size // 6))
        draw.line((x - size * 0.65, y - size * 0.1, x + size * 0.65, y - size * 0.1), fill=outline, width=max(2, size // 8))
        draw.line((x, y + size * 0.68, x - size * 0.55, y + size), fill=outline, width=max(2, size // 8))
        draw.line((x, y + size * 0.68, x + size * 0.55, y + size), fill=outline, width=max(2, size // 8))
    elif kind == "building":
        draw.rectangle((x - size * 0.7, y - size, x + size * 0.7, y + size), fill=fill, outline=outline, width=max(2, size // 10))
        for row in range(3):
            for col in range(2):
                wx = x - size * 0.38 + col * size * 0.45
                wy = y - size * 0.58 + row * size * 0.48
                draw.rectangle((wx, wy, wx + size * 0.18, wy + size * 0.2), fill=text + (145,))
    elif kind == "leaf":
        draw.ellipse((x - size * 0.45, y - size, x + size * 0.6, y + size * 0.32), fill=fill, outline=outline)
        draw.line((x - size * 0.25, y + size * 0.78, x + size * 0.35, y - size * 0.6), fill=outline, width=max(2, size // 10))
    elif kind == "orb":
        draw.ellipse((x - size, y - size, x + size, y + size), outline=outline, width=max(2, size // 9))
        draw.ellipse((x - size * 0.42, y - size * 0.42, x + size * 0.42, y + size * 0.42), outline=color + (120,), width=max(1, size // 14))
        draw.line((x - size * 1.35, y, x + size * 1.35, y), fill=color + (135,), width=max(1, size // 14))
    elif kind == "peak":
        draw.polygon([(x - size, y + size), (x, y - size), (x + size, y + size)], fill=fill, outline=outline)
        draw.polygon([(x - size * 0.28, y + size * 0.15), (x, y - size), (x + size * 0.27, y + size * 0.15)], fill=text + (105,))
    elif kind == "flight":
        draw.polygon([(x - size, y + size * 0.25), (x + size, y - size * 0.24), (x + size * 0.25, y + size * 0.12), (x + size * 0.52, y + size * 0.82)], fill=fill, outline=outline)
        draw.line((x - size * 0.35, y + size * 0.38, x - size * 0.95, y + size * 0.95), fill=text + (155,), width=max(2, size // 9))


def draw_variant_frame(
    draw: ImageDraw.ImageDraw,
    width: int,
    height: int,
    palette: dict[str, str],
    composition_variant: str,
    material_language: str,
) -> None:
    primary, secondary = hex_color(palette["primary"]), hex_color(palette["secondary"])
    frame = int(width * 0.04)
    if material_language == "raw-print":
        mark = int(width * 0.055)
        for x, y, dx, dy in ((frame, frame, mark, 0), (frame, frame, 0, mark), (width - frame, height - frame, -mark, 0), (width - frame, height - frame, 0, -mark)):
            draw.line((x, y, x + dx, y + dy), fill=secondary + (155,), width=max(3, width // 520))
        return
    if material_language == "ink-paper":
        draw.rectangle((frame, frame, width - frame, height - frame), outline=secondary + (78,), width=max(1, width // 1000))
        return
    if composition_variant in {"procession", "streamers", "cross-current"}:
        draw.line((frame, int(height * 0.11), width - frame, int(height * 0.11)), fill=primary + (120,), width=max(2, width // 700))
        draw.line((frame, int(height * 0.89), width - frame, int(height * 0.89)), fill=secondary + (120,), width=max(2, width // 700))
    elif composition_variant in {"archive-seal", "stamp-sheet", "index"}:
        draw.rectangle((frame, frame, width - frame, height - frame), outline=secondary + (135,), width=max(2, width // 800))
        inset = int(width * 0.022)
        draw.rectangle((frame + inset, frame + inset, width - frame - inset, height - frame - inset), outline=primary + (75,), width=max(1, width // 1200))
    else:
        draw.rectangle((frame, frame, width - frame, height - frame), outline=primary + (80,), width=max(2, width // 900))


def add_grain(img: Image.Image, rng: random.Random, amount: float) -> None:
    if amount <= 0:
        return
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    px = overlay.load()
    stride = max(2, int(7 - min(amount, 1.0) * 5))
    for y in range(0, img.height, stride):
        for x in range(0, img.width, stride):
            value = rng.randint(0, 255)
            alpha_max = max(4, int(18 * min(amount, 1.0)))
            alpha = rng.randint(4, alpha_max)
            px[x, y] = (value, value, value, alpha)
    img.alpha_composite(overlay) if img.mode == "RGBA" else img.paste(Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB"))


def draw_centered(draw: ImageDraw.ImageDraw, center: tuple[int, int], text: str, font: ImageFont.ImageFont, fill: tuple[int, int, int, int]) -> None:
    bbox = draw.textbbox((0, 0), text, font=font)
    draw.text((center[0] - (bbox[2] - bbox[0]) / 2, center[1] - (bbox[3] - bbox[1]) / 2), text, font=font, fill=fill)


def fit_font_for_text(text: str, max_width: int, start_size: int, prefer_cjk: bool = False) -> ImageFont.ImageFont:
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    size = max(12, start_size)
    while size >= 12:
        font = font_for_text(text, size, prefer_cjk=prefer_cjk)
        bbox = probe.textbbox((0, 0), text, font=font)
        if bbox[2] - bbox[0] <= max_width:
            return font
        size -= max(2, start_size // 12)
    return font_for_text(text, 12, prefer_cjk=prefer_cjk)


def font_height(font: ImageFont.ImageFont) -> int:
    bbox = font.getbbox("Hg")
    return bbox[3] - bbox[1]


def bezier_points(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float], steps: int) -> list[tuple[float, float]]:
    points = []
    for i in range(steps + 1):
        t = i / steps
        x = (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * b[0] + t ** 2 * c[0]
        y = (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * b[1] + t ** 2 * c[1]
        points.append((x, y))
    return points


def packaged_font(name: str, size: int) -> ImageFont.ImageFont:
    root = Path(os.environ.get("AGENTLOOP_SKILL_ROOT_CANVAS_DESIGN", Path(__file__).resolve().parents[1]))
    path = root / "canvas-fonts" / name
    if path.exists():
        return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def font_for_text(text: str, size: int, prefer_cjk: bool = False) -> ImageFont.ImageFont:
    needs_cjk = prefer_cjk or contains_cjk(text)
    candidates = []
    if needs_cjk:
        candidates.extend(system_cjk_font_candidates())
    candidates.extend(system_latin_font_candidates())
    for path, index in candidates:
        try:
            font = ImageFont.truetype(path, size, index=index)
            if glyph_smoke_check(font, text):
                return font
        except Exception:
            continue
    fallback = packaged_font("InstrumentSans-Regular.ttf", size)
    if needs_cjk and not glyph_smoke_check(fallback, text):
        raise RuntimeError("no compatible CJK font found for requested visible text")
    return fallback


def system_cjk_font_candidates() -> list[tuple[str, int]]:
    candidates: list[tuple[str, int]] = []
    pingfang = "/System/Library/AssetsV2/com_apple_MobileAsset_Font8/86ba2c91f017a3749571a82f2c6d890ac7ffb2fb.asset/AssetData/PingFang.ttc"
    candidates.extend((pingfang, index) for index in [3, 7, 11, 15, 18, 19])
    candidates.extend([
        ("/System/Library/Fonts/PingFang.ttc", 3),
        ("/System/Library/Fonts/STHeiti Light.ttc", 0),
        ("/System/Library/Fonts/STHeiti Medium.ttc", 0),
    ])
    try:
        match = subprocess.run(["fc-match", "-f", "%{file}", ":lang=zh-cn"], check=False, text=True, capture_output=True, timeout=3)
        if match.stdout.strip():
            candidates.append((match.stdout.strip(), 0))
    except Exception:
        pass
    return candidates


def system_latin_font_candidates() -> list[tuple[str, int]]:
    return [
        ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
        ("/Library/Fonts/Arial Unicode.ttf", 0),
    ]


def glyph_smoke_check(font: ImageFont.ImageFont, text: str) -> bool:
    sample = [char for char in text if not char.isspace()]
    if not sample:
        return True
    for char in sample[:80]:
        try:
            if font.getmask(char).getbbox() is None:
                return False
        except Exception:
            return False
    return True


def contains_cjk(text: str) -> bool:
    return any("\u3400" <= char <= "\u9fff" for char in text)


def clean_text(value: Any) -> str:
    return str(value).strip()[:160] if value is not None else ""


def hex_color(value: str) -> tuple[int, int, int]:
    value = value.strip().lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    if len(value) != 6:
        value = "ffffff"
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


if __name__ == "__main__":
    raise SystemExit(main())
