#!/usr/bin/env python3
"""Explicitly add v2 renderer role contracts to an existing deck workspace."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from role_layout_contracts import (
    renderer_role_contracts_for_grammar,
    renderer_role_contracts_for_preset,
    validate_renderer_role_contracts_v2,
)
from taste_grammar_catalog import validate_renderer_role_systems_v1


def _load(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Unable to read {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"{path} must contain a JSON object")
    return payload


def _write_if_changed(path: Path, payload: dict[str, Any], *, dry_run: bool) -> bool:
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    if not dry_run:
        path.write_text(text, encoding="utf-8")
    return True


def _dict_at(payload: dict[str, Any], *keys: str) -> dict[str, Any]:
    current: Any = payload
    for key in keys:
        if not isinstance(current, dict):
            return {}
        current = current.get(key)
    return current if isinstance(current, dict) else {}


def _preset(design: dict[str, Any], style_contract: dict[str, Any]) -> str:
    for value in (
        _dict_at(design, "style_system").get("style_preset"),
        _dict_at(design, "visual_system").get("style_preset"),
        _dict_at(style_contract, "build").get("style_preset"),
    ):
        text = str(value or "").strip()
        if text:
            return text
    return "executive-clinical"


def _existing_v2_copies(
    design: dict[str, Any],
    style_contract: dict[str, Any],
    outline: dict[str, Any],
) -> list[tuple[str, dict[str, Any]]]:
    candidates = [
        ("design_brief.json:style_system.renderer_role_contracts_v2", _dict_at(design, "style_system", "renderer_role_contracts_v2")),
        ("style_contract.json:renderer_role_contracts_v2", _dict_at(style_contract, "renderer_role_contracts_v2")),
        ("outline.json:metadata.renderer_role_contracts_v2", _dict_at(outline, "metadata", "renderer_role_contracts_v2")),
    ]
    return [(label, value) for label, value in candidates if value]


def _derive_contracts(
    *,
    design: dict[str, Any],
    style_contract: dict[str, Any],
    outline: dict[str, Any],
) -> tuple[dict[str, Any], str]:
    existing = _existing_v2_copies(design, style_contract, outline)
    if existing:
        canonical = existing[0][1]
        failures = validate_renderer_role_contracts_v2(canonical)
        if failures:
            raise SystemExit(f"{existing[0][0]} is invalid: {'; '.join(failures)}")
        for label, payload in existing[1:]:
            failures = validate_renderer_role_contracts_v2(payload)
            if failures:
                raise SystemExit(f"{label} is invalid: {'; '.join(failures)}")
            if payload != canonical:
                raise SystemExit("Conflicting renderer_role_contracts_v2 copies; reconcile them before upgrading")
        return canonical, "existing_v2"

    v1_candidates = [
        _dict_at(design, "style_system", "renderer_role_systems_v1"),
        _dict_at(style_contract, "renderer_role_systems_v1"),
        _dict_at(outline, "metadata", "renderer_role_systems_v1"),
    ]
    valid_v1 = [payload for payload in v1_candidates if payload and not validate_renderer_role_systems_v1(payload)]
    if valid_v1:
        grammar_ids = {str(payload.get("composition_grammar_id") or "").strip() for payload in valid_v1}
        presets = {str(payload.get("style_preset") or "").strip() for payload in valid_v1}
        if len(grammar_ids) != 1 or len(presets) != 1:
            raise SystemExit("Conflicting renderer_role_systems_v1 copies; reconcile them before upgrading")
        grammar_id = next(iter(grammar_ids))
        preset = next(iter(presets))
        return renderer_role_contracts_for_grammar(grammar_id, preset=preset), "renderer_role_systems_v1"

    preset = _preset(design, style_contract)
    return renderer_role_contracts_for_preset(preset), "style_preset"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--check", action="store_true", help="Return non-zero when the workspace still needs an upgrade")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    workspace = args.workspace.expanduser().resolve()
    if not workspace.is_dir():
        raise SystemExit(f"Workspace not found: {workspace}")
    design_path = workspace / "design_brief.json"
    style_contract_path = workspace / "style_contract.json"
    outline_path = workspace / "outline.json"
    design = _load(design_path)
    style_contract = _load(style_contract_path)
    outline = _load(outline_path)
    contracts, source = _derive_contracts(
        design=design,
        style_contract=style_contract,
        outline=outline,
    )

    changed_files: list[str] = []
    style_system = design.setdefault("style_system", {})
    if not isinstance(style_system, dict):
        raise SystemExit("design_brief.json:style_system must be an object")
    if not style_system.get("renderer_role_contracts_v2"):
        style_system["renderer_role_contracts_v2"] = contracts
        if _write_if_changed(design_path, design, dry_run=args.dry_run or args.check):
            changed_files.append("design_brief.json")

    if not style_contract.get("renderer_role_contracts_v2"):
        style_contract["renderer_role_contracts_v2"] = contracts
        if _write_if_changed(style_contract_path, style_contract, dry_run=args.dry_run or args.check):
            changed_files.append("style_contract.json")

    metadata = outline.setdefault("metadata", {})
    if not isinstance(metadata, dict):
        raise SystemExit("outline.json:metadata must be an object")
    if not metadata.get("renderer_role_contracts_v2"):
        metadata["renderer_role_contracts_v2"] = contracts
        if _write_if_changed(outline_path, outline, dry_run=args.dry_run or args.check):
            changed_files.append("outline.json")

    report = {
        "schema_version": "renderer_role_contract_upgrade_v2",
        "workspace": str(workspace),
        "source": source,
        "dry_run": bool(args.dry_run or args.check),
        "upgrade_needed": bool(changed_files),
        "changed_files": changed_files,
        "contract_version": contracts.get("schema_version"),
        "composition_grammar_id": contracts.get("composition_grammar_id"),
        "style_preset": contracts.get("style_preset"),
        "workspace_version_changed": False,
    }
    report_path = args.report.expanduser().resolve() if args.report else None
    if report_path and not args.check:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    if args.check and changed_files:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
