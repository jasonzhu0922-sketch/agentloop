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

SPEC_SCHEMA = {
    "schema": "agentloop.canvasDesignSpec/v1",
    "fields": {
        "output": "Relative PNG output path under the workspace.",
        "title": "Visible primary title, CJK-safe.",
        "subtitle": "Visible secondary phrase, CJK-safe.",
        "movement": "Short Latin style marker for the upper-left label.",
        "layoutFamily": "Optional composition grammar: signal-field, monument-axis, editorial-blocks, kinetic-ribbons, or emblem-grid.",
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
        "texture": "0.0-1.0 grain intensity.",
        "density": "0.1-1.0 field density.",
        "seed": "Integer deterministic composition seed.",
        "canvas": {"width": "900-3600", "height": "1200-5400"},
    },
    "layoutFamilies": LAYOUT_FAMILIES,
    "example": {
        "output": "poster.png",
        "title": "城市更新论坛",
        "subtitle": "连接空间 · 技术 · 公共生活",
        "movement": "Civic Pulse",
        "layoutFamily": "editorial-blocks",
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

    image, layout_family = render(spec)
    image.save(output, "PNG", optimize=True)
    print(json.dumps({
        "schema": "agentloop.canvasDesignRender/v1",
        "artifactPath": str(output),
        "width": image.width,
        "height": image.height,
        "layoutFamily": layout_family,
    }, ensure_ascii=False))
    return 0


def render(spec: dict[str, Any]) -> tuple[Image.Image, str]:
    seed = int(spec.get("seed", 42))
    rng = random.Random(seed)
    canvas = spec.get("canvas") if isinstance(spec.get("canvas"), dict) else {}
    width = int(canvas.get("width", DEFAULT_CANVAS["width"]))
    height = int(canvas.get("height", DEFAULT_CANVAS["height"]))
    width = max(900, min(width, 3600))
    height = max(1200, min(height, 5400))

    palette = dict(DEFAULT_PALETTE)
    if isinstance(spec.get("palette"), dict):
        palette.update({k: v for k, v in spec["palette"].items() if isinstance(v, str)})

    layout_family = normalize_layout_family(spec.get("layoutFamily") or spec.get("layout_family") or auto_layout_family(spec))

    img = Image.new("RGB", (width, height), hex_color(palette["backgroundTop"]))
    draw_gradient(img, hex_color(palette["backgroundTop"]), hex_color(palette["backgroundBottom"]))
    draw = ImageDraw.Draw(img, "RGBA")

    texture = float(spec.get("texture", 0.35))
    density = float(spec.get("density", 0.72))

    title = clean_text(spec.get("title", "Untitled"))
    subtitle = clean_text(spec.get("subtitle", ""))
    movement = clean_text(spec.get("movement", "Visual System"))
    labels = [clean_text(item) for item in spec.get("labels", []) if clean_text(item)][:8]

    title_font = fit_font_for_text(title, int(width * 0.86), max(58, width // 15), prefer_cjk=True)
    subtitle_font = fit_font_for_text(subtitle or title, int(width * 0.72), max(24, width // 38), prefer_cjk=contains_cjk(subtitle))
    latin_font = packaged_font("Jura-Light.ttf", max(22, width // 70))
    mono_font = packaged_font("GeistMono-Regular.ttf", max(16, width // 110))
    label_font = fit_font_for_text(max(labels, key=len) if labels else title, int(width * 0.24), max(24, width // 40), prefer_cjk=True)

    if layout_family == "monument-axis":
        draw_monument_axis(draw, width, height, palette, rng, density, title, subtitle, movement, labels, title_font, subtitle_font, label_font, latin_font, mono_font)
    elif layout_family == "editorial-blocks":
        draw_editorial_blocks(draw, width, height, palette, rng, density, title, subtitle, movement, labels, title_font, subtitle_font, label_font, latin_font, mono_font)
    elif layout_family == "kinetic-ribbons":
        draw_kinetic_ribbons(draw, width, height, palette, rng, density, title, subtitle, movement, labels, title_font, subtitle_font, label_font, latin_font, mono_font)
    elif layout_family == "emblem-grid":
        draw_emblem_grid(draw, width, height, palette, rng, density, title, subtitle, movement, labels, title_font, subtitle_font, label_font, latin_font, mono_font)
    else:
        draw_signal_field(draw, width, height, palette, rng, density, title, subtitle, movement, labels, title_font, subtitle_font, label_font, latin_font, mono_font)

    add_grain(img, rng, texture)
    frame = int(width * 0.04)
    draw.rectangle((frame, frame, width - frame, height - frame), outline=hex_color(palette["primary"]) + (80,), width=max(2, width // 900))
    return img, layout_family


def normalize_layout_family(value: Any) -> str:
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
    return candidate if candidate in LAYOUT_FAMILIES else "signal-field"


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
) -> None:
    draw_field(draw, width, height, palette, rng, density)
    draw_meridians(draw, width, height, palette, rng, density)
    draw_metadata(draw, width, height, palette, movement, "SIGNAL FIELD MAP", latin_font, mono_font)

    title_y = int(height * 0.125)
    draw_centered(draw, (width // 2, title_y), title, title_font, hex_color(palette["text"]) + (245,))
    if subtitle:
        draw_centered(draw, (width // 2, title_y + int(width * 0.07)), subtitle, subtitle_font, hex_color(palette["mutedText"]) + (220,))

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
) -> None:
    primary = hex_color(palette["primary"])
    secondary = hex_color(palette["secondary"])
    tertiary = hex_color(palette["tertiary"])
    text = hex_color(palette["text"])
    muted = hex_color(palette["mutedText"])
    draw_metadata(draw, width, height, palette, movement, "MONUMENT AXIS", latin_font, mono_font)

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
) -> None:
    primary = hex_color(palette["primary"])
    secondary = hex_color(palette["secondary"])
    tertiary = hex_color(palette["tertiary"])
    text = hex_color(palette["text"])
    muted = hex_color(palette["mutedText"])
    draw_metadata(draw, width, height, palette, movement, "EDITORIAL BLOCK STUDY", latin_font, mono_font)

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
) -> None:
    primary = hex_color(palette["primary"])
    secondary = hex_color(palette["secondary"])
    tertiary = hex_color(palette["tertiary"])
    text = hex_color(palette["text"])
    muted = hex_color(palette["mutedText"])
    draw_metadata(draw, width, height, palette, movement, "KINETIC RIBBON FIELD", latin_font, mono_font)

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
) -> None:
    primary = hex_color(palette["primary"])
    secondary = hex_color(palette["secondary"])
    tertiary = hex_color(palette["tertiary"])
    text = hex_color(palette["text"])
    muted = hex_color(palette["mutedText"])
    draw_metadata(draw, width, height, palette, movement, "EMBLEM GRID", latin_font, mono_font)

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


def add_grain(img: Image.Image, rng: random.Random, amount: float) -> None:
    if amount <= 0:
        return
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    px = overlay.load()
    stride = max(2, int(7 - min(amount, 1.0) * 5))
    for y in range(0, img.height, stride):
        for x in range(0, img.width, stride):
            value = rng.randint(0, 255)
            alpha = rng.randint(4, int(18 * min(amount, 1.0)))
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
