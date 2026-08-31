#!/usr/bin/env python3
"""Build the editable v0.9 grammar gallery and three compact proof sheets."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps
from pptx import Presentation


ROOT = Path(__file__).resolve().parents[1]
GRAMMARS = [
    ("Answer Pyramid", "arctic-minimal"),
    ("Evidence Plate", "lab-report"),
    ("Care Pathway", "executive-clinical"),
    ("Editorial Spread", "editorial-minimal"),
    ("Thesis Stage", "sunset-investor"),
    ("Operating Grid", "lavender-ops"),
    ("Public Docket", "warm-terracotta"),
    ("Telemetry Canvas", "midnight-neon"),
]
ROLE_INDEX = {
    "title": 1,
    "section": 2,
    "evidence": 3,
    "comparison": 4,
    "chart": 5,
    "table": 6,
    "decision": 7,
    "references": 8,
}
PROOF_GROUPS = {
    "narrative_structures": ("title", "section", "comparison"),
    "evidence_data_structures": ("evidence", "chart", "table"),
    "decisions_sources": ("decision", "references"),
}
PLACEHOLDER_PATTERN = re.compile(
    r"\b(?:TODO|TBD|XXX|lorem|ipsum)\b|\[(?:insert|placeholder)[^\]]*\]",
    re.IGNORECASE,
)


def _run(command: list[str]) -> str:
    result = subprocess.run(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        shell=False,
    )
    if result.returncode != 0:
        raise RuntimeError("Command failed:\n" + " ".join(command) + "\n" + result.stdout)
    return result.stdout


def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for name in names:
        if Path(name).is_file():
            return ImageFont.truetype(name, size=size)
    return ImageFont.load_default()


def _slide_path(render_dir: Path, grammar_index: int, role: str) -> Path:
    slide_number = grammar_index * len(ROLE_INDEX) + ROLE_INDEX[role]
    return render_dir / f"slide-{slide_number:02d}.jpg"


def _contact_sheet(
    render_dir: Path,
    output: Path,
    title: str,
    roles: tuple[str, ...],
    *,
    scale: int = 1,
) -> None:
    tile_w, tile_h = 260 * scale, 146 * scale
    gap = 12 * scale
    outer_gap = 24 * scale
    header_h = 84 * scale
    label_h = 42 * scale
    grammar_columns = 2
    grammar_rows = (len(GRAMMARS) + grammar_columns - 1) // grammar_columns
    block_w = len(roles) * tile_w + max(0, len(roles) - 1) * gap
    row_h = label_h + tile_h + outer_gap
    width = grammar_columns * block_w + (grammar_columns + 1) * outer_gap
    height = header_h + grammar_rows * row_h + outer_gap
    canvas = Image.new("RGB", (width, height), "#F7F8FA")
    draw = ImageDraw.Draw(canvas)
    draw.text((24 * scale, 20 * scale), title, fill="#111827", font=_font(30 * scale, True))
    for grammar_index, (grammar, preset) in enumerate(GRAMMARS):
        block_column = grammar_index % grammar_columns
        block_row = grammar_index // grammar_columns
        block_x = outer_gap + block_column * (block_w + outer_gap)
        y = header_h + block_row * row_h
        draw.text(
            (block_x, y + 2 * scale),
            f"{grammar}  |  {preset}",
            fill="#111827",
            font=_font(16 * scale, True),
        )
        for column, role in enumerate(roles):
            path = _slide_path(render_dir, grammar_index, role)
            if not path.is_file():
                raise FileNotFoundError(path)
            with Image.open(path) as source:
                tile = ImageOps.fit(
                    source.convert("RGB"),
                    (tile_w, tile_h),
                    method=Image.Resampling.LANCZOS,
                )
            x = block_x + column * (tile_w + gap)
            draw.text(
                (x, y + 24 * scale),
                role.replace("_", " ").title(),
                fill="#6B7280",
                font=_font(11 * scale, True),
            )
            canvas.paste(tile, (x, y + label_h))
            draw.rectangle(
                (x, y + label_h, x + tile_w - 1, y + label_h + tile_h - 1),
                outline="#D1D5DB",
                width=max(1, scale),
            )
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, quality=91, optimize=True)


def _placeholder_hits(pptx_path: Path) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    deck = Presentation(str(pptx_path))
    for slide_index, slide in enumerate(deck.slides, start=1):
        for shape_index, shape in enumerate(slide.shapes, start=1):
            text = " ".join(str(getattr(shape, "text", "") or "").split())
            if text and PLACEHOLDER_PATTERN.search(text):
                hits.append(
                    {"slide_index": slide_index, "shape_index": shape_index, "text": text[:160]}
                )
    return hits


def _repo_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return path.name


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--outdir", type=Path, default=Path("/tmp/presentation-skill-v0.9-showcase"))
    parser.add_argument("--proof-dir", type=Path, default=ROOT / "examples")
    args = parser.parse_args()
    outdir = args.outdir.expanduser().resolve()
    proof_dir = args.proof_dir.expanduser().resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    proof_dir.mkdir(parents=True, exist_ok=True)
    gallery = proof_dir / "v0.9_full_deck_taste_grammar_gallery.pptx"
    render_dir = outdir / "renders"

    _run(["node", "scripts/build_role_contract_showcase.js", "--output", str(gallery)])
    _run(
        [
            sys.executable,
            "scripts/render_slides.py",
            "--input",
            str(gallery),
            "--outdir",
            str(render_dir),
            "--dpi",
            "120",
            "--format",
            "jpeg",
        ]
    )
    render_count = len(list(render_dir.glob("slide-*.jpg")))
    if render_count != len(GRAMMARS) * len(ROLE_INDEX):
        raise RuntimeError(f"rendered_slide_count={render_count} expected=64")

    outputs: dict[str, str] = {}
    for name, roles in PROOF_GROUPS.items():
        output = proof_dir / f"v0.9_{name}.jpg"
        _contact_sheet(
            render_dir,
            output,
            f"v0.9 Full-Deck Taste Grammar | {name.replace('_', ' ').title()}",
            roles,
            scale=2 if name == "decisions_sources" else 1,
        )
        outputs[name] = _repo_relative(output)

    design_brief = outdir / "showcase_design_brief.json"
    design_brief.write_text(
        json.dumps(
            {
                "readability_contract": {
                    "min_title_pt": 20.0,
                    "min_body_pt": 8.0,
                    "min_caption_pt": 6.5,
                    "chart_label_min_pt": 7.5,
                    "footer_reserved_inches": 0.25,
                }
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    design_qa = outdir / "design_rules_qa.json"
    design_result = subprocess.run(
        [
            sys.executable,
            "scripts/design_rules_qa.py",
            "--input",
            str(gallery),
            "--design-brief",
            str(design_brief),
            "--report",
            str(design_qa),
        ],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        shell=False,
    )
    design_payload = json.loads(design_qa.read_text(encoding="utf-8"))
    placeholder_hits = _placeholder_hits(gallery)
    visual_review_path = proof_dir / "v0.9_full_deck_taste_grammar_visual_review.json"
    visual_review: dict[str, Any] = {}
    if visual_review_path.is_file():
        candidate = json.loads(visual_review_path.read_text(encoding="utf-8"))
        if isinstance(candidate, dict):
            visual_review = candidate
    passed = (
        design_result.returncode == 0
        and int(design_payload.get("issue_count") or 0) == 0
        and not placeholder_hits
        and (not visual_review or bool(visual_review.get("passed")))
    )
    manifest = {
        "schema_version": "role-contract-showcase-v1",
        "passed": passed,
        "topic": "Cooling the Last 5 Degrees: Urban Heat Resilience Pilot",
        "gallery": _repo_relative(gallery),
        "editable_slide_count": 64,
        "grammars": [
            {"label": grammar, "preset": preset} for grammar, preset in GRAMMARS
        ],
        "contact_sheets": outputs,
        "design_qa": "transient-build/design_rules_qa.json",
        "design_issue_count": int(design_payload.get("issue_count") or 0),
        "placeholder_hits": placeholder_hits,
    }
    if visual_review:
        manifest["visual_review"] = _repo_relative(visual_review_path)
        manifest["visual_review_passed"] = bool(visual_review.get("passed"))
        manifest["visual_review_warning_count"] = int(visual_review.get("warning_count") or 0)
        manifest["contact_sheet_warning_count"] = int(
            visual_review.get("contact_sheet_warning_count") or 0
        )
    manifest_path = proof_dir / "v0.9_full_deck_taste_grammar_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
