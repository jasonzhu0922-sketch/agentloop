#!/usr/bin/env python3
"""Focused renderer smoke for title restraint, KPI contrast, and rare forms."""

from __future__ import annotations

import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE


ROOT = Path(__file__).resolve().parent.parent
EMU_PER_INCH = 914400


def _run(*parts: str) -> str:
    result = subprocess.run(parts, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode != 0:
        raise RuntimeError("Command failed:\n" + " ".join(parts) + "\n" + result.stdout)
    return result.stdout


def _linear(channel: int) -> float:
    value = channel / 255
    return value / 12.92 if value <= 0.03928 else math.pow((value + 0.055) / 1.055, 2.4)


def _luminance(hex_color: str) -> float:
    raw = hex_color.replace("#", "")
    r, g, b = (int(raw[index : index + 2], 16) for index in (0, 2, 4))
    return 0.2126 * _linear(r) + 0.7152 * _linear(g) + 0.0722 * _linear(b)


def _contrast(left: str, right: str) -> float:
    a = _luminance(left)
    b = _luminance(right)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def _shape_text(shape: object) -> str:
    return str(getattr(shape, "text", "") or "").strip()


def main() -> int:
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="presentation-skill-renderer-taste-") as tmp:
        root = Path(tmp)
        image_path = root / "synthetic_concept.png"
        image = Image.new("RGB", (1200, 675), "#EAF4F4")
        draw = ImageDraw.Draw(image)
        draw.rectangle((65, 65, 1135, 610), outline="#0F766E", width=6)
        draw.line((130, 520, 330, 420, 560, 445, 780, 260, 1040, 180), fill="#0F766E", width=14)
        for x, y in [(130, 520), (330, 420), (560, 445), (780, 260), (1040, 180)]:
            draw.ellipse((x - 20, y - 20, x + 20, y + 20), fill="#F59E0B")
        image.save(image_path)

        outline = {
            "deck_style": {"title_layout": "masthead"},
            "slides": [
                {
                    "type": "title",
                    "title_layout": "masthead",
                    "title": "Museum Membership Renewal",
                    "subtitle": "Typography and whitespace carry the cover when no proof object is available.",
                },
                {
                    "type": "section",
                    "title": "Evidence and decision",
                    "subtitle": "A purposeful section turn",
                    "bullets": ["Signal", "Tradeoff", "Action"],
                },
                {
                    "type": "content",
                    "variant": "kpi-hero",
                    "title": "Partner payback remains inside the target window",
                    "value": "13mo",
                    "label": "partner payback",
                    "context": "Synthetic unit-economics fixture.",
                },
                {
                    "type": "content",
                    "variant": "generated-image",
                    "title": "Generated concept visual",
                    "subtitle": "Standalone, labeled, and removable",
                    "assets": {"generated_image": str(image_path)},
                    "image_generation": {
                        "prompt": "Synthetic trend concept used for renderer coverage.",
                        "model": "local-synthetic-fixture",
                        "purpose": "Positive generated-image rendering proof",
                    },
                },
            ],
        }
        outline_path = root / "outline.json"
        outline_path.write_text(json.dumps(outline, indent=2) + "\n", encoding="utf-8")
        pptx_path = root / "renderer_taste.pptx"
        qa_dir = root / "qa"
        _run(
            "node",
            "scripts/build_deck_pptxgenjs.js",
            "--outline",
            str(outline_path),
            "--output",
            str(pptx_path),
            "--style-preset",
            "sunset-investor",
        )
        _run(
            sys.executable,
            "scripts/qa_gate.py",
            "--input",
            str(pptx_path),
            "--outdir",
            str(qa_dir),
            "--style-preset",
            "sunset-investor",
            "--strict-geometry",
            "--skip-render",
            "--skip-manual-review",
            "--outline",
            str(outline_path),
            "--report",
            str(qa_dir / "report.json"),
        )

        prs = Presentation(str(pptx_path))
        if len(prs.slides) != 4:
            failures.append(f"slide_count={len(prs.slides)} expected=4")

        title_slide = prs.slides[0]
        placeholder_blocks = []
        for shape in title_slide.shapes:
            x = shape.left / EMU_PER_INCH
            y = shape.top / EMU_PER_INCH
            w = shape.width / EMU_PER_INCH
            h = shape.height / EMU_PER_INCH
            if 6.5 <= x <= 7.0 and 1.0 <= y <= 1.4 and w >= 1.5 and h >= 3.0:
                placeholder_blocks.append({"x": x, "y": y, "w": w, "h": h, "text": _shape_text(shape)})
        if placeholder_blocks:
            failures.append(f"masthead contains empty fallback block: {placeholder_blocks}")

        kpi_slide = prs.slides[2]
        kpi_shape = next((shape for shape in kpi_slide.shapes if "13mo" in _shape_text(shape)), None)
        kpi_color = ""
        if kpi_shape is None:
            failures.append("missing KPI value shape")
        else:
            for paragraph in kpi_shape.text_frame.paragraphs:
                for run in paragraph.runs:
                    if "13mo" not in run.text:
                        continue
                    rgb = run.font.color.rgb
                    if rgb is not None:
                        kpi_color = str(rgb)
                    break
        ratio = _contrast(kpi_color, "431407") if kpi_color else 0.0
        if ratio < 4.5:
            failures.append(f"KPI contrast={ratio:.2f} color={kpi_color or '<missing>'}")

        generated_slide = prs.slides[3]
        picture_count = len([shape for shape in generated_slide.shapes if shape.shape_type == MSO_SHAPE_TYPE.PICTURE])
        generated_text = " ".join(_shape_text(shape) for shape in generated_slide.shapes)
        if picture_count < 1:
            failures.append("generated-image slide contains no picture")
        for required in ("Generated concept visual", "local-synthetic-fixture", "Positive generated-image rendering proof"):
            if required not in generated_text:
                failures.append(f"generated-image slide missing metadata text: {required}")

        qa = json.loads((qa_dir / "report.json").read_text(encoding="utf-8"))
        for key in ("overflow_count", "overlap_count", "geometry_error_count", "design_error_count"):
            if int(qa.get(key) or 0):
                failures.append(f"{key}={qa.get(key)}")

        result = {
            "passed": not failures,
            "slide_count": len(prs.slides),
            "masthead_placeholder_blocks": placeholder_blocks,
            "kpi_color": kpi_color,
            "kpi_contrast_ratio": round(ratio, 3),
            "generated_image_picture_count": picture_count,
            "qa_counts": {key: qa.get(key) for key in ("overflow_count", "overlap_count", "geometry_error_count", "design_error_count")},
            "failures": failures,
        }
        print(json.dumps(result, indent=2))
        return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
