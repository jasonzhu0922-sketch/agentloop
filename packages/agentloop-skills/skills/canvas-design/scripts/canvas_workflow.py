#!/usr/bin/env python3
"""Package-owned production workflow for canvas-design.

The document is deliberately data-first: it preserves a brief contract and art
direction across model turns, while this module owns rendering mechanics, CJK
font selection, export, and structural inspection.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
STATIC_RENDERER_PATH = ROOT / "scripts" / "render_static_canvas.py"
CANVAS_CJK_FONT = ROOT / "assets" / "fonts" / "NotoSansSC.ttf"
DOCUMENT_SCHEMA = "agentloop.canvasDesignDocument/v1"


def static_renderer() -> Any:
    spec = importlib.util.spec_from_file_location("canvas_static_renderer", STATIC_RENDERER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("canvas static renderer is unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


RENDERER = static_renderer()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def load_document(path_text: str) -> tuple[Path, dict[str, Any]]:
    path = Path(path_text).resolve()
    if not path.is_file():
        raise ValueError(f"design document does not exist: {path}")
    try:
        document = json.loads(path.read_text("utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"design document is not valid JSON: {error.msg}") from error
    if not isinstance(document, dict):
        raise ValueError("design document must be a JSON object")
    return path, document


def require_text(value: Any, label: str, maximum: int = 400) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{label} must be a non-empty string of at most {maximum} characters")
    return value.strip()


def normalized_rect(value: Any, label: str) -> dict[str, float]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object with x, y, width, and height")
    rect: dict[str, float] = {}
    for key in ("x", "y", "width", "height"):
        raw = value.get(key)
        if not isinstance(raw, (int, float)) or isinstance(raw, bool):
            raise ValueError(f"{label}.{key} must be a number")
        rect[key] = float(raw)
    if rect["x"] < 0 or rect["y"] < 0 or rect["width"] <= 0 or rect["height"] <= 0:
        raise ValueError(f"{label} must have a non-negative origin and positive size")
    if rect["x"] + rect["width"] > 1 or rect["y"] + rect["height"] > 1:
        raise ValueError(f"{label} must fit within the normalized canvas")
    return rect


def rect_pixels(rect: dict[str, float], width: int, height: int) -> tuple[int, int, int, int]:
    return (
        round(rect["x"] * width),
        round(rect["y"] * height),
        round((rect["x"] + rect["width"]) * width),
        round((rect["y"] + rect["height"]) * height),
    )


def resolve_output(document_path: Path, document: dict[str, Any]) -> Path:
    output = document.get("output")
    output_path = output.get("path") if isinstance(output, dict) else None
    output_text = require_text(output_path, "output.path", 500)
    relative = Path(output_text)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("output.path must be a relative path below the design document directory")
    target = (document_path.parent / relative).resolve()
    if document_path.parent not in target.parents:
        raise ValueError("output.path escapes the design document directory")
    if target.suffix.lower() != ".png":
        raise ValueError("output.path must name a PNG")
    return target


def validate_document(document_path: Path, document: dict[str, Any]) -> dict[str, Any]:
    if document.get("schema") != DOCUMENT_SCHEMA:
        raise ValueError(f"schema must be {DOCUMENT_SCHEMA}")
    contract = document.get("briefContract")
    if not isinstance(contract, dict):
        raise ValueError("briefContract must be an object")
    mandatory_copy = contract.get("mandatoryCopy")
    if not isinstance(mandatory_copy, list) or not mandatory_copy:
        raise ValueError("briefContract.mandatoryCopy must contain at least one visible string")
    copy = [require_text(value, f"briefContract.mandatoryCopy[{index}]") for index, value in enumerate(mandatory_copy)]
    art_direction = document.get("artDirection")
    normalized_direction = RENDERER.normalize_art_direction(art_direction)
    if normalized_direction is None:
        raise ValueError("artDirection must contain every supported explicit visual axis")
    canvas = document.get("canvas") if isinstance(document.get("canvas"), dict) else {}
    width = int(canvas.get("width", 1800))
    height = int(canvas.get("height", 2700))
    if not 900 <= width <= 3600 or not 1200 <= height <= 5400:
        raise ValueError("canvas dimensions must be within 900-3600 by 1200-5400")
    sections = document.get("sections")
    if not isinstance(sections, list) or not sections:
        raise ValueError("sections must contain at least one positioned section")
    normalized_sections = []
    ids = set()
    for index, section in enumerate(sections):
        if not isinstance(section, dict):
            raise ValueError(f"sections[{index}] must be an object")
        section_id = require_text(section.get("id"), f"sections[{index}].id", 80)
        if section_id in ids:
            raise ValueError(f"sections contains duplicate id: {section_id}")
        ids.add(section_id)
        normalized_sections.append({
            "id": section_id,
            "kind": require_text(section.get("kind", "content"), f"sections[{index}].kind", 80),
            "rect": normalized_rect(section.get("rect"), f"sections[{index}].rect"),
            "title": str(section.get("title", "")).strip()[:300],
            "copy": str(section.get("copy", "")).strip()[:1200],
            "items": [str(item).strip()[:160] for item in section.get("items", []) if str(item).strip()][:12],
        })
    zones = contract.get("reservedZones", [])
    if not isinstance(zones, list):
        raise ValueError("briefContract.reservedZones must be an array")
    normalized_zones = []
    zone_ids = set()
    for index, zone in enumerate(zones):
        if not isinstance(zone, dict):
            raise ValueError(f"briefContract.reservedZones[{index}] must be an object")
        zone_id = require_text(zone.get("id"), f"briefContract.reservedZones[{index}].id", 80)
        if zone_id in zone_ids:
            raise ValueError(f"briefContract.reservedZones contains duplicate id: {zone_id}")
        zone_ids.add(zone_id)
        normalized_zones.append({
            "id": zone_id,
            "label": require_text(zone.get("label"), f"briefContract.reservedZones[{index}].label", 160),
            "rect": normalized_rect(zone.get("rect"), f"briefContract.reservedZones[{index}].rect"),
            "clearance": float(zone.get("clearance", 0.02)),
        })
    destinations = contract.get("copyDestinations")
    if not isinstance(destinations, list):
        raise ValueError("briefContract.copyDestinations must map every mandatory copy item to a rendered section field")
    section_by_id = {section["id"]: section for section in normalized_sections}
    mapped_copy: list[str] = []
    normalized_destinations = []
    for index, destination in enumerate(destinations):
        if not isinstance(destination, dict):
            raise ValueError(f"briefContract.copyDestinations[{index}] must be an object")
        copy_text = require_text(destination.get("copy"), f"briefContract.copyDestinations[{index}].copy")
        section_id = require_text(destination.get("sectionId"), f"briefContract.copyDestinations[{index}].sectionId", 80)
        field = require_text(destination.get("field"), f"briefContract.copyDestinations[{index}].field", 20)
        section = section_by_id.get(section_id)
        if section is None:
            raise ValueError(f"briefContract.copyDestinations[{index}] references unknown section: {section_id}")
        rendered_values = [section["title"], section["copy"], *section["items"]]
        if field not in {"title", "copy", "items"} or copy_text not in rendered_values:
            raise ValueError(f"briefContract.copyDestinations[{index}] must identify text rendered by its section")
        mapped_copy.append(copy_text)
        normalized_destinations.append({"copy": copy_text, "sectionId": section_id, "field": field})
    if sorted(mapped_copy) != sorted(copy) or len(set(mapped_copy)) != len(copy):
        raise ValueError("briefContract.copyDestinations must map each mandatoryCopy item exactly once")
    return {
        "schema": "agentloop.canvasDesignDocumentValidation/v1",
        "documentPath": str(document_path),
        "documentSha256": sha256(document_path),
        "outputPath": str(resolve_output(document_path, document)),
        "canvas": {"width": width, "height": height},
        "mandatoryCopy": copy,
        "copyDestinations": normalized_destinations,
        "sections": normalized_sections,
        "reservedZones": normalized_zones,
        "artDirection": normalized_direction,
    }


def cjk_profile(sample: str) -> dict[str, Any]:
    if not CANVAS_CJK_FONT.is_file():
        raise RuntimeError(f"bundled canvas CJK font is unavailable: {CANVAS_CJK_FONT}")
    font = RENDERER.ImageFont.truetype(str(CANVAS_CJK_FONT), 36)
    if not RENDERER.glyph_smoke_check(font, sample):
        raise RuntimeError("bundled canvas CJK font failed the glyph smoke check")
    return {
        "packageAsset": "assets/fonts/NotoSansSC.ttf",
        "sha256": sha256(CANVAS_CJK_FONT),
        "name": list(font.getname()),
        "glyphCoverage": "smoke-passed",
    }


def preflight(report_path: str) -> None:
    target = Path(report_path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    profile = {
        "schema": "agentloop.canvasRuntimeProfile/v1",
        "pillow": getattr(Image, "__version__", "available"),
        "rendererSchema": RENDERER.SPEC_SCHEMA["schema"],
        "fontRoles": {
            "cjk-visible-copy": cjk_profile("画布设计字体预检：中文 English 0123456789"),
            "latin-display": {"packageAsset": "canvas-fonts/InstrumentSans-Regular.ttf"},
        },
        "glyphCoverage": "smoke-passed",
    }
    target.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", "utf-8")
    emit({**profile, "reportPath": str(target), "reportSha256": sha256(target)})


def render_document(validation: dict[str, Any], document: dict[str, Any]) -> None:
    target = Path(validation["outputPath"])
    target.parent.mkdir(parents=True, exist_ok=True)
    sections = validation["sections"]
    hero = next((section for section in sections if section["kind"] == "hero"), sections[0])
    labels = [item for section in sections for item in section["items"]][:8]
    render_spec = {
        "title": hero["title"] or validation["mandatoryCopy"][0],
        "subtitle": hero["copy"],
        "output": "ignored-by-workflow.png",
        "movement": document.get("movement", "Canvas Production"),
        "artDirection": validation["artDirection"],
        "canvas": validation["canvas"],
        "labels": labels,
        "visualMotifs": document.get("visualMotifs", []),
        "seed": int(document.get("seed", 311)),
        "texture": float(document.get("texture", 0.18)),
        "density": float(document.get("density", 0.58)),
    }
    image, layout_family, variant, motifs, _, _ = RENDERER.render(render_spec)
    image = image.convert("RGBA")
    draw = ImageDraw.Draw(image, "RGBA")
    width, height = image.size
    font_profile = cjk_profile("".join(validation["mandatoryCopy"]))

    # The static renderer owns mood and subject grammar. The production scaffold
    # owns deterministic brief sections and replaceable zones above that base.
    for section in sections:
        x0, y0, x1, y1 = rect_pixels(section["rect"], width, height)
        draw.rounded_rectangle((x0, y0, x1, y1), radius=max(12, min(width, height) // 90), fill=(255, 255, 255, 210), outline=(28, 33, 35, 170), width=max(2, width // 700))
        padding = max(16, width // 50)
        title = section["title"]
        copy = section["copy"]
        if title:
            font = RENDERER.fit_font_for_text(title, max(20, x1 - x0 - padding * 2), max(26, width // 26), prefer_cjk=True)
            draw.text((x0 + padding, y0 + padding), title, font=font, fill=(22, 28, 30, 255))
        if copy:
            font = RENDERER.fit_font_for_text(copy, max(20, x1 - x0 - padding * 2), max(20, width // 45), prefer_cjk=True)
            draw.text((x0 + padding, y0 + padding + max(42, width // 18)), copy, font=font, fill=(53, 60, 60, 255))
        if section["items"]:
            item_font = RENDERER.fit_font_for_text("中", max(20, x1 - x0 - padding * 2), max(18, width // 52), prefer_cjk=True)
            cursor_y = y1 - padding - len(section["items"]) * max(28, width // 30)
            for item in section["items"]:
                draw.text((x0 + padding, cursor_y), f"• {item}", font=item_font, fill=(35, 45, 44, 255))
                cursor_y += max(28, width // 30)
    for zone in validation["reservedZones"]:
        x0, y0, x1, y1 = rect_pixels(zone["rect"], width, height)
        draw.rounded_rectangle((x0, y0, x1, y1), radius=max(10, width // 100), fill=(255, 255, 255, 245), outline=(15, 20, 22, 230), width=max(3, width // 450))
        label_font = RENDERER.fit_font_for_text(zone["label"], max(20, x1 - x0 - 30), max(18, width // 48), prefer_cjk=True)
        draw.text(((x0 + x1) // 2, (y0 + y1) // 2), zone["label"], font=label_font, fill=(25, 31, 31, 255), anchor="mm")
    image.convert("RGB").save(target, "PNG", optimize=True)
    with Image.open(target) as opened:
        opened.verify()
    emit({
        "schema": "agentloop.canvasDesignProductionReceipt/v1",
        "documentPath": validation["documentPath"],
        "documentSha256": validation["documentSha256"],
        "artifactPath": str(target),
        "artifactSha256": sha256(target),
        "bytes": target.stat().st_size,
        "width": width,
        "height": height,
        "layoutFamily": layout_family,
        "compositionVariant": variant,
        "visualMotifs": motifs,
        "fontProfile": font_profile,
        "briefContract": {"mandatoryCopyCount": len(validation["mandatoryCopy"]), "copyDestinations": validation["copyDestinations"], "sectionIds": [section["id"] for section in sections], "reservedZoneIds": [zone["id"] for zone in validation["reservedZones"]]},
        "evidenceKinds": {"satisfied": ["artifact_path", "artifact_non_empty", "format_matches_request", "artifact_openable"], "caveated": [], "failed": []},
    })


def inspect_document(validation: dict[str, Any]) -> None:
    target = Path(validation["outputPath"])
    if not target.is_file() or target.stat().st_size == 0:
        raise ValueError("rendered PNG is absent or empty")
    with Image.open(target) as image:
        image.verify()
    with Image.open(target) as image:
        width, height = image.size
    expected = validation["canvas"]
    if (width, height) != (expected["width"], expected["height"]):
        raise ValueError("rendered PNG dimensions do not match the design document")
    emit({
        "schema": "agentloop.canvasDesignInspection/v1",
        "documentPath": validation["documentPath"],
        "artifactPath": str(target),
        "artifactSha256": sha256(target),
        "image": {"format": "PNG", "width": width, "height": height, "openable": True},
        "briefContract": {"mandatoryCopyMapped": validation["copyDestinations"], "sectionIds": [section["id"] for section in validation["sections"]], "reservedZones": validation["reservedZones"]},
        "evidenceKinds": {"satisfied": ["canvas_visual_contract"], "caveated": [], "failed": []},
        "caveat": "Structural inspection does not replace human visual review of hierarchy, legibility, or creative quality.",
    })


def main() -> int:
    parser = argparse.ArgumentParser(description="Canvas design production workflow")
    subcommands = parser.add_subparsers(dest="action", required=True)
    preflight_parser = subcommands.add_parser("preflight")
    preflight_parser.add_argument("--report", required=True)
    for name in ("validate", "render", "inspect"):
        action = subcommands.add_parser(name)
        action.add_argument("design_path")
    args = parser.parse_args()
    if args.action == "preflight":
        preflight(args.report)
        return 0
    document_path, document = load_document(args.design_path)
    validation = validate_document(document_path, document)
    if args.action == "validate":
        emit(validation)
    elif args.action == "render":
        render_document(validation, document)
    else:
        inspect_document(validation)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
