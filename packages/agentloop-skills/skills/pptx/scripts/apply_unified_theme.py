"""Safely apply a declarative visual theme to an existing PPTX.

This is the Skill-owned path for a request such as "apply one unified visual
theme while preserving the existing deck". It changes only OOXML colour and
font nodes, preserves slide text and package parts, and refuses to emit an
invalid archive.

Usage:
  python apply_unified_theme.py inventory source.pptx --report inventory.json
  python apply_unified_theme.py apply source.pptx themed.pptx \
      --theme theme.json --report receipt.json --require-complete-color-map
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
import tempfile
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any

import defusedxml.minidom


A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
COLOUR_ROLES = (
    "dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3",
    "accent4", "accent5", "accent6", "hlink", "folHlink",
)
HEX = re.compile(r"^[0-9A-Fa-f]{6}$")
class ThemeError(ValueError):
    """A user-visible theme contract violation."""


def _fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(2)


def _normal_hex(value: Any, label: str) -> str:
    if not isinstance(value, str) or HEX.fullmatch(value) is None:
        raise ThemeError(f"{label} must be a six-digit RGB value without #")
    return value.upper()


def _normal_font(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ThemeError(f"{label} must be a non-empty font name")
    return value.strip()


def load_theme(path: Path) -> dict[str, Any]:
    try:
        raw: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ThemeError(f"cannot read theme config: {exc}") from exc
    if not isinstance(raw, dict):
        raise ThemeError("theme config must be a JSON object")

    if not isinstance(raw.get("name"), str) or not raw["name"].strip():
        raise ThemeError("theme.name must be a non-empty string")
    colors = raw.get("colors")
    if not isinstance(colors, dict):
        raise ThemeError("theme.colors must be an object")
    missing_roles = [role for role in COLOUR_ROLES if role not in colors]
    if missing_roles:
        raise ThemeError(f"theme.colors is missing: {', '.join(missing_roles)}")
    normalized_colors = {role: _normal_hex(colors[role], f"theme.colors.{role}") for role in COLOUR_ROLES}

    color_map = raw.get("colorMap")
    if not isinstance(color_map, dict):
        raise ThemeError("theme.colorMap must be an object")
    normalized_map = {
        _normal_hex(source, "theme.colorMap key"): _normal_hex(target, f"theme.colorMap.{source}")
        for source, target in color_map.items()
    }

    fonts = raw.get("fonts")
    if not isinstance(fonts, dict):
        raise ThemeError("theme.fonts must be an object")
    normalized_fonts = {
        "latin": _normal_font(fonts.get("latin"), "theme.fonts.latin"),
        "eastAsian": _normal_font(fonts.get("eastAsian"), "theme.fonts.eastAsian"),
    }
    return {
        "name": raw["name"].strip(),
        "colors": normalized_colors,
        "colorMap": normalized_map,
        "fonts": normalized_fonts,
    }


def _part_is_xml(name: str) -> bool:
    return name.startswith("ppt/") and name.lower().endswith(".xml")


def _is_unreferenced_trash_part(name: str) -> bool:
    # PowerPoint packages occasionally contain this known, unreferenced staging
    # directory. It is not user content and `clean.py` removes the same parts.
    return name.startswith("[trash]/")


def _parse_xml(data: bytes, part: str):
    try:
        return defusedxml.minidom.parseString(data)
    except Exception as exc:  # defusedxml has multiple parser exception types.
        raise ThemeError(f"invalid XML in {part}: {exc}") from exc


def _text_runs(dom) -> list[str]:
    return [node.firstChild.data if node.firstChild is not None else "" for node in dom.getElementsByTagNameNS(A_NS, "t")]


def _inventory_from_archive(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.suffix.lower() != ".pptx":
        raise ThemeError(f"input must be an existing .pptx file: {path}")
    try:
        with zipfile.ZipFile(path) as archive:
            corrupt = archive.testzip()
            if corrupt is not None:
                raise ThemeError(f"archive CRC failed for {corrupt}")
            names = archive.namelist()
            colours: Counter[str] = Counter()
            latin_fonts: Counter[str] = Counter()
            east_asian_fonts: Counter[str] = Counter()
            text_by_part: dict[str, list[str]] = {}
            for name in names:
                if not _part_is_xml(name):
                    continue
                dom = _parse_xml(archive.read(name), name)
                for node in dom.getElementsByTagNameNS(A_NS, "srgbClr"):
                    value = node.getAttribute("val")
                    if HEX.fullmatch(value):
                        colours[value.upper()] += 1
                for node in dom.getElementsByTagNameNS(A_NS, "latin"):
                    value = node.getAttribute("typeface")
                    if value:
                        latin_fonts[value] += 1
                for node in dom.getElementsByTagNameNS(A_NS, "ea"):
                    value = node.getAttribute("typeface")
                    if value:
                        east_asian_fonts[value] += 1
                if name.startswith("ppt/slides/"):
                    text_by_part[name] = _text_runs(dom)
    except (OSError, zipfile.BadZipFile) as exc:
        raise ThemeError(f"cannot read PPTX archive: {exc}") from exc
    return {
        "schema": "pptx.unifiedThemeInventory/v1",
        "input": str(path),
        "slideCount": len([name for name in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)]),
        "partCount": len(names),
        "contentPartNames": sorted(name for name in names if not _is_unreferenced_trash_part(name)),
        "explicitColors": dict(sorted(colours.items(), key=lambda item: (-item[1], item[0]))),
        "latinFonts": dict(sorted(latin_fonts.items(), key=lambda item: (-item[1], item[0]))),
        "eastAsianFonts": dict(sorted(east_asian_fonts.items(), key=lambda item: (-item[1], item[0]))),
        "textBySlide": text_by_part,
    }


def _replace_theme_scheme(dom, theme: dict[str, Any]) -> bool:
    changed = False
    for scheme in dom.getElementsByTagNameNS(A_NS, "clrScheme"):
        scheme.setAttribute("name", theme["name"])
        # Preserve extension nodes and any future non-colour metadata. Replacing
        # all children would silently discard them from otherwise valid themes.
        old_roles = [
            child
            for child in scheme.childNodes
            if child.nodeType == child.ELEMENT_NODE
            and child.namespaceURI == A_NS
            and child.localName in COLOUR_ROLES
        ]
        for child in old_roles:
            scheme.removeChild(child)
        extension_list = next(
            (
                child
                for child in scheme.childNodes
                if child.nodeType == child.ELEMENT_NODE
                and child.namespaceURI == A_NS
                and child.localName == "extLst"
            ),
            None,
        )
        for role in COLOUR_ROLES:
            role_node = dom.createElementNS(A_NS, f"a:{role}")
            colour_node = dom.createElementNS(A_NS, "a:srgbClr")
            colour_node.setAttribute("val", theme["colors"][role])
            role_node.appendChild(colour_node)
            if extension_list is None:
                scheme.appendChild(role_node)
            else:
                scheme.insertBefore(role_node, extension_list)
        changed = True
    return changed


def _replace_theme_fonts(dom, theme: dict[str, Any]) -> bool:
    changed = False
    for scheme in dom.getElementsByTagNameNS(A_NS, "fontScheme"):
        scheme.setAttribute("name", theme["name"])
        for family in ("majorFont", "minorFont"):
            for font_set in scheme.getElementsByTagNameNS(A_NS, family):
                for script, typeface in (("latin", theme["fonts"]["latin"]), ("ea", theme["fonts"]["eastAsian"])):
                    nodes = font_set.getElementsByTagNameNS(A_NS, script)
                    if nodes:
                        nodes[0].setAttribute("typeface", typeface)
                    else:
                        node = dom.createElementNS(A_NS, f"a:{script}")
                        node.setAttribute("typeface", typeface)
                        font_set.appendChild(node)
                changed = True
    return changed


def _apply_part(dom, part: str, theme: dict[str, Any]) -> bool:
    changed = False
    if part.startswith("ppt/theme/"):
        changed = _replace_theme_scheme(dom, theme) or changed
        changed = _replace_theme_fonts(dom, theme) or changed
    for node in dom.getElementsByTagNameNS(A_NS, "srgbClr"):
        old = node.getAttribute("val").upper()
        replacement = theme["colorMap"].get(old)
        if replacement is not None and replacement != old:
            node.setAttribute("val", replacement)
            changed = True
    return changed


def _write_report(path: Path | None, report: dict[str, Any]) -> None:
    payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if path is None:
        print(payload, end="")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")
    print(json.dumps({"ok": True, "report": str(path)}, ensure_ascii=False))


def inventory_command(args: argparse.Namespace) -> None:
    _write_report(args.report, _inventory_from_archive(args.input))


def _unmapped_colours(inventory: dict[str, Any], theme: dict[str, Any]) -> list[str]:
    allowed = set(theme["colors"].values()) | set(theme["colorMap"].values())
    return sorted(
        colour for colour in inventory["explicitColors"]
        if colour not in allowed and colour not in theme["colorMap"]
    )


def apply_command(args: argparse.Namespace) -> None:
    source_inventory = _inventory_from_archive(args.input)
    theme = load_theme(args.theme)
    unmapped = _unmapped_colours(source_inventory, theme)
    if args.require_complete_color_map and unmapped:
        raise ThemeError(
            "theme.colorMap does not cover explicit colours outside the target palette: " + ", ".join(unmapped)
        )
    if args.input.resolve() == args.output.resolve():
        raise ThemeError("output must differ from input; source decks are never modified in place")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    changed_parts: list[str] = []
    removed_unreferenced_parts: list[str] = []
    try:
        with zipfile.ZipFile(args.input) as source:
            with tempfile.NamedTemporaryFile(dir=args.output.parent, suffix=".pptx", delete=False) as temporary:
                temporary_path = Path(temporary.name)
            try:
                with zipfile.ZipFile(temporary_path, "w", compression=zipfile.ZIP_DEFLATED) as output:
                    for info in source.infolist():
                        if _is_unreferenced_trash_part(info.filename):
                            removed_unreferenced_parts.append(info.filename)
                            continue
                        data = source.read(info.filename)
                        if _part_is_xml(info.filename):
                            dom = _parse_xml(data, info.filename)
                            before_text = _text_runs(dom) if info.filename.startswith("ppt/slides/") else None
                            if _apply_part(dom, info.filename, theme):
                                if before_text is not None and _text_runs(dom) != before_text:
                                    raise ThemeError(f"theme transform changed slide text in {info.filename}")
                                data = dom.toxml(encoding="utf-8")
                                changed_parts.append(info.filename)
                        output.writestr(copy.copy(info), data)
                os.replace(temporary_path, args.output)
            finally:
                if temporary_path.exists():
                    temporary_path.unlink()
    except (OSError, zipfile.BadZipFile) as exc:
        raise ThemeError(f"cannot apply theme: {exc}") from exc

    output_inventory = _inventory_from_archive(args.output)
    text_preserved = source_inventory["textBySlide"] == output_inventory["textBySlide"]
    parts_preserved = source_inventory["contentPartNames"] == output_inventory["contentPartNames"]
    slides_preserved = source_inventory["slideCount"] == output_inventory["slideCount"]
    if not text_preserved or not parts_preserved or not slides_preserved:
        args.output.unlink(missing_ok=True)
        raise ThemeError("theme transform violated the preservation contract; output was removed")
    report = {
        "schema": "pptx.unifiedThemeReceipt/v1",
        "input": str(args.input),
        "output": str(args.output),
        "theme": theme,
        "changedParts": changed_parts,
        "slideCount": output_inventory["slideCount"],
        "partCount": output_inventory["partCount"],
        "removedUnreferencedParts": removed_unreferenced_parts,
        "textPreserved": text_preserved,
        "archiveValid": True,
        "unmappedSourceColors": unmapped,
        "nextRequiredCheck": "Run scripts/office/validate.py output.pptx --original source.pptx before delivery.",
    }
    _write_report(args.report, report)


def main() -> None:
    parser = argparse.ArgumentParser(description="Inventory or safely theme an existing PPTX")
    commands = parser.add_subparsers(dest="command", required=True)
    inventory = commands.add_parser("inventory", help="write colour/font/text inventory for a PPTX")
    inventory.add_argument("input", type=Path)
    inventory.add_argument("--report", type=Path)
    inventory.set_defaults(handler=inventory_command)

    apply = commands.add_parser("apply", help="apply a declarative theme without altering slide text")
    apply.add_argument("input", type=Path)
    apply.add_argument("output", type=Path)
    apply.add_argument("--theme", type=Path, required=True, help="deck-specific declarative theme JSON")
    apply.add_argument("--report", type=Path)
    apply.add_argument("--require-complete-color-map", action="store_true")
    apply.set_defaults(handler=apply_command)

    args = parser.parse_args()
    try:
        args.handler(args)
    except ThemeError as exc:
        _fail(str(exc))


if __name__ == "__main__":
    main()
